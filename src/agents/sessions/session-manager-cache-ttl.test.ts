import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { seedUnindexedTranscriptForTest } from "../../config/sessions/session-accessor.sqlite-import.test-support.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { serializeCacheTtlToolResultProjections } from "../embedded-agent-runner/cache-ttl-checkpoint.js";
import {
  createToolResultPromptProjectionState,
  persistToolResultProjections,
} from "../embedded-agent-runner/session-prompt-state.js";
import {
  restoreCacheTtlToolResultProjections,
  truncateOversizedToolResultsInMessages,
} from "../embedded-agent-runner/tool-result-truncation.js";
import type { AgentMessage } from "../runtime/index.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
      closeOpenClawAgentDatabasesForTest(dir);
    }
    cleanup();
  }),
);

async function createSessionScope(sessionId: string) {
  const dir = tempDirs.make("openclaw-session-cache-ttl-");
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
  return { dir, scope };
}

function tool(text: string): Extract<AgentMessage, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId: "reused",
    toolName: "read",
    content: [{ type: "text", text: `${text}:${"x".repeat(5_000)}` }],
    isError: false,
    timestamp: 42,
  };
}

async function seedProjection(sessionId: string, afterReset = false, cacheTouches = 0) {
  const { dir, scope } = await createSessionScope(sessionId);
  const source = await SessionManager.openAsync(scope, dir);
  const olderId = await source.appendMessageAsync(makeUserMessage("read files", 1));
  if (!olderId) {
    throw new Error("Missing fixture user entry");
  }
  if (afterReset) {
    await source.appendResetBoundaryAsync("new");
  }
  await source.appendMessageAsync(tool("older-one"));
  await source.appendMessageAsync(tool("older-two"));
  const state = createToolResultPromptProjectionState();
  const project = () =>
    truncateOversizedToolResultsInMessages(
      source.buildSessionContext().messages,
      128_000,
      1_000,
      20_000,
      state,
    ).messages;
  const persist = () =>
    persistToolResultProjections(state, (customType, data) =>
      source.appendCustomEntryAsync(customType, data),
    );
  project();
  await persist();
  const checkpointId = source.getLeafId()!;
  for (let index = 0; index < cacheTouches; index++) {
    await persistToolResultProjections(
      state,
      (customType, data) => source.appendCustomEntryAsync(customType, data),
      { timestamp: index, provider: "anthropic", modelId: "claude-sonnet-4-6" },
    );
  }
  const retainedId = await source.appendMessageAsync(tool("retained"));
  if (!retainedId) {
    throw new Error("Missing retained fixture tool result");
  }
  const expected = project().at(-1)!;
  await persist();
  const deltaId = source.getLeafId()!;
  return {
    dir,
    scope,
    source,
    state,
    olderId,
    checkpointId,
    retainedId,
    deltaId,
    expected,
  };
}

function restore(manager: SessionManager) {
  const state = createToolResultPromptProjectionState();
  restoreCacheTtlToolResultProjections(state, manager.getToolResultProjectionEntries());
  return state;
}

function replay(manager: SessionManager) {
  return truncateOversizedToolResultsInMessages(
    manager.buildSessionContext().messages,
    128_000,
    4_000,
    20_000,
    restore(manager),
  ).messages;
}

function projectionEntries(fixture: Awaited<ReturnType<typeof seedProjection>>) {
  const checkpoint = fixture.source.getEntry(fixture.checkpointId);
  const retained = fixture.source.getEntry(fixture.retainedId);
  const delta = fixture.source.getEntry(fixture.deltaId);
  if (
    checkpoint?.type !== "custom" ||
    retained?.type !== "message" ||
    retained.message.role !== "toolResult" ||
    delta?.type !== "custom"
  ) {
    throw new Error("Missing fixture projection entries");
  }
  return { checkpoint, retained, delta };
}

