import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  appendTranscriptEvent,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import { transcriptEventJsonSql } from "../../config/sessions/transcript-payload.js";
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { withSessionState } from "./session-manager-fixtures.test-support.js";
import { SessionManager } from "./session-manager.js";

async function withHistory(
  label: string,
  run: (fixture: {
    scope: SessionTranscriptRuntimeTarget;
    source: SessionManager;
    verifyRead: (read: () => void | Promise<void>) => Promise<void>;
  }) => Promise<void>,
) {
  await withSessionState(label, async ({ scope }) => {
    const source = SessionManager.open(scope);
    const database = openOpenClawAgentDatabase({ agentId: "main", path: scope.storePath });
    const snapshot = () =>
      database.db
        .prepare(`SELECT seq, event_json, event_zstd, event_utf8_bytes, navigation_json, created_at
          FROM transcript_events WHERE session_id = ? ORDER BY seq`)
        .all(scope.sessionId);
    await run({
      scope,
      source,
      verifyRead: async (read) => {
        const before = snapshot();
        try {
          await read();
        } finally {
          expect(snapshot()).toEqual(before);
        }
      },
    });
  });
}

function toolCall(id: string) {
  return { type: "toolCall" as const, id, name: "read", arguments: { path: `${id}.txt` } };
}

function appendCalls(source: SessionManager, ...ids: string[]) {
  return source.appendMessage(
    makeAgentAssistantMessage({
      content: ids.map(toolCall),
      stopReason: "toolUse",
    }),
  );
}

function appendResult(source: SessionManager, id: string, text = `result ${id}`) {
  return source.appendMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  });
}

it("returns empty context within a one-byte budget", async () => {
  await withHistory("context-empty-limit", async ({ scope, source, verifyRead }) => {
    const full = source.buildSessionContext();
    await verifyRead(async () => {
      const options = { limits: { maxBytes: 1, maxEvents: 1 } };
      const selected = await SessionManager.openModelContextAsync(scope, options);
      expect(selected.buildSessionContext()).toEqual(full);
      expect(selected.buildSessionContext().messages).toEqual([]);
    });
  });
});

it("retires prior-series operators through bounded and detached transcript reads", async () => {
  await withHistory("context-system-prompt-series", async ({ scope, source, verifyRead }) => {
    source.appendMessage(makeUserMessage("Keep this question", 1));
    const appendOperator = (content: string, kind: "prompt-update" | "runtime-context") =>
      source.appendCustomMessageEntry("openclaw.system-update", content, false, {
        kind,
        turnScoped: kind === "runtime-context",
      });
    appendOperator("Retired instructions", "prompt-update");
    appendOperator("Retained turn facts", "runtime-context");
    const series = {
      prefix: "Pinned stable instructions. ".repeat(100),
      hash: "retained-prefix-hash",
      renderedPrefix: "Effective stable instructions. ".repeat(100),
      routeKey: "synthetic-provider/model/api-key",
      historyId: null,
    };
    source.appendCustomEntry("openclaw.system-prompt", { ...series, restart: true });
    appendOperator("Current instructions", "prompt-update");
    appendOperator("Current facts", "runtime-context");
    const checkpoint = { ...series, restart: false };
    source.appendCustomEntry("openclaw.system-prompt", checkpoint);
    const expected = source.buildSessionContext();
    expect(expected.messages).toMatchObject([
      { role: "user", content: "Keep this question" },
      { role: "custom", content: "Retained turn facts" },
      { role: "custom", content: "Current instructions" },
      { role: "custom", content: "Current facts" },
    ]);
    await verifyRead(async () => {
      const limits = { maxBytes: 16_384, maxEvents: 16 };
      for (const restored of [
        SessionManager.openBounded(scope, limits),
        await SessionManager.openBoundedAsync(scope, limits),
      ]) {
        expect(restored.buildSessionContext()).toEqual(expected);
        expect(
          restored
            .getBranch()
            .findLast(
              (entry) => entry.type === "custom" && entry.customType === "openclaw.system-prompt",
            ),
        ).toMatchObject({ data: checkpoint });
      }
      expect(SessionManager.openModelContext(scope).buildSessionContext()).toEqual(expected);
      expect(
        (await SessionManager.openModelContextAsync(scope, { limits })).buildSessionContext(),
      ).toEqual(expected);
    });
  });
});

