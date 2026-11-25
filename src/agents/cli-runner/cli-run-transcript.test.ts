import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, expect, it, onTestFinished } from "vitest";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { settlePreparedAssistantTranscriptMetadataAtAnchor } from "../../config/sessions/session-message-rewrite.js";
import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sanitizeChatHistoryMessages } from "../../gateway/chat-display-projection.sanitize.js";
import { createAgentEventTestHarness } from "../../gateway/server-chat.agent-events.test-harness.js";
import { onAgentRuntimeEvent } from "../../infra/agent-events.js";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookBeforeMessageWriteEvent } from "../../plugins/hook-types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  onInternalSessionTranscriptUpdate,
  readSessionTranscriptRunId,
  type InternalSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { transformCliResultText } from "../cli-output-results.js";
import {
  claudeMessageStart,
  claudeTextDelta,
  createClaudeParser,
  joinJsonlFrames,
} from "../cli-output.test-helpers.js";
import { isIntermediateAssistantTranscriptMessage } from "../embedded-agent-runner/message-visibility.js";
import {
  createCliAssistantSegmentQueue,
  persistCliAssistantSegment,
  type CliPersistedSegment,
  cliUnpersistedAssistantTail,
  persistCliAssistantSettlement,
} from "./cli-assistant-settlement.js";
import {
  buildCliAssistantTranscriptUsage,
  persistCliAssistantTranscript,
} from "./cli-run-transcript.js";
import { createCliEventHandlers } from "./execute-events.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";
import { buildPreparedContext } from "./prepared-context.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cli-coordination-transcript-");
afterEach(() => resetGlobalHookRunner());

function sourcePricing(provider: string, id: string, cost: Record<string, unknown>) {
  return {
    models: {
      providers: { [provider]: { baseUrl: "https://cli.invalid", models: [{ id, cost }] } },
    },
  } as unknown as OpenClawConfig;
}

async function transcriptFixture(name: string) {
  const sessionId = `cli-${name}-session`;
  const sessionKey = `agent:main:cli-${name}`;
  const root = sessionDirs.make();
  const target = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({ ...target, entry: { sessionId, updatedAt: Date.now() } });
  const runParams = {
    ...target,
    provider: "claude-cli",
    runId: `cli-${name}-run`,
    config: {},
    sessionFile: `sqlite://agents/main/${sessionId}`,
    workspaceDir: root,
    prompt: "hi",
    timeoutMs: 1_000,
    persistAssistantTranscript: true,
  };
  const updates: InternalSessionTranscriptUpdate[] = [];
  onTestFinished(onInternalSessionTranscriptUpdate((update) => updates.push(update)));
  return {
    target,
    runParams,
    updates,
    persist: (overrides: Partial<Parameters<typeof persistCliAssistantTranscript>[0]>) =>
      persistCliAssistantTranscript({
        runParams,
        text: "reply",
        modelId: "claude-sonnet-4-6",
        stopReason: "stop",
        ...overrides,
      }),
  };
}

async function transcriptMessages(target: Parameters<typeof loadTranscriptEvents>[0]) {
  return (await loadTranscriptEvents(target)).flatMap((event) =>
    isRecord(event) && isRecord(event.message) ? [event.message] : [],
  );
}
async function transcriptContents(target: Parameters<typeof loadTranscriptEvents>[0]) {
  return (await transcriptMessages(target)).map((message) => message.content);
}
function nativeTool() {
  return {
    type: "assistant",
    uuid: "tool",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "tool", name: "Read", input: {} }],
    },
  };
}

function snapshot(uuid: string, text: string, stop_reason: string | null = null, id = uuid) {
  return {
    type: "assistant",
    uuid,
    message: {
      id,
      role: "assistant",
      stop_reason,
      content: [{ type: "text", text }],
    },
  };
}

