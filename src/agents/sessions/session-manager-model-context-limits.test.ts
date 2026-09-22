import { createHash } from "node:crypto";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
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
    const source = SessionManager.open(scope);
    const database = openOpenClawAgentDatabase({ agentId: "main", path: scope.storePath });
    const fingerprint = () => {
      const hash = createHash("sha256");
      for (const row of database.db
        .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .iterate(scope.sessionId)) {
        hash.update(String(row.event_json));
      }
      return hash.digest("hex");
    };
    await run({
      scope,
      source,
      verifyRead: async (read) => {
        const before = fingerprint();
        try {
          await read();
        } finally {
          expect(fingerprint()).toBe(before);
        }
      },
    });
  });
}

function appendCall(source: SessionManager, id: string) {
  return source.appendMessage(
    makeAgentAssistantMessage({
      content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } }],
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

it.each(["sync", "async"])("returns empty context within a one-byte budget (%s)", async (mode) => {
  await withHistory(`context-empty-limit-${mode}`, async ({ scope, source, verifyRead }) => {
    const full = source.buildSessionContext();
    await verifyRead(async () => {
      const options = { limits: { maxBytes: 1, maxEvents: 1 } };
      const selected =
        mode === "async"
          ? await SessionManager.openModelContextAsync(scope, options)
          : SessionManager.openModelContext(scope, options);
      expect(selected.buildSessionContext()).toEqual(full);
      expect(selected.buildSessionContext().messages).toEqual([]);
    });
  });
});

it.each(["sync", "async"])("bounds the prepared message tail by event count (%s)", async (mode) => {
  await withHistory(`context-event-limit-${mode}`, async ({ scope, source, verifyRead }) => {
    for (let index = 0; index < 8; index++) {
      source.appendMessage(makeUserMessage(`message ${index}`, index));
    }
    const full = source.buildSessionContext();
    await verifyRead(async () => {
      const options = { limits: { maxBytes: 16_384, maxEvents: 3 } };
      const selected =
        mode === "async"
          ? await SessionManager.openModelContextAsync(scope, options)
          : SessionManager.openModelContext(scope, options);
      expect(selected.buildSessionContext()).toEqual({
        ...full,
        messages: full.messages.slice(-3),
      });
      expect(selected.isPersisted()).toBe(false);
      expect(SessionManager.openModelContext(scope).buildSessionContext()).toEqual(full);
    });
  });
});

it.each([false, true])(
  "bounds payload sizing by the event budget with retained compaction=%s",
  async (compacted) => {
    await withHistory(
      `context-sizing-limit-${compacted}`,
      async ({ scope, source, verifyRead }) => {
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
          const database = openOpenClawAgentDatabase({ agentId: "main", path: scope.storePath });
          const reads = trackSqliteStatementExecutions(database.db, ["sizes"], (query) =>
            query.includes("octet_length(") && query.includes('as "bytes"') ? "sizes" : null,
          );
          try {
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
            expect(reads.rowCounts.sizes).toBeGreaterThan(0);
            expect(reads.rowCounts.sizes).toBeLessThanOrEqual(compacted ? 4 : 3);
          } finally {
            reads.restore();
          }
        });
      },
    );
  },
);

it("applies the aggregate byte budget before hydrating omitted message bodies", async () => {
  await withHistory("context-byte-limit", async ({ scope, source, verifyRead }) => {
    for (let index = 0; index < 8; index++) {
      source.appendMessage(makeUserMessage(`body-payload-${index}:` + "x".repeat(1024), index));
    }
    const full = source.buildSessionContext().messages;
    await verifyRead(() => {
      const hydrated = new Set<string>();
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
          limits: { maxBytes: 4096, maxEvents: 20 },
        }).buildSessionContext().messages;
      } finally {
        spy.mockRestore();
      }
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.length).toBeLessThan(full.length);
      expect(messages).toEqual(full.slice(-messages.length));
      expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThanOrEqual(4096);
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

it("budgets projected context without hydrating large private evidence", async () => {
  await withHistory("context-projected-byte-limit", async ({ scope, source, verifyRead }) => {
    const privateText = "private-context-evidence:" + "x".repeat(32_768);
    source.appendMessage({
      ...makeUserMessage("keep the request", 1),
      __openclaw: { upstreamUserText: privateText },
    } as Parameters<SessionManager["appendMessage"]>[0]);
    appendCall(source, "read");
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

it.each([
  { boundaryKind: "compaction", keepMarker: "canonical" },
  { boundaryKind: "compaction", keepMarker: "opaque" },
  { boundaryKind: "reset", keepMarker: "canonical" },
  { boundaryKind: "reset", keepMarker: "opaque" },
])(
  "preserves the $boundaryKind boundary and selected retained ancestry with a $keepMarker keep marker",
  async ({ boundaryKind, keepMarker }) => {
    await withHistory(
      `context-retained-${boundaryKind}-${keepMarker}`,
      async ({ scope, source, verifyRead }) => {
        source.appendMessage(makeUserMessage("obsolete", 0));
        const firstKept = source.appendMessage(makeUserMessage("older retained request", 1));
        source.appendMessage(makeUserMessage("newer retained request", 2));
        const callId = appendCall(source, "retained");
        const resultId = appendResult(source, "retained");
        let keepEntryId = firstKept;
        if (keepMarker === "opaque") {
          await appendTranscriptEvent(scope, {
            type: "opaque-synthetic",
            id: "opaque-keep",
            parentId: firstKept,
          });
          source.reloadPersistedTranscript();
          keepEntryId = "opaque-keep";
        }
        const boundaryId =
          boundaryKind === "compaction"
            ? source.appendCompaction("preserve this complete summary", keepEntryId, 100)
            : source.appendResetBoundary("new", keepEntryId);
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
      },
    );
  },
);

it("keeps small context unchanged and leaves compacted navigation out of the detached view", async () => {
  await withHistory("context-small-and-compacted", async ({ scope, source, verifyRead }) => {
    source.appendThinkingLevelChange("high");
    source.appendModelChange("openai", "gpt-4.1");
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
    source.appendThinkingLevelChange("high");
    source.appendModelChange("openai", "gpt-4o");
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
      appendCall(source, "x");
      source.appendMessage(makeUserMessage("intervening request", 1));
      appendCall(source, "y");
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
      appendCall(source, "repeat");
      appendResult(source, "repeat", "first occurrence");
      appendCall(source, "repeat");
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
    appendCall(source, "repeat");
    appendCall(source, "other");
    appendCall(source, "repeat");
    appendCall(source, "last");
    appendResult(source, "repeat");
    source.appendMessage(makeUserMessage("latest", 2));
    const full = source.buildSessionContext();
    await verifyRead(async () => {
      const options = { limits: { maxBytes: 16_384, maxEvents: 4 } };
      expect(() => SessionManager.openModelContext(scope, options)).toThrow(/ownership/u);
      await expect(SessionManager.openModelContextAsync(scope, options)).rejects.toThrow(
        /ownership/u,
      );
      expect(SessionManager.openModelContext(scope).buildSessionContext()).toEqual(full);
    });
  });
});

it.each(["latest message", "compaction boundary", "latest tool pair"])(
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
        } else {
          appendCall(source, "latest");
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
          } finally {
            spy.mockRestore();
          }
          expect(oversizedPayloadReads).toBe(0);
          await expect(SessionManager.openModelContextAsync(scope, options)).rejects.toThrow(
            /context.*limit|limit.*context/iu,
          );
        });
      },
    );
  },
);