it.each([false, true])(
  "bounds selected context by the event budget with retained compaction=%s",
  async (compacted) => {
    await withHistory(`context-event-limit-${compacted}`, async ({ scope, source, verifyRead }) => {
      const first = source.appendMessage(makeUserMessage("first retained request", 0));
      for (let index = 1; index < 40; index++) {
        source.appendMessage(makeUserMessage(`retained request ${index}`, index));
      }
      const boundary = compacted
        ? source.appendCompaction("required summary", first, 100)
        : undefined;
      source.appendMessage(makeUserMessage("current request", 40));
      const full = source.buildSessionContext().messages;
      await verifyRead(() => {
        const selected = SessionManager.openModelContext(scope, {
          limits: { maxBytes: 16_384, maxEvents: 3 },
        });
        expect(selected.buildSessionContext().messages).toEqual(
          compacted ? [full[0], ...full.slice(-2)] : full.slice(-3),
        );
        if (boundary) {
          expect(selected.getBranch().find((entry) => entry.id === boundary)).toMatchObject({
            type: "compaction",
            summary: "required summary",
          });
        }
      });
    });
  },
);

it("applies the aggregate byte budget before hydrating omitted message bodies", async () => {
  await withHistory("context-byte-limit", async ({ scope, source, verifyRead }) => {
    for (let index = 0; index < 8; index++) {
      source.appendMessage(makeUserMessage(`body-payload-${index}:` + "x".repeat(4096), index));
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: scope.storePath });
    expect(
      database.db
        .prepare(
          "SELECT count(*) AS count FROM transcript_events WHERE session_id = ? AND event_zstd IS NOT NULL",
        )
        .get(scope.sessionId),
    ).toEqual({ count: 8 });
    const full = source.buildSessionContext().messages;
    await verifyRead(() => {
      const hydrated = new Set<string>();
      const decompress = vi.spyOn(resolveZstdCodec()!, "decompress");
      const parse = JSON.parse;
      const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        for (const match of text.matchAll(/body-payload-\d+:/gu)) {
          hydrated.add(match[0]);
        }
        return parse(text, reviver);
      });
      let messages: typeof full;
      try {
        messages = SessionManager.openModelContext(scope, {
          limits: { maxBytes: 16_384, maxEvents: 20 },
        }).buildSessionContext().messages;
        expect(decompress).toHaveBeenCalledTimes(messages.length);
      } finally {
        spy.mockRestore();
        decompress.mockRestore();
      }
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.length).toBeLessThan(full.length);
      expect(messages).toEqual(full.slice(-messages.length));
      expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThanOrEqual(16_384);
      expect(hydrated).toEqual(
        new Set(
          messages.flatMap((message) => {
            const content = "content" in message ? message.content : undefined;
            return typeof content === "string" ? [content.split(":")[0] + ":"] : [];
          }),
        ),
      );
    });
  });
});

it("avoids text copies of omitted message objects when SQLite supports binary JSON", async () => {
  const nativeJson = new DatabaseSync(":memory:");
  const extract = nativeJson.prepare("SELECT json_extract(?, ?) AS value");
  let supportsBinaryJson = false;
  try {
    nativeJson.prepare("SELECT jsonb_extract('{}', '$')").get();
    supportsBinaryJson = true;
  } catch {
    // The supported SQLite 3.44 line exercises the text fallback below.
  }
  try {
    await withHistory("context-navigation-copies", async ({ scope, source, verifyRead }) => {
      const marker = "omitted-message-object:";
      const omittedId = source.appendMessage(makeUserMessage(marker + "x".repeat(32_768), 1));
      source.appendMessage(makeUserMessage("latest request", 2));
      const expected = source.buildSessionContext().messages.slice(-1);
      const database = openOpenClawAgentDatabase({ agentId: "main", path: scope.storePath });
      const payload = transcriptEventJsonSql(database.db).compile(getNodeSqliteKysely(database.db));
      // Exercise native identity projection on both JSONB and SQLite 3.44.
      expect(
        database.db
          .prepare(`UPDATE transcript_events SET event_json = ${payload.sql},
            event_zstd = NULL, event_utf8_bytes = NULL, navigation_json = NULL
            WHERE session_id = ? AND seq = (
              SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?
            )`)
          .run(scope.sessionId, scope.sessionId, omittedId).changes,
      ).toBe(1);
      let messageObjectCopies = 0;
      // Preserve SQLite extraction while observing whole-message text intermediates.
      requireNativeSqliteDatabase(database.db).function(
        "json_extract",
        { deterministic: true },
        (json, jsonPath) => {
          const value = extract.get(json, jsonPath)?.value ?? null;
          if (typeof value === "string" && value.startsWith("{") && value.includes(marker)) {
            messageObjectCopies++;
          }
          return value;
        },
      );
      await verifyRead(() => {
        const context = SessionManager.openModelContext(scope, {
          limits: { maxBytes: 4096, maxEvents: 1 },
        }).buildSessionContext();
        expect(context.messages).toEqual(expected);
        if (supportsBinaryJson) {
          expect(messageObjectCopies).toBe(0);
        } else {
          expect(messageObjectCopies).toBeGreaterThan(0);
        }
      });
    });
  } finally {
    nativeJson.close();
  }
});