it.each([
  { sourceTool: "sessions_send", hidden: true },
  { sourceTool: "subagent_announce", hidden: false },
  { sourceTool: "subagent_announce", privateCompletion: true as const, hidden: true },
  { sourceTool: "subagent_settle", privateCompletion: true as const, hidden: true },
])(
  "preserves CLI $sourceTool output with its display policy after hooks (private=$privateCompletion)",
  async ({ sourceTool, hidden, privateCompletion }) => {
    const { target, runParams, persist, updates } = await transcriptFixture("coordination");
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: "rewrite-output",
      hookName: "before_message_write",
      source: "test",
      handler: ({ message }: PluginHookBeforeMessageWriteEvent) => ({
        message: { ...message, display: true },
      }),
    });
    initializeGlobalHookRunner(registry);
    const text = "The worker result passed validation";
    const result = await persist({
      runParams: {
        ...runParams,
        privateCompletion,
        inputProvenance: { kind: "inter_session", sourceTool, sourceRole: "subagent" },
      },
      text,
    });
    expect(result.owned).toBe(true);
    const messages = await transcriptMessages(target);
    expect(messages).toMatchObject([{ role: "assistant", content: [{ type: "text", text }] }]);
    expect(Reflect.get(messages[0]!, "display") === false).toBe(hidden);
    expect(updates).toHaveLength(1);
    expect(Reflect.get(updates[0]!.message!, "display") === false).toBe(hidden);
    expect(readSessionTranscriptRunId(updates[0]!.message)).toBe("cli-coordination-run");
  },
);

it.each([false, true])("persists CLI usage with separate turn total=%s", async (turnTotal) => {
  const { target, runParams, persist } = await transcriptFixture("usage");
  const rates = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
  const pricedRunParams = {
    ...runParams,
    provider: turnTotal ? "claude-cli" : "codex-cli",
    // The synthetic model has no vendor catalog price: the other turn stays unpriced, never $0.
    config: sourcePricing("claude-cli", "claude-opus-4-8", rates),
  };
  const modelId = turnTotal ? "claude-opus-4-8" : "unpriced-cli-test-model";
  const cacheUsage = { input: 4418, output: 5, cacheWrite: 36955, cacheWrite1h: 36955 };
  const priced = await buildCliAssistantTranscriptUsage({
    runParams: pricedRunParams,
    modelId,
    usage: turnTotal ? cacheUsage : { input: 10, output: 5, cacheRead: 100 },
    ...(turnTotal ? { turnUsage: { ...cacheUsage, output: 534 } } : {}),
  });
  await persist({ runParams: pricedRunParams, modelId, usage: priced.usage });
  const messages = await transcriptMessages(target);
  expect(messages).toHaveLength(1);
  // One-hour cache writes bill at twice the input rate.
  const turnCost = (4418 * rates.input + 534 * rates.output + 36955 * rates.input * 2) / 1e6;
  expect(messages[0]?.usage).toEqual(
    turnTotal
      ? expect.objectContaining({
          output: 534,
          cacheWrite: 36955,
          cacheWrite1h: 36955,
          cost: expect.objectContaining({ total: expect.closeTo(turnCost, 12) }),
        })
      : expect.objectContaining({ input: 10, output: 5, cacheRead: 100, cacheWrite: 0 }),
  );
  expect(priced.costUsd).toEqual(turnTotal ? expect.closeTo(turnCost, 12) : undefined);
  // Known rates cannot make an unmeasured turn free; a measured zero turn still prices at $0.
  const turn = async (usage?: { input: number }) =>
    (await buildCliAssistantTranscriptUsage({ runParams: pricedRunParams, modelId, usage }))
      .costUsd;
  expect(turnTotal ? await turn() : undefined).toBeUndefined();
  expect(turnTotal ? await turn({ input: 0 }) : 0).toBe(0);
});

it.each([
  { kind: "completed", yielded: undefined, stopReason: "stop" },
  { kind: "yielded", yielded: true, stopReason: "stop" },
  { kind: "interrupted after yielding", yielded: true, stopReason: "aborted" },
] as const)(
  "prepares the $kind CLI assistant before its first transcript publication",
  async ({ yielded, stopReason }) => {
    const { target, runParams, persist, updates } = await transcriptFixture("media");
    const sourceText = "Artifacts ready\nMEDIA:./artifact.json";
    const result = await persist({
      runParams: {
        ...runParams,
        prepareAssistantTranscriptMessage: (message) =>
          applyAssistantDeliveryDirectives(message, { managedMediaUrls: ["./artifact.json"] }),
      },
      text: sourceText,
      stopReason,
      yielded,
    });
    expect(result).toMatchObject({ owned: true, idempotencyKey: "cli-assistant:cli-media-run" });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.message).toMatchObject({
      content: [{ type: "text", text: sourceText }],
      idempotencyKey: result.idempotencyKey,
      openclawDelivery: { mediaUrls: ["./artifact.json"] },
    });
    const messages = await transcriptMessages(target);
    expect(messages).toHaveLength(1);
    expect(isIntermediateAssistantTranscriptMessage(messages[0])).toBe(
      yielded === true && stopReason === "stop",
    );
    expect(messages[0]).toMatchObject({ stopReason });
    if (yielded && stopReason === "stop") {
      expect(messages[0]).toMatchObject({
        openclawStreamFallback: {
          replacementText: sourceText,
          source: "segment",
          itemId: "cli-media-run",
        },
      });
    } else {
      expect(messages[0]).not.toHaveProperty("openclawStreamFallback");
    }
    expect(sanitizeChatHistoryMessages(messages)).toMatchObject([
      { content: [{ type: "text", text: "Artifacts ready" }] },
    ]);
  },
);