it.each(["events"] as const)(
  "preserves projected text and pre-cutoff ambiguity beyond the bounded %s window",
  async (cutoff) => {
    const fixture = await seedProjection(`projection-cutoff-${cutoff}`);
    const bounded = await SessionManager.openBoundedAsync(fixture.scope, {
      cwd: fixture.dir,
      maxEvents: 2,
      maxBytes: 64_000,
    });
    expect(bounded.getBranch().map((entry) => entry.id)).toEqual([
      fixture.retainedId,
      fixture.deltaId,
    ]);
    expect(bounded.getEntry(fixture.checkpointId)).toBeUndefined();
    expect(bounded.getToolResultProjectionEntries().map((entry) => entry.id)).toContain(
      fixture.checkpointId,
    );
    expect(replay(bounded)).toEqual([fixture.expected]);
    expect(bounded.getBranch()).toHaveLength(2);
  },
);

it("keeps the projection prefix behind the admitted-turn read fence", async () => {
  const fixture = await seedProjection("projection-fence");
  const admission = await fixture.source.appendMessageWithTranscriptAnchorAsync(
    makeUserMessage("next turn", 2),
  );
  if (!admission.anchor) {
    throw new Error("missing admission anchor");
  }
  for (const [key, replacement] of fixture.state.replacements) {
    fixture.state.replacements.set(key, {
      ...replacement,
      content: [{ type: "text", text: "later replacement outside the fence" }],
    });
  }
  const laterCheckpointId = await fixture.source.appendCustomEntryAsync(
    "openclaw.cache-ttl",
    serializeCacheTtlToolResultProjections(fixture.state),
  );
  const bounded = await runWithSessionTranscriptReadFence(
    { ...admission.anchor, logicalTurnId: "projection-fence", role: "user" },
    () =>
      SessionManager.openBoundedAsync(fixture.scope, {
        cwd: fixture.dir,
        maxEvents: 2,
        maxBytes: 64_000,
      }),
  );
  expect(bounded.getBranch().map((entry) => entry.id)).toEqual([
    fixture.retainedId,
    fixture.deltaId,
  ]);
  expect(bounded.getToolResultProjectionEntries().map((entry) => entry.id)).not.toContain(
    laterCheckpointId,
  );
  expect(replay(bounded)).toEqual([fixture.expected]);
});

it.each(["sync"] as const)("preserves checkpoint metadata in %s detached views", async (mode) => {
  const fixture = await seedProjection(`projection-detached-${mode}`);
  const options = { cwd: fixture.dir, maxEvents: 2, maxBytes: 64_000 };
  const detached = SessionManager.openDetachedBounded(fixture.scope, options);
  expect(detached.getSessionTarget()).toBeUndefined();
  expect(detached.getBranch().map((entry) => entry.id)).toEqual([
    fixture.retainedId,
    fixture.deltaId,
  ]);
  expect(replay(detached)).toEqual([fixture.expected]);
});

it.each([
  ["detached", "continue", false],
  ["detached", "summary", false],
  ["detached", "refused summary", true],
] as const)(
  "restores an opaque-only %s suffix through %s navigation (reset=%s)",
  async (mode, action, afterReset) => {
    const fixture = await seedProjection(`projection-opaque-only-${mode}-${action}`, afterReset);
    await fixture.source.appendLabelChangeAsync(fixture.olderId, "earlier message");
    const expected = serializeCacheTtlToolResultProjections(fixture.state);
    const options = { cwd: fixture.dir, maxEvents: 1, maxBytes: 64_000 };
    const manager = await SessionManager.openDetachedBoundedAsync(fixture.scope, options);
    expect(manager.buildSessionContext().messages).toEqual([]);
    expect(serializeCacheTtlToolResultProjections(restore(manager))).toEqual(expected);
    if (action === "continue") {
      const id = await manager.appendMessageAsync(makeUserMessage("continue", 3));
      if (!id) {
        throw new Error("Missing continuation fixture entry");
      }
      expect(serializeCacheTtlToolResultProjections(restore(manager))).toEqual(expected);
      await manager.branchAsync(id);
      expect(serializeCacheTtlToolResultProjections(restore(manager))).toEqual(expected);
    }
    if (action === "summary" || action === "refused summary") {
      const boundary = afterReset
        ? fixture.source.getBranch().find((entry) => entry.type === "reset")
        : undefined;
      if (afterReset && !boundary) {
        throw new Error("Missing fixture reset boundary");
      }
      if (action === "refused summary" && boundary) {
        expect(manager.getEntry(fixture.olderId)).toBeUndefined();
        await expect(
          manager.branchWithSummaryAsync(fixture.olderId, "unavailable branch"),
        ).rejects.toThrow("not found");
        expect(serializeCacheTtlToolResultProjections(restore(manager))).toEqual(expected);
        return;
      }
      if (boundary) {
        expect(manager.getEntry(boundary.id)).toMatchObject({ type: "reset", id: boundary.id });
      }
      await manager.branchWithSummaryAsync(boundary?.id ?? null, "new branch");
    } else {
      await manager.resetLeafAsync();
    }
    expect(serializeCacheTtlToolResultProjections(restore(manager))).toEqual({
      prunedToolResults: [],
      ambiguousToolResultBaseKeys: [],
      frozenToolResults: [],
    });
  },
);

