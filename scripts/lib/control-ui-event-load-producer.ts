import type { GatewaySessionRow } from "../../ui/src/api/types.ts";
import type {
  ControlUiMockRequestHandler,
  MockGatewayRequest,
} from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import type { ControlUiSessionFixture } from "../../ui/src/test-helpers/control-ui-session-fixtures.ts";

export type EventLoadRow = GatewaySessionRow & ControlUiSessionFixture;

export type EventLoadOptions = {
  count: number;
  duration: number;
  toolCount: number;
  eventIntervalMs?: number;
  foreground: string;
  background: string;
  receiptDefaults: Record<string, unknown>;
  referenceFields: string[];
};

export type EventLoadProducerGateway = {
  requests: MockGatewayRequest[];
  getSessionRow(key: string): EventLoadRow;
  setSessionRow(row: EventLoadRow): void;
  setRequestHandler(method: string, handler: ControlUiMockRequestHandler): void;
  emit(event: string, payload: unknown): void;
  generation(): number;
  progress(value: EventLoadProgress): void;
};

type EventLoadProgress = ReturnType<ReturnType<typeof createEventLoadProducer>["ready"]>;

/** Owns synthetic server work outside the measured renderer. */
export function createEventLoadProducer(
  gateway: EventLoadProducerGateway,
  options: EventLoadOptions,
) {
  let started = performance.now();
  let backgroundStarted = false;
  let sequence = 0;
  let tools = 0;
  let completedTools = 0;
  let backgroundReceipts = 0;
  let targetBackgroundReceipts = 0;
  let lateBackgroundEmissions = 0;
  let maxBackgroundSchedulerLagMs = 0;
  let foregroundCompletedAt = 0;
  let producerElapsedMs = 0;
  let latestText = "";
  let displayedCheckpoint = 0;
  let admitTypingTools = () => {};
  let admitScrollTools = () => {};
  let observedKeys: string[] = [];
  const subscriptions = new Map<string, string>();
  const subscriptionModes = new Map<string, string | undefined>();
  const histories = new Map<string, unknown[]>();
  const history = (key: string) => {
    const row = gateway.getSessionRow(key);
    const runId = Array.isArray(row?.activeRunIds) ? row.activeRunIds[0] : undefined;
    return {
      sessionId: row?.sessionId,
      sessionInfo: row,
      messages: histories.get(key) ?? [],
      thinkingLevel: null,
      inFlightRun:
        row?.hasActiveRun && typeof runId === "string"
          ? { runId, text: "", startedAt: 1_800_000_400_000 }
          : null,
    };
  };
  function ready() {
    return {
      tools,
      completedTools,
      backgroundReceipts,
      targetBackgroundReceipts,
      latestText,
      displayedCheckpoint,
      producerElapsedMs,
      lateBackgroundEmissions,
      maxBackgroundSchedulerLagMs,
      elapsed: performance.now() - started,
      foregroundDrainMs: foregroundCompletedAt ? foregroundCompletedAt - started : 0,
    };
  }
  const keys = Array.from({ length: options.count }, (_, index) =>
    index === 0 ? options.background : `agent:main:interaction-${index + 1}`,
  );
  observedKeys = [...new Set([options.foreground, options.background, ...keys])];
  let foregroundMessageSeq = 400;
  const initialMessages: Record<string, unknown>[] = Array.from({ length: 400 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Transcript 0 message ${index}.\n${"Synthetic transcript detail.\n".repeat(4)}`,
    timestamp: 1_800_000_000_000 + index * 1_000,
    __openclaw: { id: `interaction-0-${index}`, seq: index + 1 },
  }));
  histories.set(options.foreground, initialMessages);
  histories.set(options.background, [
    {
      role: "assistant",
      content: "Event load checkpoint 0.",
      timestamp: 1_800_000_000_000,
      __openclaw: { id: "event-load-background-initial", seq: 1 },
    },
  ]);
  const messageSequences = new Map<string, number>([[options.background, 1]]);
  subscriptions.clear();
  subscriptionModes.clear();
  const recordSubscription = (method: string, params: unknown) => {
    if (method !== "sessions.messages.subscribe" && method !== "sessions.messages.unsubscribe") {
      return;
    }
    const input = params as { key: string; subscriptionId?: string; mode?: string };
    const id = input.subscriptionId ?? input.key;
    if (method === "sessions.messages.subscribe") {
      subscriptions.set(id, input.key);
      subscriptionModes.set(id, input.mode);
    } else {
      subscriptions.delete(id);
      subscriptionModes.delete(id);
    }
  };
  for (const request of gateway.requests) {
    recordSubscription(request.method, request.params);
  }
  // A later subscription gets current authoritative history, not replayed offscreen deltas.
  for (const method of ["chat.history", "chat.startup"]) {
    gateway.setRequestHandler(method, ({ params, respond }) => {
      const key = (params as { sessionKey?: string }).sessionKey ?? options.foreground;
      respond(history(key));
    });
  }
  gateway.setRequestHandler("sessions.messages.subscribe", ({ params, respond }) => {
    const input = params as { key: string; initialHistory?: unknown };
    recordSubscription("sessions.messages.subscribe", params);
    respond({
      key: input.key,
      ...(input.initialHistory
        ? { initialHistory: { ok: true, payload: history(input.key) } }
        : {}),
    });
  });
  gateway.setRequestHandler("sessions.messages.unsubscribe", ({ params, respond }) => {
    recordSubscription("sessions.messages.unsubscribe", params);
    respond({ ok: true });
  });
  const emit = (event: string, payload: Record<string, unknown>) => {
    if (
      (event === "agent" || event === "chat") &&
      ![...subscriptions.values()].includes(String(payload.sessionKey))
    ) {
      return;
    }
    gateway.emit(event, payload);
  };
  gateway.setRequestHandler("sessions.describe", ({ params, respond }) => {
    respond({ session: gateway.getSessionRow((params as { key: string }).key) });
  });
  const toolSnapshot = (key: string) => {
    const row = gateway.getSessionRow(key);
    const full: Record<string, unknown> = { ...options.receiptDefaults, ...row };
    const fields = Object.fromEntries(
      options.referenceFields
        .filter((field) => full[field] !== undefined)
        .map((field) => [field, full[field]]),
    );
    // Unlike roster deltas, the observed OpenClaw agent tool path carries a
    // plain full row plus its duplicated event receipts (server-chat.ts).
    return { ...options.receiptDefaults, ...fields, session: full };
  };
  // Each connection starts without row baselines, then advances the negotiated delta wire.
  const wireRows = new Map<string, { version: number; row: Record<string, unknown> }>();
  let wireGeneration = gateway.generation();
  const emitSnapshot = (
    event: string,
    envelope: Record<string, unknown>,
    row: Record<string, unknown>,
  ) => {
    if (!gateway.generation()) {
      return;
    }
    if (wireGeneration !== gateway.generation()) {
      wireRows.clear();
      wireGeneration = gateway.generation();
    }
    const key = row.key as string;
    const previous = wireRows.get(key);
    const version = (previous?.version ?? 0) + 1;
    const changed: Record<string, unknown> = {};
    if (previous && previous.row !== row) {
      for (const field of [
        "updatedAt",
        "snapshotAt",
        "unread",
        "lastMessageAt",
        "lastMessagePreview",
        "lastAssistantMessage",
        "agentStatus",
      ]) {
        if (row[field] !== previous.row[field]) {
          changed[field] = row[field];
        }
      }
      if (row.hasActiveRun !== previous.row.hasActiveRun) {
        changed.hasActiveRun = row.hasActiveRun;
        changed.activeRunIds = row.activeRunIds;
        changed.status = row.status;
      }
    }
    const session = previous
      ? { key, agentId: row.agentId, version, base: previous.version, set: changed, remove: [] }
      : { key, agentId: row.agentId, version, full: row };
    wireRows.set(key, { version, row });
    // The wire contract indexes sorted defined fields of the reconstructed full
    // row, not patch keys. Captured field names survive our fixture identities.
    const fields = Object.keys(row)
      .filter((field) => row[field] !== undefined)
      .toSorted();
    const references = options.referenceFields
      .map((field) => fields.indexOf(field))
      .filter((index) => index >= 0);
    emit(event, {
      ...options.receiptDefaults,
      ...envelope,
      agentStatus: row.agentStatus ?? null,
      lastAssistantMessage: row.lastAssistantMessage ?? null,
      session,
      sessionFieldRefs: references,
    });
  };
  const emitRow = (key: string, terminal: boolean, publishStatus: boolean, tick = 0) => {
    const previous = gateway.getSessionRow(key);
    const ts = 1_800_001_000_000 + ++sequence;
    const text = `Event load checkpoint ${sequence} for ${key}.`;
    const displayed = terminal || tick % 2 === 1;
    const row: EventLoadRow = {
      ...previous,
      updatedAt: ts,
      snapshotAt: ts,
      hasActiveRun: !terminal,
      activeRunIds: terminal ? [] : [`event-load-${key}`],
      status: terminal ? "done" : "running",
      unread: true,
      lastMessagePreview: text,
      ...(displayed ? { lastAssistantMessage: { text, timestamp: ts } } : {}),
      ...(publishStatus ? { agentStatus: { note: text, expiresAt: ts + 60_000 } } : {}),
    };
    gateway.setSessionRow(row);
    const envelope = {
      sessionKey: key,
      agentId: "main",
      ...(terminal ? { runId: `event-load-${key}` } : {}),
      ts,
      ancestorSessions: [],
    };
    if (terminal || publishStatus) {
      emitSnapshot(
        "sessions.changed",
        {
          ...envelope,
          reason: terminal ? "lifecycle" : "patch",
          ...(terminal ? { phase: "end" } : {}),
        },
        row,
      );
    }
    {
      const messageSeq = (messageSequences.get(key) ?? 0) + 1;
      messageSequences.set(key, messageSeq);
      const id = `event-load-message-${key}-${messageSeq}`;
      const toolCallId = `background-tool-${Math.ceil(tick / 2)}`;
      const message = {
        role: displayed ? "assistant" : "toolResult",
        ...(displayed && !terminal ? { stopReason: "toolUse" } : {}),
        ...(!displayed ? { toolName: "exec", toolCallId } : {}),
        content:
          displayed && !terminal
            ? [
                { type: "text", text },
                {
                  type: "toolCall",
                  id: toolCallId,
                  name: "exec",
                  arguments: { command: "verify-background" },
                },
              ]
            : [{ type: "text", text }],
        timestamp: ts,
        __openclaw: { id, seq: messageSeq, runId: `event-load-${key}` },
      };
      const messages = histories.get(key) ?? [];
      messages.push(message);
      histories.set(key, messages);
      emitSnapshot(
        displayed ? "session.message" : "sessions.changed",
        {
          ...envelope,
          messageId: id,
          messageSeq,
          ...(!displayed ? { phase: "message" } : {}),
          ...(displayed && [...subscriptions.values()].includes(key) ? { message } : {}),
        },
        row,
      );
      if (key === options.background) {
        latestText = text;
      }
      if (key === options.background && displayed) {
        displayedCheckpoint = sequence;
      }
      const subscribers = [...subscriptions].filter(([, candidate]) => candidate === key);
      if (subscribers.length && !terminal) {
        const full = subscribers.some(
          ([subscriptionId]) => subscriptionModes.get(subscriptionId) !== "narration",
        );
        const start = tick % 2 === 1;
        emit("agent", {
          ...toolSnapshot(key),
          sessionKey: key,
          agentId: "main",
          runId: `event-load-${key}`,
          seq: ++sequence,
          ts,
          stream: "tool",
          data: {
            phase: start ? "start" : "result",
            name: "exec",
            toolCallId,
            ...(full
              ? start
                ? { args: { command: "verify-background" } }
                : { result: { text } }
              : {}),
          },
        });
        if (publishStatus) {
          emit("session.narration", {
            sessionKey: key,
            agentId: "main",
            runId: `event-load-${key}`,
            text,
          });
        }
      }
    }
  };
  const backgroundSchedules = keys.map((key, index) => ({
    key,
    tick: 0,
    next: started + (index * 500) / keys.length,
  }));
  const ticksPerSession = Math.floor(options.duration / 500);
  targetBackgroundReceipts = keys.length * ticksPerSession;
  const emitTool = (tool: number, data: Record<string, unknown>) =>
    emit("agent", {
      ...toolSnapshot(options.foreground),
      sessionKey: options.foreground,
      runId: "event-load-foreground",
      stream: "tool",
      seq: ++sequence,
      ts: 1_800_001_000_000 + sequence,
      data: { name: "exec", toolCallId: `event-load-tool-${tool}`, ...data },
    });
  const commitForegroundToolMessage = (tool: number, result: boolean) => {
    const toolCallId = `event-load-tool-${tool}`;
    const id = `event-load-${result ? "result" : "call"}-${tool}`;
    const ts = 1_800_001_000_000 + ++sequence;
    const text = `Tool ${tool} ${result ? "complete" : "started"}.`;
    const messageSeq = ++foregroundMessageSeq;
    const message = {
      role: result ? "toolResult" : "assistant",
      ...(!result ? { stopReason: "toolUse" } : {}),
      ...(result ? { toolName: "exec", toolCallId } : {}),
      content: result
        ? [{ type: "text", text }]
        : [
            { type: "text", text },
            {
              type: "toolCall",
              id: toolCallId,
              name: "exec",
              arguments: { command: `verify-event-load-${tool}` },
            },
          ],
      timestamp: ts,
      __openclaw: { id, seq: messageSeq, runId: "event-load-foreground" },
    };
    initialMessages.push(message);
    const row = {
      ...gateway.getSessionRow(options.foreground),
      updatedAt: ts,
      snapshotAt: ts,
      lastMessagePreview: text,
      ...(result ? { agentStatus: { note: text, expiresAt: ts + 60_000 } } : {}),
    };
    gateway.setSessionRow(row);
    const envelope = {
      sessionKey: options.foreground,
      agentId: "main",
      ancestorSessions: [],
      ts,
    };
    // Hidden toolResult bodies advance the durable cursor through the same
    // phase:message receipt used by server-session-events.ts.
    emitSnapshot(
      result ? "sessions.changed" : "session.message",
      {
        ...envelope,
        messageId: id,
        messageSeq,
        ...(result ? { phase: "message" } : { message }),
      },
      row,
    );
  };
  const settle = () => {
    for (const key of keys) {
      emitRow(key, true, true);
    }
    if (!options.toolCount) {
      return;
    }
    const text = "Event load foreground completed.";
    const timestamp = 1_800_002_000_000;
    const messageId = "event-load-final";
    const messageSeq = ++foregroundMessageSeq;
    const message = {
      role: "assistant",
      content: text,
      timestamp,
      stopReason: "stop",
      __openclaw: {
        id: messageId,
        seq: messageSeq,
        runId: "event-load-foreground",
      },
    };
    histories.get(options.foreground)!.push(message);
    gateway.setSessionRow({
      ...gateway.getSessionRow(options.foreground),
      status: "done",
      hasActiveRun: false,
      activeRunIds: [],
      updatedAt: timestamp,
      snapshotAt: timestamp,
      lastMessageAt: timestamp,
      lastMessagePreview: text,
    });
    const envelope = {
      sessionKey: options.foreground,
      agentId: "main",
      runId: "event-load-foreground",
      ts: timestamp,
      ancestorSessions: [],
    };
    emitSnapshot(
      "session.message",
      {
        ...envelope,
        messageId,
        messageSeq,
        message,
      },
      gateway.getSessionRow(options.foreground),
    );
    emit("chat", {
      sessionKey: options.foreground,
      runId: "event-load-foreground",
      seq: ++sequence,
      state: "final",
      stopReason: "stop",
      message: { role: "assistant", content: [{ type: "text", text }], timestamp },
    });
    emitSnapshot(
      "sessions.changed",
      { ...envelope, phase: "end", reason: "lifecycle" },
      gateway.getSessionRow(options.foreground),
    );
  };
  // Delivery may be late, but a socket backlog preserves the producer's
  // original ordering and lifetimes instead of restarting overdue tools.
  const toolEvents: Array<{ tool: number; stage: number; at: number }> = [];
  let toolEventIndex = 0;
  const toolInterval = Math.min(options.duration / 2, 6_000) / Math.max(1, options.toolCount - 1);
  const firstWaveTools = Math.ceil(options.toolCount / 2);
  let firstWaveLastStart = 0;
  const scheduleTool = (tool: number, at: number, stages = 4) => {
    for (let stage = 0; stage < stages; stage++) {
      toolEvents.push({ tool, stage, at: at + stage * 40 });
    }
  };
  const sortToolEvents = () => {
    toolEvents.splice(0, toolEventIndex);
    toolEventIndex = 0;
    toolEvents.sort((left, right) => left.at - right.at);
  };
  if (options.toolCount) {
    // Hold the first tool's proven live output until native typing begins.
    scheduleTool(1, performance.now(), 3);
  }
  admitTypingTools = () => {
    if (!options.toolCount) {
      return;
    }
    const at = performance.now();
    toolEvents.push({ tool: 1, stage: 3, at });
    for (let tool = 2; tool <= firstWaveTools; tool++) {
      scheduleTool(tool, at + (tool - 2) * toolInterval);
    }
    firstWaveLastStart = at + Math.max(0, firstWaveTools - 2) * toolInterval;
    sortToolEvents();
  };
  admitScrollTools = () => {
    // A sole first-wave tool was already running before typing began.
    const at = Math.max(
      performance.now(),
      firstWaveTools === 1 ? 0 : firstWaveLastStart + toolInterval,
    );
    for (let tool = firstWaveTools + 1; tool <= options.toolCount; tool++) {
      scheduleTool(tool, at + (tool - firstWaveTools - 1) * toolInterval);
    }
    sortToolEvents();
  };
  const timer = setInterval(() => {
    const producerStarted = performance.now();
    const now = performance.now();
    // Independent sessions have deterministic phases and a finite socket-like
    // backlog. Drain at most one due receipt/session/tick; never drop final work.
    for (const schedule of backgroundSchedules) {
      if (!backgroundStarted || schedule.tick >= ticksPerSession || now < schedule.next) {
        continue;
      }
      const late = performance.now() - schedule.next;
      if (late > 25) {
        lateBackgroundEmissions++;
      }
      maxBackgroundSchedulerLagMs = Math.max(maxBackgroundSchedulerLagMs, late);
      schedule.tick++;
      backgroundReceipts++;
      emitRow(schedule.key, false, schedule.tick % 4 === 0, schedule.tick);
      schedule.next += 500;
    }
    while (toolEventIndex < toolEvents.length && toolEvents[toolEventIndex]!.at <= now) {
      const { tool, stage } = toolEvents[toolEventIndex++]!;
      if (stage === 0) {
        tools++;
        emitTool(tool, { phase: "start", args: { command: `verify-event-load-${tool}` } });
        commitForegroundToolMessage(tool, false);
      } else if (stage < 3) {
        emitTool(tool, {
          phase: "update",
          partialResult: `Tool ${tool}: live output ${stage}\n`,
        });
      } else {
        emitTool(tool, {
          phase: "result",
          result: { text: `Tool ${tool} complete.` },
        });
        completedTools++;
        commitForegroundToolMessage(tool, true);
      }
    }
    if (options.toolCount && completedTools === options.toolCount && !foregroundCompletedAt) {
      foregroundCompletedAt = performance.now();
    }
    // Server-side elapsed work; browser application work runs in another process.
    producerElapsedMs += performance.now() - producerStarted;
    gateway.progress(ready());
  }, options.eventIntervalMs ?? 20);
  return {
    ready,
    startBackground() {
      started = performance.now();
      backgroundStarted = true;
      for (const [index, schedule] of backgroundSchedules.entries()) {
        schedule.next = started + (index * 500) / keys.length;
      }
    },
    admitTypingTools: () => admitTypingTools(),
    admitScrollTools: () => admitScrollTools(),
    currentRows: () => observedKeys.map((key) => gateway.getSessionRow(key)),
    disconnect() {
      subscriptions.clear();
      subscriptionModes.clear();
    },
    settle,
    finish() {
      clearInterval(timer);
      return ready();
    },
  };
}