it.each([
  { mirror: false, yielded: undefined, scheduled: false, hidden: false },
  { mirror: true, yielded: undefined, scheduled: false, hidden: false },
  { mirror: false, yielded: true as const, scheduled: false, hidden: false },
  { mirror: false, yielded: undefined, scheduled: true, hidden: false },
  { mirror: false, yielded: undefined, scheduled: false, hidden: true },
])(
  "settles CLI metadata without duplicates (%j)",
  async ({ mirror, yielded, scheduled, hidden }) => {
    const { target, runParams, persist } = await transcriptFixture("settlement");
    Object.assign(runParams, {
      privateCompletion: hidden,
      ...(scheduled
        ? { inputProvenance: { kind: "internal_system", sourceTool: "cron_execution" } }
        : {}),
    });
    const first = await persist({
      text: "Progress",
      timestamp: 1790000000000,
      nativeIdentity: { cliSessionId: "native", externalId: "progress" },
      segmentKey: "native:progress",
      stopReason: "aborted",
    });
    await persist({ text: "Progress", segmentKey: "native:progress" });
    const last = await persist({
      text: "Answer",
      segmentKey: "native:answer",
      stopReason: "aborted",
    });
    const segments = [
      { text: "Progress", key: "native:progress", anchor: first.terminalAnchor! },
      { text: "Answer", key: "native:answer", anchor: last.terminalAnchor! },
    ];
    expect((await transcriptMessages(target))[0]?.stopReason).toBe("aborted");
    for (let retry = 0; retry < 2; retry++) {
      await persistCliAssistantSettlement({
        runParams,
        segments,
        nativeFinal: { text: "Answer", identity: { cliSessionId: "native", externalId: "answer" } },
        modelId: "claude-sonnet-4-6",
        output: {
          text: "Answer",
          yielded,
          usage: { input: 11, output: 7, total: 18 },
          ...(mirror ? { messagingToolSourceReplyPayloads: [{ text: " Answer " }] } : {}),
        },
        sourceReplyWasDelivered: mirror,
      });
    }
    const current = await readSessionTranscriptAnchorsAsync(target, {
      entryIds: [last.terminalAnchor!.entryId],
    });
    expect(current.anchors[0]).toEqual(last.terminalAnchor);
    expect(segments.at(-1)?.anchor).toEqual(current.anchors[0]);
    const beforeInvalidWrite = await transcriptMessages(target);
    await expect(
      settlePreparedAssistantTranscriptMetadataAtAnchor(segments[0]!.anchor, (message) => ({
        ...message,
        content: [{ type: "text", text: "unsafe replacement" }],
      })),
    ).rejects.toThrow("Assistant metadata settlement changed transcript content");
    expect(await transcriptMessages(target)).toEqual(beforeInvalidWrite);
    const messages = await transcriptMessages(target);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      stopReason: "stop",
      usage: { totalTokens: 0 },
      timestamp: 1790000000000,
      __openclaw: { cliSessionId: "native", externalId: "progress" },
    });
    expect(messages[1]).toMatchObject({
      stopReason: "stop",
      usage: { input: 11, output: 7, totalTokens: 18 },
    });
    // Dispatch mirrors only the delivered body; the distinct progress snapshot stays visible.
    expect(messages.map((message) => Reflect.get(message, "display") === false)).toEqual([
      scheduled || hidden,
      mirror || scheduled || hidden,
    ]);
    expect(messages.every(isIntermediateAssistantTranscriptMessage)).toBe(yielded === true);
  },
);

it("keeps distinct snapshots visible when the message tool delivers a different reply", async () => {
  const { target, runParams, persist } = await transcriptFixture("distinct-source-reply");
  const findings = await persist({
    text: "Findings: BLUE-HERON-42",
    segmentKey: "native:findings",
  });
  await persistCliAssistantSettlement({
    runParams,
    segments: [
      { text: "Findings: BLUE-HERON-42", key: "native:findings", anchor: findings.terminalAnchor! },
    ],
    modelId: "claude-sonnet-4-6",
    output: {
      text: "Findings: BLUE-HERON-42",
      messagingToolSourceReplyPayloads: [{ text: "Done" }],
    },
    sourceReplyWasDelivered: true,
  });
  const messages = await transcriptMessages(target);
  expect(messages).toHaveLength(1);
  expect(messages[0]).not.toHaveProperty("display", false);
  expect(sanitizeChatHistoryMessages(messages)).toMatchObject([
    { content: [{ type: "text", text: "Findings: BLUE-HERON-42" }] },
  ]);
});