it("preserves projection dependencies when a rewrite replaces the bounded anchor", async () => {
  const fixture = await seedProjection("projection-rewritten-anchor");
  const bounded = await SessionManager.openBoundedAsync(fixture.scope, {
    cwd: fixture.dir,
    maxEvents: 2,
    maxBytes: 64_000,
  });
  const rewrite = await bounded.prepareTranscriptRewriteAsync();
  const branch = rewrite.sessionManager.getBranch();
  await rewrite.sessionManager.resetLeafAsync();
  const rewrittenIds = new Map<string, string>();
  for (const entry of branch) {
    if (entry.type === "message") {
      if (entry.message.role !== "toolResult") {
        throw new Error("Unexpected non-tool message in projection rewrite fixture");
      }
      const replacementId = await rewrite.sessionManager.appendMessageAsync(entry.message);
      if (!replacementId) {
        throw new Error("Missing rewritten fixture message");
      }
      rewrittenIds.set(entry.id, replacementId);
    } else if (entry.type === "custom") {
      rewrittenIds.set(
        entry.id,
        await rewrite.sessionManager.appendCustomEntryAsync(entry.customType, entry.data),
      );
    }
  }
  await rewrite.commit(rewrittenIds);
  expect(bounded.getBranch()[0]?.id).not.toBe(fixture.retainedId);
  expect(replay(bounded)).toEqual([fixture.expected]);
  await bounded.branchAsync(fixture.deltaId);
  expect(replay(bounded)).toEqual([fixture.expected]);
});

it("recovers projection dependencies without retaining intervening cache touches", async () => {
  const fixture = await seedProjection("projection-many-touches", false, 40);
  const bounded = await SessionManager.openBoundedAsync(fixture.scope, {
    cwd: fixture.dir,
    maxEvents: 2,
    maxBytes: 64_000,
  });
  expect(bounded.getToolResultProjectionEntries().map((entry) => entry.id)).toEqual([
    fixture.checkpointId,
    fixture.retainedId,
    fixture.deltaId,
  ]);
  expect(replay(bounded)).toEqual([fixture.expected]);
  expect(
    fixture.source
      .getBranch()
      .filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "openclaw.cache-ttl" &&
          isRecord(entry.data) &&
          Object.hasOwn(entry.data, "timestamp"),
      ),
  ).toHaveLength(40);
});

it.each([{ prunedToolResults: null }])(
  "preserves an omitted malformed projection barrier %j before a retained delta",
  async (data) => {
    const fixture = await seedProjection("projection-malformed");
    const { checkpoint, retained, delta } = projectionEntries(fixture);
    const damaged = {
      type: "custom",
      id: "damaged-projection",
      parentId: checkpoint.id,
      timestamp: checkpoint.timestamp,
      customType: "openclaw.cache-ttl",
      data,
    };
    const entries = [
      fixture.source.getHeader()!,
      ...fixture.source
        .getBranch()
        .filter((entry) => entry.id !== retained.id && entry.id !== delta.id),
      damaged,
      { ...retained, parentId: damaged.id },
      delta,
    ];
    expect(replaceTranscriptEventsSync(fixture.scope, entries)).toBe(true);
    const bounded = await SessionManager.openBoundedAsync(fixture.scope, {
      cwd: fixture.dir,
      maxEvents: 2,
      maxBytes: 64_000,
    });
    expect(bounded.getBranch().map((entry) => entry.id)).toEqual([retained.id, delta.id]);
    expect(bounded.getEntry(damaged.id)).toBeUndefined();
    expect(bounded.getEntry(checkpoint.id)).toBeUndefined();
    expect(serializeCacheTtlToolResultProjections(restore(bounded))).toEqual(checkpoint.data);
  },
);

