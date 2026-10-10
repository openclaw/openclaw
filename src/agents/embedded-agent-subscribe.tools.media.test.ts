// Bounds on structured tool-result media scans and the persisted local-media
// replay authority the guarded transcript writer records for channel history.
import fs from "node:fs";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import { mergeSessionTranscriptContext } from "../channels/inbound-event/session-transcript-context.runtime.js";
import {
  extractToolResultMediaArtifact,
  recordToolResultLocalMediaReplayAuthorization,
} from "./embedded-agent-tool-media.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

describe("extractToolResultMediaArtifact candidate bounds", () => {
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
});

// Session writes retain database workers; the suite root is drained once before removal.
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-media-authority-");
let mediaAuthorityFixtureId = 0;

async function openPersistedSessionManager() {
  const root = sessionDirs.make();
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