it("keeps output that has no committed snapshot range", () => {
  const output = { text: "Other Progress", textSnapshotRanges: [] };
  // Missing provenance cannot authorize removing text, even with a committed row.
  expect(cliUnpersistedAssistantTail(output, [])).toBe(output.text);
  expect(cliUnpersistedAssistantTail(output, [{ key: "progress" }])).toBe("Other Progress");
  expect(cliUnpersistedAssistantTail({ text: "Other Progress" }, [])).toBe("Other Progress");
});

it.each(
  [false, true].flatMap((interrupted) => [false, true].map((tail) => ({ interrupted, tail }))),
)(
  "settles aggregate once (interrupted=$interrupted, tail=$tail)",
  async ({ interrupted, tail }) => {
    const { target, runParams, persist } = await transcriptFixture("aggregate");
    const durable = await persist({
      text: "Progress",
      segmentKey: "progress",
      stopReason: "aborted",
    });
    await persistCliAssistantSettlement({
      runParams,
      modelId: "claude-sonnet-4-6",
      segments: [{ text: "Progress", key: "progress", anchor: durable.terminalAnchor! }],
      output: {
        text: "Progress" + (tail ? "\n\nAnswer" : ""),
        textSnapshotRanges: [{ key: "progress", start: 0, end: 8 }],
        ...(interrupted ? { terminalInterruption: { reason: "timeout" as const } } : {}),
        usage: { input: 11, output: 7, total: 18 },
      },
      sourceReplyWasDelivered: false,
    });
    const messages = await transcriptMessages(target);
    expect(messages.map((message) => Reflect.get(message, "content"))).toEqual(
      (tail ? ["Progress", "Answer"] : ["Progress"]).map((text) => [{ type: "text", text }]),
    );
    expect(
      messages.every(
        (message) => Reflect.get(message, "stopReason") === (interrupted ? "aborted" : "stop"),
      ),
    ).toBe(true);
    expect(
      messages.reduce(
        (total, message) =>
          total + Number(isRecord(message.usage) ? message.usage.totalTokens : undefined),
        0,
      ),
    ).toBe(18);
  },
);

it.each([false, true])(
  "preserves hook display=%s when snapshots settle or strand",
  async (display) => {
    const { target, runParams } = await transcriptFixture(`hook-display-${display}`);
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: "snapshot-display",
      hookName: "before_message_write",
      source: "test",
      handler: ({ message }: PluginHookBeforeMessageWriteEvent) => ({
        message: { ...message, display },
      }),
    });
    initializeGlobalHookRunner(registry);
    const base = buildPreparedContext({ provider: "claude-cli", model: "claude-sonnet-4-6" });
    const queue = createCliAssistantSegmentQueue(
      { ...base, params: { ...base.params, ...runParams } },
      () => {},
    );
    queue.push({ text: "Hook snapshot", key: "hook:snapshot", timestamp: 1 });
    await queue.drain();
    await queue.strand();
    expect(await transcriptMessages(target)).toMatchObject([{ display, stopReason: "aborted" }]);
  },
);