it("budgets projected context without hydrating large private evidence", async () => {
  await withHistory("context-projected-byte-limit", async ({ scope, source, verifyRead }) => {
    const privateText = "private-context-evidence:" + "x".repeat(32_768);
    source.appendMessage({
      ...makeUserMessage("keep the request", 1),
      __openclaw: { upstreamUserText: privateText },
    } as Parameters<SessionManager["appendMessage"]>[0]);
    appendCalls(source, "read");
    source.appendMessage({
      role: "toolResult",
      toolCallId: "read",
      toolName: "read",
      content: [{ type: "text", text: "keep the result" }],
      details: { nativeEvidence: privateText },
      isError: false,
      timestamp: 2,
    });
    await verifyRead(() => {
      const parse = JSON.parse;
      let privatePayloadReads = 0;
      const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        if (text.includes("private-context-evidence:")) {
          privatePayloadReads++;
        }
        return parse(text, reviver);
      });
      let messages: ReturnType<SessionManager["buildSessionContext"]>["messages"];
      try {
        messages = SessionManager.openModelContext(scope, {
          limits: { maxBytes: 4096, maxEvents: 3 },
        }).buildSessionContext().messages;
      } finally {
        spy.mockRestore();
      }
      expect(privatePayloadReads).toBe(0);
      expect(messages).toMatchObject([
        { role: "user", content: "keep the request" },
        { role: "assistant", content: [{ type: "toolCall", id: "read" }] },
        { role: "toolResult", content: [{ type: "text", text: "keep the result" }] },
      ]);
      expect(JSON.stringify(messages)).not.toContain("private-context-evidence:");
      expect(
        JSON.stringify(SessionManager.readSessionContext(scope, (history) => Array.from(history))),
      ).toContain(privateText);
    });
  });
});

it.each(["compaction", "reset"])(
  "preserves the %s boundary and selected retained ancestry with an opaque keep marker",
  async (boundaryKind) => {
    await withHistory(`context-retained-${boundaryKind}`, async ({ scope, source, verifyRead }) => {
      source.appendMessage(makeUserMessage("obsolete", 0));
      const firstKept = source.appendMessage(makeUserMessage("older retained request", 1));
      source.appendMessage(makeUserMessage("newer retained request", 2));
      const callId = appendCalls(source, "retained");
      const resultId = appendResult(source, "retained");
      await appendTranscriptEvent(scope, {
        type: "opaque-synthetic",
        id: "opaque-keep",
        parentId: firstKept,
      });
      source.reloadPersistedTranscript();
      const boundaryId =
        boundaryKind === "compaction"
          ? source.appendCompaction("preserve this complete summary", "opaque-keep", 100)
          : source.appendResetBoundary("new", "opaque-keep");
      const currentId = source.appendMessage(makeUserMessage("current history", 3));
      const full = source.buildSessionContext().messages;
      const expected =
        boundaryKind === "compaction" ? [full[0], ...full.slice(-3)] : full.slice(-3);
      await verifyRead(() => {
        const selected = SessionManager.openModelContext(scope, {
          limits: { maxBytes: 16_384, maxEvents: 4 },
        });
        expect(selected.buildSessionContext().messages).toEqual(expected);
        const branch = selected.getBranch();
        expect(
          branch
            .filter((entry) => entry.type === "message" || entry.type === boundaryKind)
            .map((entry) => entry.id),
        ).toEqual([callId, resultId, boundaryId, currentId]);
        expect(branch.find((entry) => entry.id === boundaryId)).toMatchObject({
          firstKeptEntryId: callId,
        });
        for (const [index, entry] of branch.entries()) {
          expect(entry.parentId).toBe(index === 0 ? null : branch[index - 1]!.id);
        }
      });
    });
  },
);