it("retires the prefix on a new branch, full hydration, reset, and retarget", async () => {
  const fixture = await seedProjection("projection-prefix-lifecycle");
  const limits = {
    cwd: fixture.dir,
    maxEvents: 2,
    maxBytes: 64_000,
  };
  const bounded = await SessionManager.openBoundedAsync(fixture.scope, limits);
  const retargeted = await SessionManager.openBoundedAsync(fixture.scope, limits);
  expect(replay(bounded)).toEqual([fixture.expected]);
  await bounded.resetLeafAsync();
  expect(bounded.getToolResultProjectionEntries()).toEqual([]);

  // The old leaf is outside the loaded window, so branching hydrates complete history.
  await bounded.branchAsync(fixture.olderId);
  expect(bounded.getToolResultProjectionEntries()).toEqual(bounded.getBranch());
  expect(restore(bounded).frozen.size).toBe(0);
  await bounded.branchAsync(fixture.deltaId);
  expect(bounded.getToolResultProjectionEntries()).toEqual(bounded.getBranch());
  expect(replay(bounded).at(-1)).toEqual(fixture.expected);
  await bounded.appendResetBoundaryAsync("reset");
  expect(restore(bounded).frozen.size).toBe(0);

  const replacement = await createSessionScope("projection-replacement");
  const replacementSource = await SessionManager.openAsync(replacement.scope, replacement.dir);
  await replacementSource.appendMessageAsync(makeUserMessage("different transcript", 3));
  await retargeted.setSessionTargetAsync(replacement.scope);
  expect(retargeted.getToolResultProjectionEntries()).toEqual(retargeted.getBranch());
  expect(restore(retargeted).frozen.size).toBe(0);
  expect(replay(retargeted)).toEqual([makeUserMessage("different transcript", 3)]);
});

it.each([{ firstType: "reset", lastType: "custom" }] as const)(
  "restores legacy duplicate kinds $firstType → $lastType",
  async ({ firstType, lastType }) => {
    const { dir, scope } = await createSessionScope(
      `projection-duplicate-${firstType}-${lastType}`,
    );
    const snapshot = (key: string) => ({
      prunedToolResults: [{ key, mode: "soft" }],
      ambiguousToolResultBaseKeys: [],
      frozenToolResults: [],
    });
    const marker = "omitted-reset-details:";
    const boundary = {
      id: "boundary",
      parentId: "before",
      type: lastType,
      customType: "openclaw.cache-ttl",
      reason: "new",
      data: snapshot("tool:after:1"),
      details: marker + "x".repeat(4_096),
    };
    await seedUnindexedTranscriptForTest({
      ...scope,
      entry: { sessionId: scope.sessionId, updatedAt: 1 },
      events: [
        JSON.stringify({ type: "session", id: scope.sessionId, version: 3, cwd: dir }),
        JSON.stringify({
          type: "custom",
          id: "before",
          parentId: null,
          customType: "openclaw.cache-ttl",
          data: snapshot("tool:before:1"),
        }),
        `{"type":"${firstType}","customType":"other","message":"opaque",${JSON.stringify(boundary).slice(1)}`,
        JSON.stringify({
          type: "message",
          id: "tail",
          parentId: "boundary",
          message: makeUserMessage("after", 2),
        }),
      ].map((event_json, seq) => ({
        session_id: scope.sessionId,
        seq,
        created_at: seq,
        event_json,
      })),
    });
    const expected = snapshot("tool:after:1");
    const full = await SessionManager.openAsync(scope, dir);
    expect(serializeCacheTtlToolResultProjections(restore(full))).toEqual(expected);
    const bounded = await SessionManager.openBoundedAsync(scope, {
      cwd: dir,
      maxEvents: 1,
      maxBytes: 1_024,
    });
    expect(serializeCacheTtlToolResultProjections(restore(bounded))).toEqual(expected);
  },
);