it("retires only the committed Claude snapshot from the cumulative Gateway stream", async () => {
  const { target, runParams } = await transcriptFixture("live-occurrences");
  const { runId, sessionKey } = runParams;
  const base = buildPreparedContext({ ...runParams, model: "claude-sonnet-4-6" });
  const context = { ...base, params: { ...base.params, ...runParams } };
  const warnings: string[] = [];
  const queue = createCliAssistantSegmentQueue(context, (warning) => warnings.push(warning));
  const handlers = createCliEventHandlers({
    context,
    toolTracking: createCliToolTracking(context),
    getRunState: () => ({ failed: false, error: undefined }),
  });
  const gateway = createAgentEventTestHarness();
  gateway.register(runId, sessionKey, runId);
  onTestFinished(() => gateway.handler.dispose());
  onTestFinished(onAgentRuntimeEvent(gateway.handler));
  onTestFinished(
    onInternalSessionTranscriptUpdate((update) => {
      gateway.handler.retireTranscript(update, Promise.resolve(true));
    }),
  );
  const completed: string[] = [];
  const held = { type: "result", openclaw_interim_result: true, result: "Ready" };
  const parser = createClaudeParser({
    onAssistantDelta: handlers.emitCliAssistantDelta,
    onCompletedReply: (text) => completed.push(text),
    onCommentarySegment: queue.push,
  });
  const push = (...records: unknown[]) => parser.push(joinJsonlFrames(...records, ""));
  const live = () => gateway.chatRunState.resolveBuffer(runId).text;
  push({ type: "system", subtype: "init", session_id: "native" }, claudeMessageStart("m1"), {
    ...claudeTextDelta("Re", 0),
    uuid: "partial-frame",
    api_message_id: "m1",
  });
  expect(live()).toBe("Re"); // Available before Claude reveals the durable record UUID.
  push(
    snapshot("first", "Re", null, "m1"),
    claudeTextDelta("ady"),
    snapshot("first", "Ready", null, "m1"),
    held,
    held,
  );
  push(claudeMessageStart("m2"), claudeTextDelta("Ready"));
  gateway.chatRunState.flushPendingText(runId);
  expect(live()).toBe("Ready\n\nReady");
  push(snapshot("second", "Ready", null, "m2"), held);
  expect(completed).toEqual(["Ready", "Ready"]);
  await queue.drain();
  expect(live()).toBe("Ready");
  expect(gateway.chat().at(-1)?.[1]).toMatchObject({
    state: "delta",
    replace: true,
    deltaText: "Ready",
  });
  // A replay of the first UUID can have a fresh live occurrence, not a third durable row.
  push(claudeMessageStart("m1"), claudeTextDelta("Ready"), snapshot("first", "Ready", null, "m1"));
  await queue.drain();
  expect(live()).toBe("Ready");
  push(claudeMessageStart("unfinished"), claudeTextDelta("Still typing"));
  parser.finish();
  await queue.drain();
  expect(live()).toBe("Still typing");
  expect(await transcriptMessages(target)).toMatchObject(
    ["first", "second"].map((uuid) => ({
      idempotencyKey: `cli-assistant:${runId}:seg:native:${uuid}`,
      content: [{ type: "text", text: "Ready" }],
    })),
  );
  // Stop saves the unsnapshotted tail through the ordinary run-level fallback row.
  await persistCliAssistantSettlement({
    runParams,
    modelId: context.modelId,
    segments: queue.segments,
    output: { ...parser.getOutput(true)!, terminalInterruption: { reason: "aborted" } },
    sourceReplyWasDelivered: false,
  });
  expect((await transcriptContents(target)).at(-1)).toEqual([
    { type: "text", text: "Still typing" },
  ]);
  expect(live()).toBe("");
  expect(gateway.chat().at(-1)?.[1]).toMatchObject({
    state: "delta",
    replace: true,
    deltaText: "",
  });
  expect(warnings).toEqual([]);
});

// Mid-run snapshots show in their own slot; the run outcome settles their stop reason (#196092).
it.each(["completed", "interrupted", "stranded", "yielded"] as const)(
  "shows mid-run snapshots at once and lets the %s run settle them",
  async (outcome) => {
    const { target, runParams, updates } = await transcriptFixture(`held-${outcome}`);
    const base = buildPreparedContext({ provider: "claude-cli", model: "claude-sonnet-4-6" });
    const warnings: string[] = [];
    const queue = createCliAssistantSegmentQueue(
      { ...base, params: { ...base.params, ...runParams } },
      (message) => warnings.push(message),
    );
    for (const [index, text] of ["Transcribing.", "Transcripts done."].entries()) {
      queue.push({
        text,
        itemId: `message-${index}`,
        key: `native:${index}`,
        timestamp: index + 1,
      });
    }
    await queue.drain();
    const live = await transcriptMessages(target);
    expect(live).toMatchObject([{ stopReason: "stop" }, { stopReason: "stop" }]);
    // Held rows left the cumulative live tail below accepted steers for the whole run.
    expect(live.some((message) => Reflect.has(message, "display"))).toBe(false);
    expect(updates.some((update) => update.message && Reflect.has(update.message, "display"))).toBe(
      false,
    );
    expect(sanitizeChatHistoryMessages(live)).toHaveLength(2);
    if (outcome !== "stranded") {
      await persistCliAssistantSettlement({
        runParams,
        modelId: "claude-sonnet-4-6",
        segments: queue.segments,
        output: {
          ...(outcome === "yielded" ? { yielded: true as const } : {}),
          text: "Transcribing.\n\nTranscripts done.",
          textSnapshotRanges: [
            { key: "native:0", start: 0, end: 13 },
            { key: "native:1", start: 15, end: 32 },
          ],
          ...(outcome === "interrupted" ? { terminalInterruption: { reason: "aborted" } } : {}),
        },
        sourceReplyWasDelivered: false,
      });
    }
    // A later failure or retry strands only snapshots that no settlement claimed.
    await queue.strand();
    const settled = await transcriptMessages(target);
    expect(warnings).toEqual([]);
    expect(settled).toMatchObject(
      [0, 1].map((index) => ({
        openclawStreamFallback: { itemId: `commentary-${runParams.runId}-message-${index}` },
      })),
    );
    // Stranding rewrites already-visible rows outside a terminal reply, so it asks clients to resync.
    expect(updates.some((update) => !update.message)).toBe(outcome === "stranded");
    expect(settled.map((message) => Reflect.get(message, "stopReason"))).toEqual(
      Array(2).fill(outcome === "completed" || outcome === "yielded" ? "stop" : "aborted"),
    );
    expect(settled.some((message) => Reflect.has(message, "display"))).toBe(false);
    expect(
      sanitizeChatHistoryMessages(settled).map((message) => Reflect.get(message, "content")),
    ).toEqual(["Transcribing.", "Transcripts done."].map((text) => [{ type: "text", text }]));
  },
);

