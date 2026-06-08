import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SPEAKEASY_VOICE_BUTTON_LABEL,
  SPEAKEASY_VOICE_CALLBACK_PREFIX,
  assertSpeakeasyVoiceNoteOutputPath,
  flushSpeakeasyCacheWritesForTest,
  generateSpeakeasyVoiceNote,
  loadSpeakeasyCache,
  markSpeakeasyVoiceGenerated,
  releaseSpeakeasyVoiceGenerationReservation,
  reserveSpeakeasyVoiceGeneration,
  resolveSpeakeasyCachedText,
  resolveSpeakeasyWorkspaceDir,
  setSpeakeasyVoiceStateStoreForTest,
  shouldAllowSpeakeasyVoiceGeneration,
  withSpeakeasyVoiceButton,
  writeSpeakeasyCache,
  type SpeakeasyVoiceStateRecord,
} from "./speakeasy-voice.js";

beforeEach(() => {
  resetPluginStateStoreForTests();
  setSpeakeasyVoiceStateStoreForTest(
    createPluginStateSyncKeyedStoreForTests<SpeakeasyVoiceStateRecord>("telegram", {
      namespace: "telegram.speakeasy-voice",
      maxEntries: 8_192,
    }),
  );
});

afterEach(() => {
  setSpeakeasyVoiceStateStoreForTest(undefined);
  resetPluginStateStoreForTests();
});