it("keeps small context unchanged and leaves compacted navigation out of the detached view", async () => {
  await withHistory("context-small-and-compacted", async ({ scope, source, verifyRead }) => {
    await source.appendThinkingLevelChange("high");
    await source.appendModelChange("openai", "gpt-4.1");
    for (let index = 0; index < 24; index++) {
      source.appendMessage(makeUserMessage(`old message ${index}`, index));
    }
    const retained = source.appendMessage(makeUserMessage("retained", 25));
    source.appendCompaction("summary", retained, 100);
    source.appendMessage(makeUserMessage("newest", 26));
    await verifyRead(async () => {
      const full = SessionManager.openModelContext(scope).buildSessionContext();
      const selected = await SessionManager.openModelContextAsync(scope, {
        limits: { maxBytes: 4096, maxEvents: 3 },
      });
      expect(selected.buildSessionContext()).toEqual(full);
      expect(selected.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
      expect(selected.getEntries().length).toBeLessThanOrEqual(5);
      expect(selected.getHeader()?.id).toBe(scope.sessionId);
    });
  });
});

it("preserves model and thinking metadata when the selecting assistant is omitted", async () => {
  await withHistory("context-state-metadata", async ({ scope, source, verifyRead }) => {
    await source.appendThinkingLevelChange("high");
    await source.appendModelChange("openai", "gpt-4o");
    source.appendMessage(
      makeAgentAssistantMessage({ model: "gpt-4.1", content: [{ type: "text", text: "earlier" }] }),
    );
    source.appendMessage(makeUserMessage("latest", 1));
    const full = source.buildSessionContext();
    await verifyRead(() => {
      const selected = SessionManager.openModelContext(scope, {
        limits: { maxBytes: 4096, maxEvents: 1 },
      });
      expect(selected.buildSessionContext()).toEqual({
        ...full,
        messages: full.messages.slice(-1),
      });
      expect(selected.getEntries().filter((entry) => entry.type === "message")).toHaveLength(1);
    });
  });
});

it.each([
  { maxEvents: 5, kept: 1 },
  { maxEvents: 6, kept: 6 },
])(
  "keeps displaced tool pairs together with a $maxEvents event budget",
  async ({ maxEvents, kept }) => {
    await withHistory(`context-displaced-${maxEvents}`, async ({ scope, source, verifyRead }) => {
      source.appendMessage(makeUserMessage("old request", 0));
      appendCalls(source, "x");
      source.appendMessage(makeUserMessage("intervening request", 1));
      appendCalls(source, "y");
      appendResult(source, "y");
      appendResult(source, "x");
      source.appendMessage(makeUserMessage("latest", 2));
      const full = source.buildSessionContext().messages;
      await verifyRead(() => {
        const selected = SessionManager.openModelContext(scope, {
          limits: { maxBytes: 16_384, maxEvents },
        });
        expect(selected.buildSessionContext().messages).toEqual(full.slice(-kept));
      });
    });
  },
);

it.each([
  { maxEvents: 2, kept: 1 },
  { maxEvents: 3, kept: 3 },
])(
  "distinguishes repeated tool-call occurrences with a $maxEvents event budget",
  async ({ maxEvents, kept }) => {
    await withHistory(`context-repeated-${maxEvents}`, async ({ scope, source, verifyRead }) => {
      appendCalls(source, "repeat");
      appendResult(source, "repeat", "first occurrence");
      appendCalls(source, "repeat");
      appendResult(source, "repeat", "second occurrence");
      source.appendMessage(makeUserMessage("latest", 2));
      const full = source.buildSessionContext().messages;
      await verifyRead(() => {
        const selected = SessionManager.openModelContext(scope, {
          limits: { maxBytes: 16_384, maxEvents },
        });
        expect(selected.buildSessionContext().messages).toEqual(full.slice(-kept));
      });
    });
  },
);

it("rejects a cut that would give an ambiguous result a new unique owner", async () => {
  await withHistory("context-ambiguous-owner", async ({ scope, source, verifyRead }) => {
    for (const id of ["repeat", "other", "repeat", "last"]) {
      appendCalls(source, id);
    }
    appendResult(source, "repeat");
    source.appendMessage(makeUserMessage("latest", 2));
    const full = source.buildSessionContext();
    await verifyRead(async () => {
      const options = { limits: { maxBytes: 16_384, maxEvents: 4 } };
      expect(() => SessionManager.openModelContext(scope, options)).toThrow(/ownership/u);
      await expect(SessionManager.openModelContextAsync(scope, options)).rejects.toThrow(
        /ownership/u,
      );
      expect(() =>
        SessionManager.openModelContext(scope, {
          limits: { ...options.limits, toolResultOverflow: "omit" },
        }),
      ).toThrow(/ownership/u);
      expect(SessionManager.openModelContext(scope).buildSessionContext()).toEqual(full);
    });
  });
});

it.each(["latest message", "compaction boundary", "latest tool pair", "latest tool call"])(
  "rejects an oversized %s without returning empty or stale context",
  async (kind) => {
    await withHistory(
      `context-oversized-${kind.replaceAll(" ", "-")}`,
      async ({ scope, source, verifyRead }) => {
        const first = source.appendMessage(makeUserMessage("older small request", 0));
        const oversized = "oversized-required-payload:" + "x".repeat(32_768);
        if (kind === "latest message") {
          source.appendMessage(makeUserMessage(oversized, 1));
        } else if (kind === "compaction boundary") {
          source.appendCompaction(oversized, first, 100);
        } else if (kind === "latest tool call") {
          source.appendMessage(
            makeAgentAssistantMessage({
              content: [{ type: "toolCall", id: "latest", name: "read", arguments: { oversized } }],
              stopReason: "toolUse",
            }),
          );
          appendResult(source, "latest");
        } else {
          appendCalls(source, "latest");
          appendResult(source, "latest");
        }
        await verifyRead(async () => {
          const options = {
            limits: { maxBytes: 4096, maxEvents: kind === "latest tool pair" ? 1 : 10 },
          };
          const parse = JSON.parse;
          let oversizedPayloadReads = 0;
          const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
            if (text.includes("oversized-required-payload:")) {
              oversizedPayloadReads++;
            }
            return parse(text, reviver);
          });
          try {
            expect(() => SessionManager.openModelContext(scope, options)).toThrow(
              /context.*limit|limit.*context/iu,
            );
            expect(() =>
              SessionManager.openModelContext(scope, {
                limits: { ...options.limits, toolResultOverflow: "omit" },
              }),
            ).toThrow(/context.*limit|limit.*context/iu);
          } finally {
            spy.mockRestore();
          }
          expect(oversizedPayloadReads).toBe(0);
          await expect(SessionManager.openModelContextAsync(scope, options)).rejects.toThrow(
            /context.*limit|limit.*context/iu,
          );
          await expect(
            SessionManager.openModelContextAsync(scope, {
              limits: { ...options.limits, toolResultOverflow: "omit" },
            }),
          ).rejects.toThrow(/context.*limit|limit.*context/iu);
        });
      },
    );
  },
);