it("retains distinct unkeyed snapshots and a keyed retry once through runner persistence", async () => {
  const { target, runParams } = await transcriptFixture("unkeyed");
  const segments: CliPersistedSegment[] = [];
  for (const segment of [
    { text: "First", timestamp: 1 },
    { text: "Second", timestamp: 2 },
    { text: "Third", key: "native:third", timestamp: 3 },
    { text: "Third", key: "native:third", timestamp: 3 },
  ]) {
    await persistCliAssistantSegment(
      runParams,
      "claude-sonnet-4-6",
      segments,
      segment,
      segments.length,
    );
  }
  expect(segments).toHaveLength(3);
  expect(new Set(segments.map((segment) => segment.anchor.entryId)).size).toBe(3);
  await persistCliAssistantSettlement({
    runParams,
    modelId: "claude-sonnet-4-6",
    segments,
    output: {
      text: "First\n\nSecond\n\nThird",
      usage: { total: 18 },
      textSnapshotRanges: [
        { key: "unkeyed:0", start: 0, end: 5 },
        { key: "unkeyed:1", start: 7, end: 13 },
        { key: "native:third", start: 15, end: 20 },
      ],
    },
    sourceReplyWasDelivered: false,
  });
  const messages = await transcriptMessages(target);
  expect(messages.map((message) => Reflect.get(message, "content"))).toEqual(
    ["First", "Second", "Third"].map((text) => [{ type: "text", text }]),
  );
  expect(
    messages.reduce(
      (total, message) =>
        total + Number(isRecord(message.usage) ? message.usage.totalTokens : undefined),
      0,
    ),
  ).toBe(18);
});

it.each(["Checking files.", "Check"])(
  "settles commentary-enabled interruption without replay or prefix loss (%s)",
  async (commentary) => {
    const { target, runParams } = await transcriptFixture("commentary-interruption");
    const segments: CliPersistedSegment[] = [];
    let writes = Promise.resolve();
    const previews: Array<{ text: string; itemId?: string }> = [];
    const parser = createClaudeParser({
      onCommentaryText: (text, itemId) => previews.push({ text, itemId }),
      onCommentarySegment: (segment) => {
        writes = writes.then(async () => {
          await persistCliAssistantSegment(runParams, "claude-sonnet-4-6", segments, segment, 0);
        });
      },
    });
    const answer = commentary === "Check" ? "Checking succeeded" : "Answer";
    parser.push(
      joinJsonlFrames(
        { type: "init", session_id: "native" },
        ...[null, "tool_use"].map((stop) => snapshot("commentary", commentary, stop)),
        nativeTool(),
        ...[null, "end_turn"].map((stop) => snapshot("answer", answer, stop)),
        "",
      ),
    );
    parser.finish();
    const output = parser.getOutput()!;
    expect(output.text).toBe(answer);
    await writes;
    // Real Stop cancels execution only after the completed snapshots commit.
    const controller = new AbortController();
    const stoppedRunParams = {
      ...runParams,
      abortSignal: controller.signal,
      assertCurrent: () => controller.signal.throwIfAborted(),
      assertSettlementCurrent: () => {},
    };
    controller.abort(new Error("explicit Stop"));
    await persistCliAssistantSettlement({
      runParams: stoppedRunParams,
      segments,
      output: { ...output, terminalInterruption: { reason: "aborted" } },
      modelId: "claude-sonnet-4-6",
      sourceReplyWasDelivered: false,
    });
    const messages = await transcriptMessages(target);
    expect(messages.map((message) => Reflect.get(message, "stopReason"))).toEqual([
      "aborted",
      "aborted",
    ]);
    expect(messages[1]).not.toHaveProperty("openclawStreamFallback");
    expect(previews).toEqual([{ text: commentary, itemId: "commentary" }]);
    expect(messages[0]).toMatchObject({
      openclawStreamFallback: {
        itemId: `commentary-${runParams.runId}-commentary`,
        runId: runParams.runId,
      },
    });
    expect(messages.map((message) => Reflect.get(message, "content"))).toEqual(
      [commentary, answer].map((text) => [{ type: "text", text }]),
    );
  },
);

