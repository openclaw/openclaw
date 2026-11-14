import fs from "node:fs/promises";
import path from "node:path";
import type { Message, Update } from "grammy/types";
import type * as MediaRuntime from "openclaw/plugin-sdk/media-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { makeDirectTelegramConfig } from "./bot.config.test-support.js";
import {
  commandMessage,
  createBot,
  deliverTelegramUpdate,
  groupChat,
  harness,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";

afterEach(() => vi.unstubAllEnvs());

it.skipIf(process.platform === "win32")(
  "shares auto-local voice computation without sharing account mention admission",
  async () => {
    const dir = harness.state.path("shared-audio");
    const inbound = harness.state.statePath("media", "inbound");
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(inbound, { recursive: true });
    const calls = path.join(dir, "calls.txt");
    const model = path.join(dir, "model.bin");
    const command = path.join(dir, "whisper-cli");
    await fs.writeFile(model, "fixture model");
    await fs.writeFile(
      command,
      "#!" +
        process.execPath +
        "\n" +
        'const fs = require("node:fs"); const args = process.argv.slice(2);' +
        "fs.appendFileSync(" +
        JSON.stringify(calls) +
        ', "transcribed" + String.fromCharCode(10));' +
        "if (fs.readFileSync(args.at(-1)).length < 100) process.exit(2);" +
        'fs.writeFileSync(args[args.indexOf("-of") + 1] + ".txt", "@Alice @Bob please respond");',
      { mode: 0o700 },
    );
    const downloads = await Promise.all(
      ["alice", "bob", "dave"].map(async (name) => {
        const audioPath = path.join(inbound, name + ".wav");
        await fs.writeFile(audioPath, Buffer.alloc(2048, 0xab));
        return { id: name, path: audioPath, size: 2048, contentType: "audio/wav" };
      }),
    );
    let download = 0;
    harness.saveRemoteMedia.mockImplementation(async () => {
      const saved = downloads[download++];
      if (!saved) {
        throw new Error("Unexpected additional media download");
      }
      return saved;
    });
    const actual = await vi.importActual<typeof MediaRuntime>("openclaw/plugin-sdk/media-runtime");
    harness.transcribeFirstAudio.mockImplementation(actual.transcribeFirstAudio);
    vi.stubEnv("PATH", dir + path.delimiter + (process.env.PATH ?? ""));
    vi.stubEnv("WHISPER_CPP_MODEL", model);
    vi.stubEnv("SHERPA_ONNX_MODEL_DIR", undefined);

    const cfg = makeDirectTelegramConfig(path.join(dir, "sessions.json"), {
      groupPolicy: "open",
      autoTopicLabel: false,
      streaming: { mode: "off" },
      accounts: {
        alice: {},
        bob: {},
        dave: {},
        carol: { groups: { "*": { requireMention: true, allowFrom: ["999"] } } },
      },
      groups: { "*": { requireMention: true } },
    });
    cfg.commands = { native: false };
    cfg.agents = {
      entries: {
        main: {},
        alice: { identity: { name: "Alice" } },
        bob: { identity: { name: "Bob" } },
        carol: { identity: { name: "Carol" } },
        dave: { identity: { name: "Dave" } },
      },
    };
    cfg.bindings = [
      { agentId: "alice", match: { channel: "telegram", accountId: "alice" } },
      { agentId: "bob", match: { channel: "telegram", accountId: "bob" } },
      { agentId: "carol", match: { channel: "telegram", accountId: "carol" } },
      { agentId: "dave", match: { channel: "telegram", accountId: "dave" } },
    ];
    cfg.tools = { media: { audio: { enabled: true, echoTranscript: false } } };
    const alice = await createBot(false, true, cfg, false, "alice");
    const bob = await createBot(false, true, cfg, false, "bob");
    const carol = await createBot(false, true, cfg, false, "carol");
    const dave = await createBot(false, true, cfg, false, "dave");
    const { text: _text, entities: _entities, ...message } = commandMessage("");
    const voice = {
      ...message,
      chat: groupChat,
      message_id: 9001,
      message_thread_id: 99,
      is_topic_message: true,
      voice: {
        file_id: "voice",
        file_unique_id: "one-shared-voice",
        duration: 1,
        mime_type: "audio/wav",
      },
    } satisfies Message.VoiceMessage & Update.NonChannel;
    await Promise.all([
      deliverTelegramUpdate(alice, { update_id: 9001, message: voice }),
      deliverTelegramUpdate(bob, { update_id: 9002, message: voice }),
      deliverTelegramUpdate(carol, { update_id: 9003, message: voice }),
      deliverTelegramUpdate(dave, { update_id: 9004, message: voice }),
    ]);
    expect(harness.transcribeFirstAudio).toHaveBeenCalledTimes(3);
    expect(
      harness.transcribeFirstAudio.mock.calls
        .map(([request]) => request.ctx.AccountId)
        .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual(["alice", "bob", "dave"]);
    expect(await fs.readFile(calls, "utf8")).toBe("transcribed\n");
    expect(harness.replySpy).toHaveBeenCalledTimes(2);
    expect(
      harness.replySpy.mock.calls
        .map(([ctx]) => ctx.AccountId)
        .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual(["alice", "bob"]);
    for (const [ctx] of harness.replySpy.mock.calls) {
      expect(ctx.BodyForAgent).toContain("@Alice @Bob please respond");
      expect(ctx.media?.some((fact) => fact.transcribed)).toBe(true);
    }
  },
);