it.each(["sync", "async"])(
  "recovers an oversized atomic tool frame only in the opted-in model view (%s)",
  async (mode) => {
    await withHistory(`context-tool-overflow-${mode}`, async ({ scope, source, verifyRead }) => {
      source.appendMessage(makeUserMessage("older request", 0));
      source.appendMessage(
        makeUserMessage("newest request: preserve both completed operations", 1),
      );
      appendCalls(source, "large", "small");
      const oversized = "oversized-tool-body:" + "x".repeat(32_768);
      const largeResultId = appendResult(source, "large", oversized);
      appendResult(source, "small", "completed operation receipt: synthetic-42");
      const database = openOpenClawAgentDatabase({ agentId: "main", path: scope.storePath });
      expect(
        database.db
          .prepare(`SELECT event.event_json, event.event_zstd IS NOT NULL AS compressed
            FROM transcript_events AS event
            JOIN transcript_event_identities AS identity
              ON identity.session_id = event.session_id AND identity.seq = event.seq
            WHERE event.session_id = ? AND identity.event_id = ?`)
          .get(scope.sessionId, largeResultId),
      ).toEqual({ event_json: null, compressed: 1 });
      const full = source.buildSessionContext();
      runOpenClawAgentWriteTransaction(
        (writeDatabase) => {
          writeDatabase.db
            .prepare(`UPDATE transcript_events
          SET navigation_type = NULL, navigation_custom_type = NULL,
              navigation_display = 0, message_role = NULL, navigation_last_type = NULL,
              navigation_last_custom_type = NULL, navigation_valid = 1
          WHERE session_id = ?`)
            .run(scope.sessionId);
        },
        { agentId: database.agentId, path: database.path },
      );
      await verifyRead(async () => {
        const limits = { maxBytes: 4096, maxEvents: 8 };
        expect(() => SessionManager.openModelContext(scope, { limits })).toThrow(
          "The latest messages exceed this session's context limit. Start a new session with a brief summary to continue.",
        );
        const options = { limits: { ...limits, toolResultOverflow: "omit" as const } };
        let oversizedPayloadReads = 0;
        const parse = JSON.parse;
        const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
          if (text.includes("oversized-tool-body:")) {
            oversizedPayloadReads++;
          }
          return parse(text, reviver);
        });
        let selected: SessionManager;
        const decompress = vi.spyOn(resolveZstdCodec()!, "decompress");
        try {
          selected =
            mode === "async"
              ? await SessionManager.openModelContextAsync(scope, options)
              : SessionManager.openModelContext(scope, options);
          if (mode === "sync") {
            // One decode to size the omission, then one to hydrate the selected result.
            expect(decompress).toHaveBeenCalledTimes(2);
          }
        } finally {
          spy.mockRestore();
          decompress.mockRestore();
        }
        const messages = selected.buildSessionContext().messages;
        expect(messages.map((message) => message.role)).toEqual([
          "user",
          "user",
          "assistant",
          "toolResult",
          "toolResult",
        ]);
        expect(messages.slice(0, 3)).toEqual(full.messages.slice(0, 3));
        expect(messages[3]).toMatchObject({
          role: "toolResult",
          toolCallId: "large",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: expect.stringMatching(/omitted.*\d+ bytes/u) }],
        });
        expect(messages[4]).toEqual(full.messages[4]);
        expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThanOrEqual(limits.maxBytes);
        expect(oversizedPayloadReads).toBe(0);
        expect(selected.isPersisted()).toBe(false);
        expect(SessionManager.openModelContext(scope).buildSessionContext()).toEqual(full);
      });
    });
  },
);