it("keeps raw snapshot boundaries across length-changing and cross-boundary replacements", () => {
  const replacements = [
    { from: "Answer plus", to: "Translated answer" },
    { from: /tail$/u, to: "remainder" },
  ];
  const output = transformCliResultText(
    {
      text: "Answer plus unfinished tail",
      textSnapshotRanges: [{ key: "native:answer", start: 0, end: 6 }],
    },
    replacements,
  );
  expect(cliUnpersistedAssistantTail(output, [{ key: "native:answer" }], replacements)).toBe(
    "plus unfinished remainder",
  );
  expect(cliUnpersistedAssistantTail(output, [{ key: "native:other" }], replacements)).toBe(
    "Translated answer unfinished remainder",
  );
});

it.each(["next-uuid", "success", "abort"])(
  "flushes the latest native revision on %s through prepared persistence",
  async (boundary) => {
    const { target, runParams } = await transcriptFixture(`revision-${boundary}`);
    const segments: CliPersistedSegment[] = [];
    let writes = Promise.resolve();
    let prepared = 0;
    const parser = createClaudeParser({
      onCommentarySegment: (segment) => {
        writes = writes.then(async () => {
          await persistCliAssistantSegment(
            {
              ...runParams,
              prepareAssistantTranscriptMessage: (message) => {
                prepared++;
                return { ...message, content: [{ type: "text", text: "Prepared Answer" }] };
              },
            },
            "claude-sonnet-4-6",
            segments,
            segment,
            0,
          );
        });
      },
    });
    parser.push(
      joinJsonlFrames(
        { type: "init", session_id: "native" },
        ...["Ans", "Answer"].map((text) => snapshot("answer", text)),
        "",
      ),
    );
    await writes;
    expect(await transcriptMessages(target)).toEqual([]);
    if (boundary === "next-uuid") {
      parser.push(joinJsonlFrames(nativeTool(), ""));
    } else if (boundary === "abort") {
      parser.flushCompletedSegments();
    } else {
      parser.finish();
    }
    await writes;
    expect(segments).toHaveLength(1);
    expect(prepared).toBe(1);
    expect(await transcriptContents(target)).toEqual([[{ type: "text", text: "Prepared Answer" }]]);
    parser.finish();
    await writes;
    await persistCliAssistantSettlement({
      runParams,
      segments,
      output: {
        text: "Answer",
        ...(boundary === "abort" ? { terminalInterruption: { reason: "aborted" as const } } : {}),
      },
      modelId: "claude-sonnet-4-6",
      nativeFinal: { text: "Answer", identity: { cliSessionId: "native", externalId: "answer" } },
      sourceReplyWasDelivered: false,
    });
    expect(await transcriptContents(target)).toEqual([[{ type: "text", text: "Prepared Answer" }]]);
    if (boundary === "success") {
      const reloaded = await transcriptMessages(target);
      expect(reloaded[0]).not.toHaveProperty("openclawStreamFallback");
      expect(
        sanitizeChatHistoryMessages(reloaded, undefined, { includeCommentaryFallbacks: false }),
      ).toMatchObject([{ content: [{ type: "text", text: "Prepared Answer" }] }]);
    }
  },
);

