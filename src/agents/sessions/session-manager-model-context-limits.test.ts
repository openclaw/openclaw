import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  appendTranscriptEvent,
  upsertSessionEntryCore,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { SessionManager } from "./session-manager.js";

async function withHistory(
  label: string,
  run: (fixture: {
    scope: SessionTranscriptRuntimeTarget;
    source: SessionManager;
    verifyRead: (read: () => void | Promise<void>) => Promise<void>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: label,
      sessionKey: `agent:main:${label}`,
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const source = await SessionManager.openAsync(scope);
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

async function appendCall(source: SessionManager, id: string) {
  return expectDefined(
    await source.appendMessageAsync(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } }],
        stopReason: "toolUse",
      }),
    ),
    "Expected appended message",
  );
}

async function appendResult(source: SessionManager, id: string, text = `result ${id}`) {
  return expectDefined(
    await source.appendMessageAsync({
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 1,
    }),
    "Expected appended message",
  );
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
    await source.appendMessageAsync(makeUserMessage("Keep this question", 1));
    const appendOperator = async (content: string, kind: "prompt-update" | "runtime-context") =>
      await source.appendCustomMessageEntryAsync("openclaw.system-update", content, false, {
        kind,
        turnScoped: kind === "runtime-context",
      });
    await appendOperator("Retired instructions", "prompt-update");
    await appendOperator("Retained turn facts", "runtime-context");
    const series = {
      prefix: "Pinned stable instructions. ".repeat(100),
      hash: "retained-prefix-hash",
      renderedPrefix: "Effective stable instructions. ".repeat(100),
      routeKey: "synthetic-provider/model/api-key",
      historyId: null,
    };
    await source.appendCustomEntryAsync("openclaw.system-prompt", { ...series, restart: true });
    await appendOperator("Current instructions", "prompt-update");
    await appendOperator("Current facts", "runtime-context");
    const checkpoint = { ...series, restart: false };
    await source.appendCustomEntryAsync("openclaw.system-prompt", checkpoint);
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
        await SessionManager.openBoundedAsync(scope, limits),
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
      expect((await SessionManager.openModelContextAsync(scope)).buildSessionContext()).toEqual(
        expected,
      );
      expect(
        (await SessionManager.openModelContextAsync(scope, { limits })).buildSessionContext(),
      ).toEqual(expected);
    });
  });
});

