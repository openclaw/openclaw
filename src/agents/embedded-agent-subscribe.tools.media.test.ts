// Tool media extraction tests cover structured media payloads, image fallbacks,
// trust decisions, and filtering of local/remote media URLs.
import fs from "node:fs";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import { mergeSessionTranscriptContext } from "../channels/inbound-event/session-transcript-context.runtime.js";
import { isToolResultMediaTrusted } from "./embedded-agent-subscribe.tools.test-support.js";
import {
  extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
  recordToolResultLocalMediaReplayAuthorization,
} from "./embedded-agent-tool-media.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { markCoreTtsToolResult } from "./tools/tts-tool-result-provenance.js";

describe("extractToolResultMediaArtifact", () => {
  it("returns undefined for null/undefined", () => {
    expect(extractToolResultMediaArtifact(null)).toBeUndefined();
    expect(extractToolResultMediaArtifact(undefined)).toBeUndefined();
  });

  it("returns undefined for non-object", () => {
    expect(extractToolResultMediaArtifact("hello")).toBeUndefined();
    expect(extractToolResultMediaArtifact(42)).toBeUndefined();
  });

  it("extracts structured details.media without content blocks", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          media: {
            mediaUrls: ["/tmp/img.png", "/tmp/img-2.png"],
          },
        },
      }),
    ).toEqual({
      mediaUrls: ["/tmp/img.png", "/tmp/img-2.png"],
    });
  });

  it("stops structured media collection after the accepted limit", () => {
    let inspected = 0;
    const mediaUrls = Array.from({ length: 100_000 }, (_, index) => `/tmp/${index}.png`);

    expect(
      extractToolResultMediaArtifact(
        { details: { media: { mediaUrls } } },
        {
          maxMediaUrls: 64,
          acceptMediaUrl: () => {
            inspected += 1;
            return true;
          },
        },
      )?.mediaUrls,
    ).toEqual(mediaUrls.slice(0, 64));
    expect(inspected).toBe(64);
  });

  it.each([
    {
      label: "duplicate",
      mediaUrls: Array(100_000).fill("/tmp/repeated.png"),
      acceptMediaUrl: () => true,
      expected: ["/tmp/repeated.png"],
    },
    {
      label: "rejected",
      mediaUrls: Array.from({ length: 100_000 }, (_, index) => `/tmp/rejected-${index}.png`),
      acceptMediaUrl: () => false,
      expected: [],
    },
  ])("bounds raw $label structured media candidates", ({ mediaUrls, acceptMediaUrl, expected }) => {
    let inspected = 0;
    const iterateMediaUrls = mediaUrls[Symbol.iterator].bind(mediaUrls);
    Object.defineProperty(mediaUrls, Symbol.iterator, {
      *value() {
        for (const mediaUrl of iterateMediaUrls()) {
          inspected += 1;
          yield mediaUrl;
        }
      },
    });

    expect(
      extractToolResultMediaArtifact(
        { details: { media: { mediaUrls } } },
        { acceptMediaUrl, maxMediaCandidates: 64, maxMediaUrls: 64 },
      )?.mediaUrls,
    ).toEqual(expected);
    expect(inspected).toBe(64);
  });

  it("does not deliver explicitly private image results", () => {
    expect(
      extractToolResultMediaArtifact({
        content: [{ type: "image", data: "base64data", mimeType: "image/png" }],
        details: {
          path: "/tmp/browser-screenshot.png",
          media: { outbound: false },
        },
      }),
    ).toBeUndefined();
  });

  it("extracts structured details.media top-level aliases", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          media: {
            path: " /tmp/path.png ",
            filePath: "/tmp/file.png",
            url: "https://example.test/url.png",
            fileUrl: "https://example.test/file-url.png",
            media: "/tmp/media.png",
          },
        },
      }),
    ).toEqual({
      mediaUrls: [
        "/tmp/media.png",
        "/tmp/path.png",
        "https://example.test/url.png",
        "/tmp/file.png",
        "https://example.test/file-url.png",
      ],
    });
  });

  it("extracts structured details.media attachments", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          media: {
            attachments: [
              { type: "audio", path: "/tmp/song.mp3", mimeType: "audio/mpeg" },
              { type: "image", url: "https://example.test/cover.png" },
              { type: "file", media: "/tmp/stems.zip" },
              { type: "file", fileUrl: "https://example.test/stems.zip" },
            ],
          },
        },
      }),
    ).toEqual({
      mediaUrls: [
        "/tmp/song.mp3",
        "https://example.test/cover.png",
        "/tmp/stems.zip",
        "https://example.test/stems.zip",
      ],
      attachments: [
        { type: "audio", path: "/tmp/song.mp3", mimeType: "audio/mpeg" },
        { type: "image", url: "https://example.test/cover.png" },
        { type: "file" },
        { type: "file" },
      ],
    });
  });

  it("aligns generated attachment metadata with deduplicated media references", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          media: {
            mediaUrls: [" /tmp/song.mp3 ", "/tmp/cover.png", "/tmp/song.mp3"],
            attachments: [
              {
                type: "image",
                path: "/tmp/cover.png",
                name: "cover.png",
                width: 640,
                height: 480,
              },
              {
                type: "audio",
                path: "/tmp/song.mp3",
                name: "friendly-song.mp3",
                mimeType: "audio/mpeg",
                durationMs: 2_000,
                trustedLocalMedia: true,
              },
            ],
          },
        },
      }),
    ).toEqual({
      mediaUrls: ["/tmp/song.mp3", "/tmp/cover.png"],
      attachments: [
        {
          type: "audio",
          path: "/tmp/song.mp3",
          name: "friendly-song.mp3",
          mimeType: "audio/mpeg",
          durationMs: 2_000,
        },
        {
          type: "image",
          path: "/tmp/cover.png",
          name: "cover.png",
          width: 640,
          height: 480,
        },
      ],
    });
  });

  it("drops malformed provider attachment metadata while preserving valid media references", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          media: {
            attachments: [
              {
                type: "document",
                path: "/tmp/generated.mp3",
                url: false,
                mediaUrl: {},
                filePath: 12,
                mimeType: 7,
                name: 1,
                sizeBytes: Infinity,
                durationMs: -1,
                width: "1920",
                height: Number.NaN,
                trustedLocalMedia: true,
              },
              {
                type: "audio",
                path: "/tmp/empty.mp3",
                sizeBytes: 0,
                durationMs: 0,
                width: 0,
                height: 0,
              },
            ],
          },
        },
      }),
    ).toEqual({
      mediaUrls: ["/tmp/generated.mp3", "/tmp/empty.mp3"],
      attachments: [
        { path: "/tmp/generated.mp3" },
        { type: "audio", path: "/tmp/empty.mp3", sizeBytes: 0, durationMs: 0 },
      ],
    });
  });

  it("returns undefined when content has no text or image blocks", () => {
    expect(extractToolResultMediaArtifact({ content: [{ type: "other" }] })).toBeUndefined();
  });

  it("extracts structured media with audioAsVoice", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          media: {
            mediaUrl: "/tmp/reply.opus",
            audioAsVoice: true,
          },
        },
      }),
    ).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      audioAsVoice: true,
    });
  });

  it("extracts structured media trust markers", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          media: {
            mediaUrl: "/tmp/reply.opus",
            trustedLocalMedia: true,
          },
        },
      }),
    ).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      trustedLocalMedia: true,
    });
  });

  it("ignores media-looking text content and uses details.path image fallback", () => {
    const result = {
      content: [
        { type: "text", text: "MEDIA:/tmp/screenshot.png" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
      details: { path: "/tmp/screenshot.png" },
    };
    expect(extractToolResultMediaArtifact(result)).toEqual({
      mediaUrls: ["/tmp/screenshot.png"],
    });
  });

  it("ignores media-looking text content without structured media or image fallback", () => {
    const result = {
      content: [
        { type: "text", text: "MEDIA:/tmp/page1.png" },
        { type: "text", text: "MEDIA:/tmp/page2.png" },
      ],
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("falls back to details.path when image content exists", () => {
    // Embedded read image results omit structured media but include details.path,
    // so image content is the guard that makes that path media.
    // Embedded read tool doesn't include structured media but OpenClaw
    // imageResult sets details.path as fallback.
    const result = {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
      details: { path: "/tmp/generated.png" },
    };
    expect(extractToolResultMediaArtifact(result)).toEqual({
      mediaUrls: ["/tmp/generated.png"],
    });
  });

  it("applies acceptMediaUrl to the legacy details.path fallback", () => {
    // The structured details.media path filters every candidate through acceptMediaUrl.
    // This legacy branch returned the raw path, so an untrusted tool's image reached
    // replay through the one route that skipped the caller's trust predicate.
    const result = {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
      details: { path: "/tmp/untrusted.png" },
    };
    const acceptMediaUrl = vi.fn(() => false);
    expect(extractToolResultMediaArtifact(result, { acceptMediaUrl })).toBeUndefined();
    expect(acceptMediaUrl).toHaveBeenCalledWith("/tmp/untrusted.png");
    // The same path still survives when the caller accepts it.
    expect(extractToolResultMediaArtifact(result, { acceptMediaUrl: () => true })).toEqual({
      mediaUrls: ["/tmp/untrusted.png"],
    });
  });

  it("returns undefined when image content exists but no details.path", () => {
    // Embedded read tool: has image content but no path anywhere in the result.
    const result = {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("ignores null/undefined items in content array", () => {
    const result = {
      content: [null, undefined, { type: "text", text: "MEDIA:/tmp/ok.png" }],
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("returns empty array for text-only results", () => {
    const result = {
      content: [{ type: "text", text: "Command executed successfully" }],
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("ignores details.path when no image content exists", () => {
    // Plain file paths in details are not media unless the content proves an
    // image/audio/video artifact was produced.
    // details.path without image content is not media.
    const result = {
      content: [{ type: "text", text: "File saved" }],
      details: { path: "/tmp/data.json" },
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("handles details.path with whitespace", () => {
    const result = {
      content: [{ type: "image", data: "base64", mimeType: "image/png" }],
      details: { path: "  /tmp/image.png  " },
    };
    expect(extractToolResultMediaArtifact(result)).toEqual({
      mediaUrls: ["/tmp/image.png"],
    });
  });

  it("skips empty details.path", () => {
    const result = {
      content: [{ type: "image", data: "base64", mimeType: "image/png" }],
      details: { path: "   " },
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("does not match <media:audio> placeholder as media", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "<media:audio> placeholder with successful preflight voice transcript",
        },
      ],
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("does not match <media:image> placeholder as media", () => {
    const result = {
      content: [{ type: "text", text: "<media:image> (2 images)" }],
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("does not match other media placeholder variants", () => {
    for (const tag of [
      "<media:video>",
      "<media:document>",
      "<media:sticker>",
      "<media:attachment>",
    ]) {
      const result = {
        content: [{ type: "text", text: `${tag} some context` }],
      };
      expect(extractToolResultMediaArtifact(result)).toBeUndefined();
    }
  });

  it("does not match media-looking documentation text", () => {
    const result = {
      content: [
        {
          type: "text",
          text: 'Use MEDIA: "https://example.com/voice.ogg", asVoice: true to send voice',
        },
      ],
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("does not treat malformed media-looking prose as a file path", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "MEDIA:-prefixed paths (lenient whitespace) when loading outbound media",
        },
      ],
    };
    expect(extractToolResultMediaArtifact(result)).toBeUndefined();
  });

  it("trusts image_generate local media paths", () => {
    expect(isToolResultMediaTrusted("image_generate")).toBe(true);
  });

  it("trusts music_generate local media paths", () => {
    expect(isToolResultMediaTrusted("music_generate")).toBe(true);
  });

  it("trusts video_generate local media paths", () => {
    expect(isToolResultMediaTrusted("video_generate")).toBe(true);
  });

  it("does not trust bundled plugin tool names without run-local metadata", () => {
    expect(isToolResultMediaTrusted("plugin_media_tool")).toBe(false);
  });

  it("trusts bundled plugin tool names carried by run-local metadata", () => {
    expect(
      isToolResultMediaTrusted("plugin_media_tool", undefined, new Set(["plugin_media_tool"])),
    ).toBe(true);
  });

  it("blocks trusted-media aliases that are not exact registered built-ins", () => {
    expect(
      filterToolResultMediaUrls("bash", ["/etc/passwd"], undefined, new Set(["exec"])),
    ).toStrictEqual([]);
    expect(
      filterToolResultMediaUrls("Web_Search", ["/etc/passwd"], undefined, new Set(["web_search"])),
    ).toStrictEqual([]);
  });

  it("keeps local media for exact registered built-in tool names", () => {
    expect(
      filterToolResultMediaUrls(
        "web_search",
        ["/tmp/screenshot.png"],
        undefined,
        new Set(["web_search"]),
      ),
    ).toEqual(["/tmp/screenshot.png"]);
  });

  it("keeps only attested TTS local media when the raw built-in name is absent", () => {
    const result = markCoreTtsToolResult(
      { details: { media: { mediaUrl: "/tmp/reply.opus", trustedLocalMedia: true } } },
      ["/tmp/reply.opus"],
    );
    expect(
      filterToolResultMediaUrls(
        "tts",
        ["/tmp/reply.opus", "/tmp/unattested.opus", "https://example.com/audio.opus"],
        result,
        new Set(["web_search"]),
      ),
    ).toEqual(["/tmp/reply.opus", "https://example.com/audio.opus"]);
  });

  it("keeps local media for bundled plugin tool names trusted in this run", () => {
    expect(
      filterToolResultMediaUrls(
        "plugin_media_tool",
        ["/tmp/meeting.wav"],
        undefined,
        new Set(["plugin_media_tool"]),
      ),
    ).toEqual(["/tmp/meeting.wav"]);
  });

  it("strips local media for plugin-name collisions when the plugin is not registered", () => {
    expect(
      filterToolResultMediaUrls(
        "Music_Generate",
        ["/etc/passwd"],
        undefined,
        new Set(["music_generate"]),
      ),
    ).toStrictEqual([]);
  });

  it("does not let non-TTS trustedLocalMedia bypass the exact-name gate", () => {
    expect(
      filterToolResultMediaUrls(
        "Web_Search",
        ["/etc/passwd"],
        {
          details: {
            media: {
              mediaUrl: "/etc/passwd",
              trustedLocalMedia: true,
            },
          },
        },
        new Set(["web_search"]),
      ),
    ).toStrictEqual([]);
  });

  it("still allows remote media for colliding aliases", () => {
    expect(
      filterToolResultMediaUrls(
        "bash",
        ["/etc/passwd", "https://example.com/file.png"],
        undefined,
        new Set(["exec"]),
      ),
    ).toEqual(["https://example.com/file.png"]);
  });

  it("does not trust local MEDIA paths for MCP-provenance results", () => {
    expect(
      filterToolResultMediaUrls("browser", ["/tmp/screenshot.png"], {
        details: {
          mcpServer: "probe",
          mcpTool: "browser",
        },
      }),
    ).toStrictEqual([]);
  });

  it("does not trust external TTS results with trustedLocalMedia", () => {
    expect(
      filterToolResultMediaUrls("tts", ["/tmp/reply.opus"], {
        details: {
          mcpServer: "probe",
          mcpTool: "tts",
          media: {
            mediaUrl: "/tmp/reply.opus",
            trustedLocalMedia: true,
          },
        },
      }),
    ).toStrictEqual([]);
  });

  it("still allows remote MEDIA urls for MCP-provenance results", () => {
    expect(
      filterToolResultMediaUrls("browser", ["https://example.com/screenshot.png"], {
        details: {
          mcpServer: "probe",
          mcpTool: "browser",
        },
      }),
    ).toEqual(["https://example.com/screenshot.png"]);
  });
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let mediaAuthorityFixtureId = 0;

async function openPersistedSessionManager() {
  const root = tempDirs.make("openclaw-media-authority-");
  const sessionId = `session-${mediaAuthorityFixtureId++}`;
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({ ...target, entry: { sessionId, updatedAt: Date.now() } });
  return { root, sessionManager: SessionManager.open(target, root), target };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("persisted local-media replay authority", () => {
  it("bounds and refreshes persisted media authority through channel context", async () => {
    const { root, sessionManager: sm, target } = await openPersistedSessionManager();
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    const collision = path.join(root, "media", "generated", "collision.png");
    const exact = path.join(root, "media", "generated", "exact.png");
    fs.mkdirSync(path.dirname(collision), { recursive: true });
    fs.writeFileSync(collision, "collision");
    fs.writeFileSync(exact, "exact");
    let inspected = 0;
    const probeMediaUrls = Array(100_000).fill(exact);
    const iterateProbeMediaUrls = probeMediaUrls[Symbol.iterator].bind(probeMediaUrls);
    Object.defineProperty(probeMediaUrls, Symbol.iterator, {
      *value() {
        for (const mediaUrl of iterateProbeMediaUrls()) {
          inspected += 1;
          yield mediaUrl;
        }
      },
    });
    const boundedAuthorization = recordToolResultLocalMediaReplayAuthorization(
      { details: { media: { mediaUrls: probeMediaUrls } } },
      "exec",
      new Set(["exec"]),
    );
    expect(inspected).toBe(64);
    expect(
      asNullableRecord(asNullableRecord(boundedAuthorization.details)?.media)
        ?.localMediaReplayAuthorized,
    ).toBe(true);
    const guarded = guardSessionManager(sm, {
      runId: "run-allowed",
      trustedLocalMediaToolNames: new Set(["exec"]),
    });
    const appendToolResult = (
      manager: typeof guarded,
      id: string,
      name: string,
      mediaUrls: readonly string[],
    ) => {
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id, name, arguments: {} }],
        timestamp: Date.now(),
      } as Parameters<typeof manager.appendMessage>[0]);
      manager.appendMessage({
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content: [{ type: "text", text: "done" }],
        details: { media: { mediaUrls } },
        isError: false,
        timestamp: Date.now(),
      } as Parameters<typeof manager.appendMessage>[0]);
    };
    try {
      guarded.appendMessage({
        role: "user",
        content: "inspect",
        timestamp: Date.now(),
      } as Parameters<typeof guarded.appendMessage>[0]);
      for (const [id, name, mediaUrls] of [
        ["colliding", "Bash", [collision]],
        ["exact", "exec", [exact]],
      ] as const) {
        appendToolResult(guarded, id, name, mediaUrls);
      }
      guarded.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `collision ${collision}; exact ${exact}` }],
        timestamp: Date.now(),
      } as Parameters<typeof guarded.appendMessage>[0]);

      const deniedRun = guardSessionManager(sm, {
        runId: "run-denied",
        trustedLocalMediaToolNames: new Set(),
      });
      deniedRun.appendMessage({
        role: "user",
        content: "recheck",
        timestamp: Date.now(),
      } as Parameters<typeof deniedRun.appendMessage>[0]);
      appendToolResult(deniedRun, "stale", "exec", [exact]);
      deniedRun.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `stale ${exact}` }],
        timestamp: Date.now(),
      } as Parameters<typeof deniedRun.appendMessage>[0]);

      const restoredRun = guardSessionManager(sm, {
        runId: "run-restored",
        trustedLocalMediaToolNames: new Set(["exec"]),
      });
      restoredRun.appendMessage({
        role: "user",
        content: "restore",
        timestamp: Date.now(),
      } as Parameters<typeof restoredRun.appendMessage>[0]);
      appendToolResult(restoredRun, "restored", "exec", [exact]);
      restoredRun.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `restored ${exact}` }],
        timestamp: Date.now(),
      } as Parameters<typeof restoredRun.appendMessage>[0]);

      const authorizations = sm.getEntries().flatMap((entry) => {
        if (entry.type !== "message" || entry.message.role !== "toolResult") {
          return [];
        }
        return [
          asNullableRecord(asNullableRecord(entry.message.details)?.media)
            ?.localMediaReplayAuthorized,
        ];
      });
      expect(deniedRun).toBe(guarded);
      expect(restoredRun).toBe(guarded);
      expect(authorizations).toEqual([false, true, false, true]);

      const ctx = {
        Body: "continue",
        RawBody: "continue",
        CommandBody: "continue",
        SessionTranscriptContext: { historyLimit: 10 },
      } as FinalizedMsgContext;
      await mergeSessionTranscriptContext({
        agentId: target.agentId,
        ctx,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
      });
      expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual([
        "inspect",
        `collision [unverified media reference removed]/generated/collision.png; exact ${exact}`,
        "recheck",
        `stale [unverified media reference removed]/generated/exact.png`,
        "restore",
        `restored ${exact}`,
      ]);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("denies media authority until the run hands over its trust set", async () => {
    const { sessionManager: sm } = await openPersistedSessionManager();
    const appendExecResult = (manager: typeof sm, id: string) => {
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id, name: "exec", arguments: {} }],
        timestamp: Date.now(),
      } as Parameters<typeof manager.appendMessage>[0]);
      manager.appendMessage({
        role: "toolResult",
        toolCallId: id,
        toolName: "exec",
        content: [{ type: "text", text: "done" }],
        details: { media: { mediaUrls: [`/state/media/${id}.png`] } },
        isError: false,
        timestamp: Date.now(),
      } as Parameters<typeof manager.appendMessage>[0]);
    };
    const guarded = guardSessionManager(sm, {
      runId: "run-first",
      trustedLocalMediaToolNames: new Set(),
    });
    appendExecResult(guarded, "before-handoff");
    guarded.setTrustedLocalMediaToolNames?.(new Set(["exec"]));
    appendExecResult(guarded, "after-handoff");
    // A same-run helper such as compaction reuses the manager without a set.
    expect(guardSessionManager(sm, { runId: "run-first" })).toBe(guarded);
    appendExecResult(guarded, "same-run-reuse");
    expect(
      guardSessionManager(sm, { runId: "run-second", trustedLocalMediaToolNames: new Set() }),
    ).toBe(guarded);
    appendExecResult(guarded, "next-run");

    const authorizations = sm.getEntries().flatMap((entry) => {
      if (entry.type !== "message" || entry.message.role !== "toolResult") {
        return [];
      }
      return [
        [
          entry.message.toolCallId,
          asNullableRecord(asNullableRecord(entry.message.details)?.media)
            ?.localMediaReplayAuthorized,
        ],
      ];
    });
    expect(authorizations).toEqual([
      ["before-handoff", false],
      ["after-handoff", true],
      ["same-run-reuse", true],
      ["next-run", false],
    ]);
  });

  it("grounds media-store URIs through channel context", async () => {
    const { root, sessionManager: sm, target } = await openPersistedSessionManager();
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    const inbound = path.join(root, "media", "inbound");
    fs.mkdirSync(inbound, { recursive: true });
    fs.writeFileSync(path.join(inbound, "granted.png"), "granted");
    fs.writeFileSync(path.join(inbound, "forged.png"), "forged");
    const guarded = guardSessionManager(sm, {
      runId: "run-media-uri",
      trustedLocalMediaToolNames: new Set(["exec"]),
    });
    try {
      for (const message of [
        { role: "user", content: "inspect", timestamp: Date.now() },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "granted", name: "exec", arguments: {} }],
          timestamp: Date.now(),
        },
        {
          role: "toolResult",
          toolCallId: "granted",
          toolName: "exec",
          content: [{ type: "text", text: "done" }],
          details: { media: { mediaUrls: ["media://inbound/granted.png"] } },
          isError: false,
          timestamp: Date.now(),
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "granted media://inbound/granted.png; forged media://inbound/forged.png; shouted MEDIA://inbound/forged.png",
            },
          ],
          timestamp: Date.now(),
        },
      ]) {
        guarded.appendMessage(message as Parameters<typeof guarded.appendMessage>[0]);
      }
      const ctx = {
        Body: "continue",
        RawBody: "continue",
        CommandBody: "continue",
        SessionTranscriptContext: { historyLimit: 10 },
      } as FinalizedMsgContext;
      await mergeSessionTranscriptContext({
        agentId: target.agentId,
        ctx,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
      });
      expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual([
        "inspect",
        "granted media://inbound/granted.png; forged [unverified media reference removed]/forged.png; shouted [unverified media reference removed]/forged.png",
      ]);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });
});