it.each(["revision", "result"])(
  "persists the authoritative unterminated %s before cleanup flush",
  async (kind) => {
    const { target, runParams } = await transcriptFixture(`terminal-${kind}`);
    const segments: CliPersistedSegment[] = [];
    let writes = Promise.resolve();
    const parser = createClaudeParser({
      onCommentarySegment: (segment) => {
        writes = writes.then(() =>
          persistCliAssistantSegment(runParams, "claude-sonnet-4-6", segments, segment, 0),
        );
      },
    });
    parser.push(
      joinJsonlFrames({ type: "init", session_id: "native" }, snapshot("answer", "Ans"), ""),
    );
    parser.push(
      JSON.stringify(
        kind === "revision"
          ? snapshot("answer", "Answer")
          : { type: "result", subtype: "success", result: "Answer", session_id: "native" },
      ),
    );
    parser.flushCompletedSegments();
    parser.finish();
    await writes;
    await persistCliAssistantSettlement({
      runParams,
      segments,
      output: parser.getOutput()!,
      modelId: "claude-sonnet-4-6",
      nativeFinal: { text: "Answer", identity: { cliSessionId: "native", externalId: "answer" } },
      sourceReplyWasDelivered: false,
    });
    expect(await transcriptContents(target)).toEqual([[{ type: "text", text: "Answer" }]]);
  },
);

// Forks exercise the admitted transcript owner rather than the worker-thread path.
it.skipIf(!isMainThread).each(["live", "stale", "revoked"])(
  "settles inside the admitted owner with absent or stale expectations (%s)",
  async (state) => {
    const { target, runParams, persist } = await transcriptFixture("missing-expectation");
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      updatedAt: Date.now(),
      lifecycleRevision: "live-revision",
    });
    let active = true;
    await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: target,
        assertCommitAllowed: () => {
          if (!active) {
            throw new Error("owner revoked");
          }
        },
        withTranscriptWrite: async (write) => await write(),
      },
      async () => {
        const row = await persist({
          text: "Answer",
          segmentKey: "native:answer",
          stopReason: "aborted",
        });
        const controller = new AbortController();
        const stoppedRunParams = {
          ...runParams,
          abortSignal: controller.signal,
          assertCurrent: () => controller.signal.throwIfAborted(),
          assertSettlementCurrent: () => {
            if (!active) {
              throw new Error("owner revoked");
            }
          },
        };
        controller.abort(new Error("explicit Stop"));
        active = state !== "revoked";
        if (state === "stale") {
          Object.assign(stoppedRunParams, { expectedLifecycleRevision: "retired-lifecycle" });
        }
        const settlement = persistCliAssistantSettlement({
          runParams: stoppedRunParams,
          segments: [{ text: "Answer", key: "native:answer", anchor: row.terminalAnchor! }],
          nativeFinal: {
            text: "Answer",
            identity: { cliSessionId: "native", externalId: "answer" },
          },
          output: { text: "Answer" },
          modelId: "claude-sonnet-4-6",
          sourceReplyWasDelivered: false,
        });
        if (state === "revoked") {
          await expect(settlement).rejects.toThrow("owner revoked");
        } else {
          await settlement;
        }
      },
    );
    expect(await transcriptMessages(target)).toMatchObject([
      { stopReason: state === "revoked" ? "aborted" : "stop" },
    ]);
  },
);

it("persists a pending completed snapshot when Stop precedes the terminal flush", async () => {
  const { target, runParams } = await transcriptFixture("stop-before-flush");
  const controller = new AbortController();
  await withOwnedSessionTranscriptWrites(
    {
      sessionTarget: target,
      assertCommitAllowed() {},
      withTranscriptWrite: async (write) => await write(),
    },
    async () => {
      const context = buildPreparedContext({ provider: "claude-cli", runId: runParams.runId });
      context.params = {
        ...context.params,
        ...runParams,
        abortSignal: controller.signal,
        assertCurrent: () => controller.signal.throwIfAborted(),
      };
      const warnings: string[] = [];
      const queue = createCliAssistantSegmentQueue(context, (message) => warnings.push(message));
      const parser = createClaudeParser({ onCommentarySegment: queue.push });
      parser.push(
        joinJsonlFrames(
          { type: "init", session_id: "native-before-replacement" },
          snapshot("pending", "Completed before Stop", "end_turn"),
          "",
        ),
      );
      await queue.drain();
      expect(queue.segments).toHaveLength(0);
      controller.abort(new Error("explicit Stop"));
      parser.flushCompletedSegments();
      await queue.drain();
      expect(warnings).toEqual([]);
      expect(queue.segments).toHaveLength(1);
      await queue.strand();
      expect(await transcriptMessages(target)).toMatchObject([
        { content: [{ type: "text", text: "Completed before Stop" }], stopReason: "aborted" },
      ]);
    },
  );
});