async function withSpeakeasyWorkspace<T>(
  fn: (params: {
    workspaceDir: string;
    cfg: { agents: { defaults: { workspace: string } } };
  }) => Promise<T>,
) {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "openclaw-speakeasy-test-"));
  const previousSpeakeasyWorkspace = process.env.OPENCLAW_SPEAKEASY_WORKSPACE_DIR;
  await mkdir(path.join(workspaceDir, "config"), { recursive: true });
  await mkdir(path.join(workspaceDir, "state"), { recursive: true });
  await writeFile(
    path.join(workspaceDir, "config", "speakeasy-chats.json"),
    JSON.stringify({ enabled: ["telegram:123"] }),
  );
  try {
    process.env.OPENCLAW_SPEAKEASY_WORKSPACE_DIR = workspaceDir;
    return await fn({
      workspaceDir,
      cfg: { agents: { defaults: { workspace: workspaceDir } } },
    });
  } finally {
    process.env.OPENCLAW_SPEAKEASY_WORKSPACE_DIR = previousSpeakeasyWorkspace;
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

describe("speakeasy voice button", () => {
  it("adds one cached callback button to eligible enabled DM text replies", async () => {
    await withSpeakeasyWorkspace(async ({ cfg, workspaceDir }) => {
      const reply = withSpeakeasyVoiceButton({
        reply: { text: "This reply is long enough to qualify for on-demand voice playback." },
        cfg,
        chatId: "123",
        isGroup: false,
      }) as {
        channelData?: { telegram?: { buttons?: Array<Array<{ callback_data: string }>> } };
      };

      expect(reply.channelData?.telegram?.buttons).toEqual([
        [
          {
            text: SPEAKEASY_VOICE_BUTTON_LABEL,
            callback_data: expect.stringMatching(/^tts:speakeasy:/),
          },
        ],
      ]);

      const callbackData = reply.channelData?.telegram?.buttons?.[0]?.[0]?.callback_data ?? "";
      await flushSpeakeasyCacheWritesForTest();
      const cache = loadSpeakeasyCache(cfg);
      expect(resolveSpeakeasyCachedText({ cfg, cache, data: callbackData, chatId: "123" })).toEqual(
        {
          ok: true,
          text: "This reply is long enough to qualify for on-demand voice playback.",
        },
      );
      expect(existsSync(path.join(workspaceDir, "state", "speakeasy-cache.json"))).toBe(false);
    });
  });

  it("keeps separate cache entries for back-to-back eligible replies", async () => {
    await withSpeakeasyWorkspace(async ({ cfg }) => {
      const first = withSpeakeasyVoiceButton({
        reply: { text: "This first reply is long enough to qualify for on-demand voice playback." },
        cfg,
        chatId: "123",
      }) as {
        channelData?: { telegram?: { buttons?: Array<Array<{ callback_data: string }>> } };
      };
      const second = withSpeakeasyVoiceButton({
        reply: {
          text: "This second reply is also long enough to qualify for on-demand voice playback.",
        },
        cfg,
        chatId: "123",
      }) as {
        channelData?: { telegram?: { buttons?: Array<Array<{ callback_data: string }>> } };
      };

      const firstCallbackData = first.channelData?.telegram?.buttons?.[0]?.[0]?.callback_data ?? "";
      const secondCallbackData =
        second.channelData?.telegram?.buttons?.[0]?.[0]?.callback_data ?? "";
      await flushSpeakeasyCacheWritesForTest();
      const cache = loadSpeakeasyCache(cfg);
      expect(
        resolveSpeakeasyCachedText({ cfg, cache, data: firstCallbackData, chatId: "123" }),
      ).toMatchObject({ ok: true, text: expect.stringContaining("first reply") });
      expect(
        resolveSpeakeasyCachedText({ cfg, cache, data: secondCallbackData, chatId: "123" }),
      ).toMatchObject({ ok: true, text: expect.stringContaining("second reply") });
    });
  });

  it("accepts Telegram-supported Speakeasy voice output paths", () => {
    expect(() => assertSpeakeasyVoiceNoteOutputPath("/tmp/speakeasy.wav")).toThrow(
      "not a Telegram voice-note file",
    );
    expect(() => assertSpeakeasyVoiceNoteOutputPath("/tmp/speakeasy.ogg")).not.toThrow();
    expect(() => assertSpeakeasyVoiceNoteOutputPath("/tmp/speakeasy.opus")).not.toThrow();
    expect(() => assertSpeakeasyVoiceNoteOutputPath("/tmp/speakeasy.mp3")).not.toThrow();
    expect(() => assertSpeakeasyVoiceNoteOutputPath("/tmp/speakeasy.m4a")).not.toThrow();
  });

  it("expands configured tilde workspace paths", async () => {
    const workspaceDir = await mkdtemp(path.join(homedir(), "openclaw-speakeasy-tilde-test-"));
    await mkdir(path.join(workspaceDir, "config"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, "config", "speakeasy-chats.json"),
      JSON.stringify({ enabled: ["telegram:123"] }),
    );
    try {
      const workspaceName = path.basename(workspaceDir);
      expect(
        resolveSpeakeasyWorkspaceDir({
          agents: { defaults: { workspace: `~/${workspaceName}` } },
        }),
      ).toBe(workspaceDir);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("honors the canonical workspace env override", async () => {
    const workspaceDir = await mkdtemp(path.join(tmpdir(), "openclaw-speakeasy-env-test-"));
    const previousWorkspace = process.env.OPENCLAW_WORKSPACE_DIR;
    await mkdir(path.join(workspaceDir, "config"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, "config", "speakeasy-chats.json"),
      JSON.stringify({ enabled: ["telegram:123"] }),
    );
    try {
      process.env.OPENCLAW_WORKSPACE_DIR = workspaceDir;
      expect(resolveSpeakeasyWorkspaceDir({})).toBe(workspaceDir);
    } finally {
      process.env.OPENCLAW_WORKSPACE_DIR = previousWorkspace;
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("resolves relative TTS output paths against the workspace", async () => {
    await withSpeakeasyWorkspace(async ({ cfg, workspaceDir }) => {
      await mkdir(path.join(workspaceDir, "scripts"), { recursive: true });
      const scriptPath = path.join(workspaceDir, "scripts", "tts_elevenlabs_v2.py");
      await writeFile(
        scriptPath,
        [
          "#!/usr/bin/env python3",
          "import sys",
          "if sys.argv[1] != 'Hello from Speakeasy':",
          "    raise SystemExit('missing text argument')",
          "print('state/speakeasy/generated/out.ogg')",
          "",
        ].join("\n"),
      );
      await chmod(scriptPath, 0o755);

      await expect(generateSpeakeasyVoiceNote({ cfg, text: "Hello from Speakeasy" })).resolves.toBe(
        path.join(workspaceDir, "state", "speakeasy", "generated", "out.ogg"),
      );
    });
  });

  it("preserves script-directory imports for the TTS helper wrapper", async () => {
    await withSpeakeasyWorkspace(async ({ cfg, workspaceDir }) => {
      await mkdir(path.join(workspaceDir, "scripts"), { recursive: true });
      await writeFile(
        path.join(workspaceDir, "scripts", "speakeasy_helper.py"),
        "def output_path():\n    return 'state/speakeasy/generated/helper.ogg'\n",
      );
      const scriptPath = path.join(workspaceDir, "scripts", "tts_elevenlabs_v2.py");
      await writeFile(
        scriptPath,
        [
          "#!/usr/bin/env python3",
          "from speakeasy_helper import output_path",
          "print(output_path())",
          "",
        ].join("\n"),
      );
      await chmod(scriptPath, 0o755);

      await expect(generateSpeakeasyVoiceNote({ cfg, text: "Hello from Speakeasy" })).resolves.toBe(
        path.join(workspaceDir, "state", "speakeasy", "generated", "helper.ogg"),
      );
    });
  });

  it("copies legacy TTS output paths into the generated audio directory", async () => {
    await withSpeakeasyWorkspace(async ({ cfg, workspaceDir }) => {
      await mkdir(path.join(workspaceDir, "scripts"), { recursive: true });
      const scriptPath = path.join(workspaceDir, "scripts", "tts_elevenlabs_v2.py");
      const legacyOutputPath = path.join(workspaceDir, "state", "speakeasy", "reusable.ogg");
      await mkdir(path.dirname(legacyOutputPath), { recursive: true });
      await writeFile(legacyOutputPath, "voice bytes");
      await writeFile(
        scriptPath,
        ["#!/usr/bin/env python3", "print('state/speakeasy/reusable.ogg')", ""].join("\n"),
      );
      await chmod(scriptPath, 0o755);

      const generatedPath = await generateSpeakeasyVoiceNote({
        cfg,
        text: "Hello from Speakeasy",
      });
      const generatedRelativePath = path.relative(
        path.join(workspaceDir, "state", "speakeasy", "generated"),
        generatedPath,
      );
      expect(generatedRelativePath).toMatch(/^[^.].+\.ogg$/);
      expect(existsSync(legacyOutputPath)).toBe(true);
    });
  });

  it("rejects instead of crashing when a fast-failing TTS helper closes stdin early", async () => {
    await withSpeakeasyWorkspace(async ({ cfg, workspaceDir }) => {
      await mkdir(path.join(workspaceDir, "scripts"), { recursive: true });
      const scriptPath = path.join(workspaceDir, "scripts", "tts_elevenlabs_v2.py");
      await writeFile(
        scriptPath,
        ["#!/usr/bin/env python3", "raise SystemExit('fast fail')", ""].join("\n"),
      );
      await chmod(scriptPath, 0o755);

      await expect(
        generateSpeakeasyVoiceNote({ cfg, text: "x".repeat(1024 * 1024) }),
      ).rejects.toThrow();
    });
  });

  it("caps noisy TTS helper stderr before reporting failures", async () => {
    await withSpeakeasyWorkspace(async ({ cfg, workspaceDir }) => {
      await mkdir(path.join(workspaceDir, "scripts"), { recursive: true });
      const scriptPath = path.join(workspaceDir, "scripts", "tts_elevenlabs_v2.py");
      await writeFile(
        scriptPath,
        [
          "#!/usr/bin/env python3",
          "import sys",
          "sys.stderr.write('x' * (1024 * 1024 + 4096))",
          "raise SystemExit(1)",
          "",
        ].join("\n"),
      );
      await chmod(scriptPath, 0o755);

      let failure: unknown;
      try {
        await generateSpeakeasyVoiceNote({ cfg, text: "Hello from Speakeasy" });
      } catch (err) {
        failure = err;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/Speakeasy TTS failed/);
      expect((failure as Error).message.length).toBeLessThan(1024 * 1024 + 1024);
    });
  });

  it("does not alter disabled, group, short, media, voice, or already-Speakeasy replies", async () => {
    await withSpeakeasyWorkspace(async ({ cfg }) => {
      const text = "This reply is long enough to qualify for on-demand voice playback.";
      expect(withSpeakeasyVoiceButton({ reply: { text }, cfg, chatId: "999" })).toEqual({
        text,
      });
      expect(
        withSpeakeasyVoiceButton({ reply: { text }, cfg, chatId: "123", isGroup: true }),
      ).toEqual({ text });
      expect(
        withSpeakeasyVoiceButton({
          reply: { text },
          cfg,
          chatId: "123",
          inlineButtonsScope: "off",
        }),
      ).toEqual({ text });
      expect(
        withSpeakeasyVoiceButton({
          reply: { text },
          cfg,
          chatId: "123",
          inlineButtonsScope: "group",
        }),
      ).toEqual({ text });
      expect(withSpeakeasyVoiceButton({ reply: { text: "short" }, cfg, chatId: "123" })).toEqual({
        text: "short",
      });
      expect(
        withSpeakeasyVoiceButton({
          reply: { text, mediaUrl: "/tmp/audio.mp3" },
          cfg,
          chatId: "123",
        }),
      ).toEqual({ text, mediaUrl: "/tmp/audio.mp3" });
      expect(
        withSpeakeasyVoiceButton({
          reply: { text, audioAsVoice: true },
          cfg,
          chatId: "123",
        }),
      ).toEqual({ text, audioAsVoice: true });
      const existingReply = {
        text,
        channelData: {
          telegram: {
            buttons: [
              [
                {
                  text: SPEAKEASY_VOICE_BUTTON_LABEL,
                  callback_data: `${SPEAKEASY_VOICE_CALLBACK_PREFIX}abc`,
                },
              ],
            ],
          },
        },
      };
      expect(withSpeakeasyVoiceButton({ reply: existingReply, cfg, chatId: "123" })).toBe(
        existingReply,
      );
      const fullKeyboard = Array.from({ length: 100 }, (_, index) => [
        { text: `Button ${index}`, callback_data: `cmd:${index}` },
      ]);
      const fullKeyboardReply = {
        text,
        channelData: { telegram: { buttons: fullKeyboard } },
      };
      expect(withSpeakeasyVoiceButton({ reply: fullKeyboardReply, cfg, chatId: "123" })).toBe(
        fullKeyboardReply,
      );
    });
  });

  it("expires stale cached callbacks and enforces the daily generation cap", async () => {
    await withSpeakeasyWorkspace(async ({ cfg }) => {
      const cache = loadSpeakeasyCache(cfg);
      cache.entries.old = {
        chatId: "123",
        text: "Expired text",
        createdAt: Date.now() - 25 * 60 * 60 * 1000,
      };

      expect(
        resolveSpeakeasyCachedText({
          cfg,
          cache,
          data: `${SPEAKEASY_VOICE_CALLBACK_PREFIX}old`,
          chatId: "123",
        }),
      ).toEqual({ ok: false, reason: "expired" });

      for (let index = 0; index < 50; index += 1) {
        markSpeakeasyVoiceGenerated({ cache, chatId: "123" });
      }
      expect(shouldAllowSpeakeasyVoiceGeneration({ cache, chatId: "123" })).toBe(false);
      expect(shouldAllowSpeakeasyVoiceGeneration({ cache, chatId: "999" })).toBe(true);
    });
  });

  it("reserves and releases generation quota in plugin state", async () => {
    await withSpeakeasyWorkspace(async ({ cfg }) => {
      const reply = withSpeakeasyVoiceButton({
        reply: { text: "This reply is long enough to qualify for on-demand voice playback." },
        cfg,
        chatId: "123",
      }) as {
        channelData?: { telegram?: { buttons?: Array<Array<{ callback_data: string }>> } };
      };
      const callbackData = reply.channelData?.telegram?.buttons?.[0]?.[0]?.callback_data ?? "";
      await flushSpeakeasyCacheWritesForTest();

      expect(reserveSpeakeasyVoiceGeneration({ cfg, data: callbackData, chatId: "123" })).toEqual({
        ok: true,
        text: "This reply is long enough to qualify for on-demand voice playback.",
      });
      let cache = loadSpeakeasyCache(cfg);
      const today = new Date().toISOString().slice(0, 10);
      expect(cache.generations[`123:${today}`]?.count).toBe(1);

      releaseSpeakeasyVoiceGenerationReservation({ cfg, chatId: "123" });
      cache = loadSpeakeasyCache(cfg);
      expect(cache.generations[`123:${today}`]).toBeUndefined();
    });
  });

  it("requires atomic plugin-state updates before reserving generation quota", async () => {
    await withSpeakeasyWorkspace(async ({ cfg }) => {
      const entries = new Map<string, SpeakeasyVoiceStateRecord>();
      setSpeakeasyVoiceStateStoreForTest({
        register: (key, value) => {
          entries.set(key, value);
        },
        registerIfAbsent: (key, value) => {
          if (entries.has(key)) {
            return false;
          }
          entries.set(key, value);
          return true;
        },
        lookup: (key) => entries.get(key),
        consume: (key) => {
          const value = entries.get(key);
          entries.delete(key);
          return value;
        },
        delete: (key) => entries.delete(key),
        entries: () =>
          Array.from(entries, ([key, value]) => ({
            key,
            value,
            createdAt: Date.now(),
          })),
        clear: () => {
          entries.clear();
        },
      });
      const reply = withSpeakeasyVoiceButton({
        reply: { text: "This reply is long enough to qualify for on-demand voice playback." },
        cfg,
        chatId: "123",
      }) as {
        channelData?: { telegram?: { buttons?: Array<Array<{ callback_data: string }>> } };
      };
      const callbackData = reply.channelData?.telegram?.buttons?.[0]?.[0]?.callback_data ?? "";

      expect(() =>
        reserveSpeakeasyVoiceGeneration({ cfg, data: callbackData, chatId: "123" }),
      ).toThrow("does not support atomic updates");
    });
  });

  it("prunes generation records from prior days", async () => {
    await withSpeakeasyWorkspace(async ({ cfg }) => {
      const cache = loadSpeakeasyCache(cfg);
      cache.generations = {
        "123:2026-01-01": { date: "2026-01-01", count: 50 },
        [`123:${new Date().toISOString().slice(0, 10)}`]: {
          date: new Date().toISOString().slice(0, 10),
          count: 1,
        },
      };
      writeSpeakeasyCache(cfg, cache);

      const reloaded = loadSpeakeasyCache(cfg);
      expect(reloaded.generations["123:2026-01-01"]).toBeUndefined();
      expect(reloaded.generations[`123:${new Date().toISOString().slice(0, 10)}`]?.count).toBe(1);
    });
  });
});