it("retains a displaced repeated-ID owner when omitting an oversized result body", async () => {
  await withHistory("context-overflow-displaced", async ({ scope, source, verifyRead }) => {
    source.appendMessage(makeUserMessage("older request", 0));
    appendCalls(source, "repeat");
    appendResult(source, "repeat", "first completed occurrence");
    appendCalls(source, "repeat");
    source.appendMessage(makeUserMessage("newest request while the second call is pending", 1));
    appendCalls(source, "other");
    appendResult(source, "other", "newer completed receipt");
    appendResult(source, "repeat", "x".repeat(32_768));
    const full = source.buildSessionContext().messages;
    await verifyRead(() => {
      const selected = SessionManager.openModelContext(scope, {
        limits: { maxBytes: 4096, maxEvents: 8, toolResultOverflow: "omit" },
      }).buildSessionContext().messages;
      expect(selected.slice(0, -1)).toEqual(full.slice(0, -1));
      expect(selected.at(-1)).toMatchObject({
        role: "toolResult",
        toolCallId: "repeat",
        content: [{ type: "text", text: expect.stringContaining("body omitted") }],
      });
      expect(selected[4]).toEqual(full[4]);
      expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThanOrEqual(4096);
    });
  });
});

it.each([
  { label: "oversized result", toolResultBodySizes: [32_768] },
  { label: "cumulative results", toolResultBodySizes: [2_000, 2_000] },
])(
  "preserves early requests under $label pressure with a nonempty recent suffix",
  async ({ label, toolResultBodySizes }) => {
    await withHistory(
      `context-history-pressure-${toolResultBodySizes.length}`,
      async ({ scope, source, verifyRead }) => {
        source.appendMessage(makeUserMessage("original goal: migrate the blue database", 0));
        source.appendMessage(
          makeUserMessage("constraint: verify the checksum before switching reads", 1),
        );
        for (const [index, bodySizeBytes] of toolResultBodySizes.entries()) {
          appendCalls(source, `pressure-${index}`);
          appendResult(
            source,
            `pressure-${index}`,
            `pressure-body-${index}:` + "x".repeat(bodySizeBytes),
          );
        }
        source.appendMessage(
          makeAgentAssistantMessage({ content: [{ type: "text", text: "recent explanation" }] }),
        );
        source.appendMessage(makeUserMessage("summarize the plan", 2));
        const contextLimits = { maxBytes: 4096, maxEvents: 20 };
        const strictContextMessages = SessionManager.openModelContext(scope, {
          limits: contextLimits,
        }).buildSessionContext().messages;
        expect(strictContextMessages.length).toBeGreaterThan(0);
        expect(JSON.stringify(strictContextMessages)).not.toContain("original goal:");
        await verifyRead(async () => {
          const hydratedBodies = new Set<string>();
          const parseJson = JSON.parse;
          const parseJsonSpy = vi
            .spyOn(JSON, "parse")
            .mockImplementation((serializedJson, reviver) => {
              for (const match of serializedJson.matchAll(/pressure-body-\d+:/gu)) {
                hydratedBodies.add(match[0]);
              }
              return parseJson(serializedJson, reviver);
            });
          let contextMessages: ReturnType<SessionManager["buildSessionContext"]>["messages"];
          try {
            contextMessages = SessionManager.openModelContext(scope, {
              limits: { ...contextLimits, toolResultOverflow: "omit" },
            }).buildSessionContext().messages;
          } finally {
            parseJsonSpy.mockRestore();
          }
          const serializedMessages = JSON.stringify(contextMessages);
          expect(serializedMessages, label).toContain("original goal: migrate the blue database");
          expect(serializedMessages).toContain(
            "constraint: verify the checksum before switching reads",
          );
          expect(serializedMessages).toContain("recent explanation");
          expect(serializedMessages).toContain("summarize the plan");
          expect(serializedMessages).toContain("body omitted");
          expect(contextMessages).toHaveLength(4 + toolResultBodySizes.length * 2);
          expect(Buffer.byteLength(serializedMessages)).toBeLessThanOrEqual(contextLimits.maxBytes);
          expect(hydratedBodies).toEqual(
            new Set(
              Array.from(serializedMessages.matchAll(/pressure-body-\d+:/gu), (match) => match[0]),
            ),
          );
          const asyncSessionManager = await SessionManager.openModelContextAsync(scope, {
            limits: { ...contextLimits, toolResultOverflow: "omit" },
          });
          expect(asyncSessionManager.buildSessionContext().messages).toEqual(contextMessages);
        });
      },
    );
  },
);