it.each([false, true])(
  "bounds history by the event budget with retained compaction=%s",
  async (compacted) => {
    await withHistory(
      `context-sizing-limit-${compacted}`,
      async ({ scope, source, verifyRead }) => {
        const first = expectDefined(
          await source.appendMessageAsync(makeUserMessage("first retained request", 0)),
          "Expected appended message",
        );
        for (let index = 1; index < 40; index++) {
          await source.appendMessageAsync(makeUserMessage(`retained request ${index}`, index));
        }
        const boundary = compacted
          ? await source.appendCompactionAsync("required summary", first, 100)
          : undefined;
        await source.appendMessageAsync(makeUserMessage("current request", 40));
        const full = source.buildSessionContext().messages;
        await verifyRead(async () => {
          const selected = await SessionManager.openModelContextAsync(scope, {
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
      },
    );
  },
);

it("applies the aggregate byte budget before hydrating omitted message bodies", async () => {
  await withHistory("context-byte-limit", async ({ scope, source, verifyRead }) => {
    for (let index = 0; index < 8; index++) {
      await source.appendMessageAsync(
        makeUserMessage(`body-payload-${index}:` + "x".repeat(4096), index),
      );
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
    await verifyRead(async () => {
      const messages = (
        await SessionManager.openModelContextAsync(scope, {
          limits: { maxBytes: 16_384, maxEvents: 20 },
        })
      ).buildSessionContext().messages;

      expect(messages.length).toBeGreaterThan(0);
      expect(messages.length).toBeLessThan(full.length);
      expect(messages).toEqual(full.slice(-messages.length));
      expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThanOrEqual(16_384);
    });
  });
});

it("budgets projected context without hydrating large private evidence", async () => {
  await withHistory("context-projected-byte-limit", async ({ scope, source, verifyRead }) => {
    const privateText = "private-context-evidence:" + "x".repeat(32_768);
    await source.appendMessageAsync({
      ...makeUserMessage("keep the request", 1),
      __openclaw: { upstreamUserText: privateText },
    } as Parameters<SessionManager["appendMessageAsync"]>[0]);
    await appendCall(source, "read");
    await source.appendMessageAsync({
      role: "toolResult",
      toolCallId: "read",
      toolName: "read",
      content: [{ type: "text", text: "keep the result" }],
      details: { nativeEvidence: privateText },
      isError: false,
      timestamp: 2,
    });
    await verifyRead(async () => {
      const messages = (
        await SessionManager.openModelContextAsync(scope, {
          limits: { maxBytes: 4096, maxEvents: 3 },
        })
      ).buildSessionContext().messages;

      expect(messages).toMatchObject([
        { role: "user", content: "keep the request" },
        { role: "assistant", content: [{ type: "toolCall", id: "read" }] },
        { role: "toolResult", content: [{ type: "text", text: "keep the result" }] },
      ]);
      expect(JSON.stringify(messages)).not.toContain("private-context-evidence:");
      expect(
        JSON.stringify(
          await SessionManager.readSessionContextAsync(scope, (history) => Array.from(history)),
        ),
      ).toContain(privateText);
    });
  });
});

it.each(["compaction", "reset"])(
  "preserves the %s boundary and selected retained ancestry with an opaque keep marker",
  async (boundaryKind) => {
    await withHistory(`context-retained-${boundaryKind}`, async ({ scope, source, verifyRead }) => {
      await source.appendMessageAsync(makeUserMessage("obsolete", 0));
      const firstKept = expectDefined(
        await source.appendMessageAsync(makeUserMessage("older retained request", 1)),
        "Expected appended message",
      );
      await source.appendMessageAsync(makeUserMessage("newer retained request", 2));
      const callId = await appendCall(source, "retained");
      const resultId = await appendResult(source, "retained");
      await appendTranscriptEvent(scope, {
        type: "opaque-synthetic",
        id: "opaque-keep",
        parentId: firstKept,
      });
      await source.reloadPersistedTranscriptAsync();
      const boundaryId =
        boundaryKind === "compaction"
          ? await source.appendCompactionAsync("preserve this complete summary", "opaque-keep", 100)
          : await source.appendResetBoundaryAsync("new", "opaque-keep");
      const currentId = expectDefined(
        await source.appendMessageAsync(makeUserMessage("current history", 3)),
        "Expected appended message",
      );
      const full = source.buildSessionContext().messages;
      const expected =
        boundaryKind === "compaction" ? [full[0], ...full.slice(-3)] : full.slice(-3);
      await verifyRead(async () => {
        const selected = await SessionManager.openModelContextAsync(scope, {
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
      await source.appendMessageAsync(makeUserMessage(`old message ${index}`, index));
    }
    const retained = expectDefined(
      await source.appendMessageAsync(makeUserMessage("retained", 25)),
      "Expected appended message",
    );
    await source.appendCompactionAsync("summary", retained, 100);
    await source.appendMessageAsync(makeUserMessage("newest", 26));
    await verifyRead(async () => {
      const full = (await SessionManager.openModelContextAsync(scope)).buildSessionContext();
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
    await source.appendMessageAsync(
      makeAgentAssistantMessage({ model: "gpt-4.1", content: [{ type: "text", text: "earlier" }] }),
    );
    await source.appendMessageAsync(makeUserMessage("latest", 1));
    const full = source.buildSessionContext();
    await verifyRead(async () => {
      const selected = await SessionManager.openModelContextAsync(scope, {
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
      await source.appendMessageAsync(makeUserMessage("old request", 0));
      await appendCall(source, "x");
      await source.appendMessageAsync(makeUserMessage("intervening request", 1));
      await appendCall(source, "y");
      await appendResult(source, "y");
      await appendResult(source, "x");
      await source.appendMessageAsync(makeUserMessage("latest", 2));
      const full = source.buildSessionContext().messages;
      await verifyRead(async () => {
        const selected = await SessionManager.openModelContextAsync(scope, {
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
      await appendCall(source, "repeat");
      await appendResult(source, "repeat", "first occurrence");
      await appendCall(source, "repeat");
      await appendResult(source, "repeat", "second occurrence");
      await source.appendMessageAsync(makeUserMessage("latest", 2));
      const full = source.buildSessionContext().messages;
      await verifyRead(async () => {
        const selected = await SessionManager.openModelContextAsync(scope, {
          limits: { maxBytes: 16_384, maxEvents },
        });
        expect(selected.buildSessionContext().messages).toEqual(full.slice(-kept));
      });
    });
  },
);

it("rejects a cut that would give an ambiguous result a new unique owner", async () => {
  await withHistory("context-ambiguous-owner", async ({ scope, source, verifyRead }) => {
    await appendCall(source, "repeat");
    await appendCall(source, "other");
    await appendCall(source, "repeat");
    await appendCall(source, "last");
    await appendResult(source, "repeat");
    await source.appendMessageAsync(makeUserMessage("latest", 2));
    const full = source.buildSessionContext();
    await verifyRead(async () => {
      const options = { limits: { maxBytes: 16_384, maxEvents: 4 } };
      await expect(SessionManager.openModelContextAsync(scope, options)).rejects.toThrow(
        /ownership/u,
      );
      await expect(
        SessionManager.openModelContextAsync(scope, {
          limits: { ...options.limits, toolResultOverflow: "omit" },
        }),
      ).rejects.toThrow(/ownership/u);
      expect((await SessionManager.openModelContextAsync(scope)).buildSessionContext()).toEqual(
        full,
      );
    });
  });
});

it.each(["latest message", "compaction boundary", "latest tool pair", "latest tool call"])(
  "rejects an oversized %s without returning empty or stale context",
  async (kind) => {
    await withHistory(
      `context-oversized-${kind.replaceAll(" ", "-")}`,
      async ({ scope, source, verifyRead }) => {
        const first = expectDefined(
          await source.appendMessageAsync(makeUserMessage("older small request", 0)),
          "Expected appended message",
        );
        const oversized = "oversized-required-payload:" + "x".repeat(32_768);
        if (kind === "latest message") {
          await source.appendMessageAsync(makeUserMessage(oversized, 1));
        } else if (kind === "compaction boundary") {
          await source.appendCompactionAsync(oversized, first, 100);
        } else if (kind === "latest tool call") {
          await source.appendMessageAsync(
            makeAgentAssistantMessage({
              content: [{ type: "toolCall", id: "latest", name: "read", arguments: { oversized } }],
              stopReason: "toolUse",
            }),
          );
          await appendResult(source, "latest");
        } else {
          await appendCall(source, "latest");
          await appendResult(source, "latest");
        }
        await verifyRead(async () => {
          const options = {
            limits: { maxBytes: 4096, maxEvents: kind === "latest tool pair" ? 1 : 10 },
          };
          await expect(SessionManager.openModelContextAsync(scope, options)).rejects.toThrow(
            /context.*limit|limit.*context/iu,
          );
          await expect(
            SessionManager.openModelContextAsync(scope, {
              limits: { ...options.limits, toolResultOverflow: "omit" },
            }),
          ).rejects.toThrow(/context.*limit|limit.*context/iu);

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

it.each(["async"])(
  "recovers an oversized atomic tool frame only in the opted-in model view (%s)",
  async (mode) => {
    await withHistory(`context-tool-overflow-${mode}`, async ({ scope, source, verifyRead }) => {
      await source.appendMessageAsync(makeUserMessage("older request", 0));
      await source.appendMessageAsync(
        makeUserMessage("newest request: preserve both completed operations", 1),
      );
      await source.appendMessageAsync(
        makeAgentAssistantMessage({
          content: [
            { type: "toolCall", id: "large", name: "read", arguments: { path: "large.txt" } },
            { type: "toolCall", id: "small", name: "read", arguments: { path: "small.txt" } },
          ],
          stopReason: "toolUse",
        }),
      );
      const oversized = "oversized-tool-body:" + "x".repeat(32_768);
      const largeResultId = await appendResult(source, "large", oversized);
      await appendResult(source, "small", "completed operation receipt: synthetic-42");
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
      await verifyRead(async () => {
        const limits = { maxBytes: 4096, maxEvents: 8 };
        await expect(SessionManager.openModelContextAsync(scope, { limits })).rejects.toThrow(
          "The latest messages exceed this session's context limit. Start a new session with a brief summary to continue.",
        );
        const options = { limits: { ...limits, toolResultOverflow: "omit" as const } };
        const selected = await SessionManager.openModelContextAsync(scope, options);

        const messages = selected.buildSessionContext().messages;
        expect(messages.map((message) => message.role)).toEqual([
          "user",
          "assistant",
          "toolResult",
          "toolResult",
        ]);
        expect(messages[0]).toEqual(full.messages[1]);
        expect(messages[1]).toEqual(full.messages[2]);
        expect(messages[2]).toMatchObject({
          role: "toolResult",
          toolCallId: "large",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: expect.stringMatching(/omitted.*\d+ bytes/u) }],
        });
        expect(messages[3]).toEqual(full.messages[4]);
        expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThanOrEqual(limits.maxBytes);
        expect(selected.isPersisted()).toBe(false);
        expect((await SessionManager.openModelContextAsync(scope)).buildSessionContext()).toEqual(
          full,
        );
      });
    });
  },
);

it("retains a displaced repeated-ID owner when omitting an oversized result body", async () => {
  await withHistory("context-overflow-displaced", async ({ scope, source, verifyRead }) => {
    await source.appendMessageAsync(makeUserMessage("older request", 0));
    await appendCall(source, "repeat");
    await appendResult(source, "repeat", "first completed occurrence");
    await appendCall(source, "repeat");
    await source.appendMessageAsync(
      makeUserMessage("newest request while the second call is pending", 1),
    );
    await appendCall(source, "other");
    await appendResult(source, "other", "newer completed receipt");
    await appendResult(source, "repeat", "x".repeat(32_768));
    const full = source.buildSessionContext().messages;
    await verifyRead(async () => {
      const selected = (
        await SessionManager.openModelContextAsync(scope, {
          limits: { maxBytes: 4096, maxEvents: 8, toolResultOverflow: "omit" },
        })
      ).buildSessionContext().messages;
      expect(selected.slice(0, -1)).toEqual(full.slice(3, -1));
      expect(selected.at(-1)).toMatchObject({
        role: "toolResult",
        toolCallId: "repeat",
        content: [{ type: "text", text: expect.stringContaining("body omitted") }],
      });
      expect(selected[1]).toEqual(full[4]);
      expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThanOrEqual(4096);
    });
  });
});