it.each([false, true])(
  "retains affordable tool bodies after dropping an oversized prefix (compacted=%s)",
  async (hasCompactionBoundary) => {
    await withHistory(
      `context-retained-results-${hasCompactionBoundary}`,
      async ({ scope, source, verifyRead }) => {
        const oversizedRequestId = source.appendMessage(
          makeUserMessage("old request:" + "x".repeat(32_768), 0),
        );
        if (hasCompactionBoundary) {
          source.appendCompaction("required summary", oversizedRequestId, 100);
        }
        source.appendMessage(makeUserMessage("verify the recent checksum", 1));
        appendCalls(source, "checksum");
        appendResult(source, "checksum", "verified checksum: synthetic-42 " + "x".repeat(1024));
        source.appendMessage(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "verification completed" }],
          }),
        );
        const contextLimits = { maxBytes: 4096, maxEvents: 20 };
        const expectedMessages = SessionManager.openModelContext(scope, {
          limits: contextLimits,
        }).buildSessionContext().messages;
        expect(JSON.stringify(expectedMessages)).toContain("verified checksum: synthetic-42");
        expect(JSON.stringify(expectedMessages)).not.toContain("old request:");
        await verifyRead(async () => {
          const options = { limits: { ...contextLimits, toolResultOverflow: "omit" as const } };
          const selected = SessionManager.openModelContext(scope, options);
          expect(selected.buildSessionContext().messages).toEqual(expectedMessages);
          const asyncSelected = await SessionManager.openModelContextAsync(scope, options);
          expect(asyncSelected.buildSessionContext().messages).toEqual(expectedMessages);
          expect(Buffer.byteLength(JSON.stringify(expectedMessages))).toBeLessThanOrEqual(
            contextLimits.maxBytes,
          );
        });
      },
    );
  },
);
