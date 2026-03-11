import type { NormalizedUsage } from "./usage.js";

export type AgentRunTraceStage = "plan" | "tool" | "observation" | "replan";
export type AgentRunTraceStatus = "running" | "ok" | "error" | "timeout";

export type AgentRunTraceSpan = {
  spanId: string;
  stepId: string;
  stepIndex: number;
  attempt: number;
  stage: AgentRunTraceStage;
  status: AgentRunTraceStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  sessionKey?: string;
  provider?: string;
  model?: string;
  toolName?: string;
  toolCallId?: string;
  usage?: NormalizedUsage;
  costUsd?: number;
  stopReason?: string;
  failureReason?: string;
  error?: string;
  note?: string;
  silent?: boolean;
};

export type AgentRunTraceTimeline = {
  runId: string;
  sessionKey?: string;
  status: AgentRunTraceStatus;
  startedAt?: number;
  endedAt?: number;
  attemptCount: number;
  totalCostUsd?: number;
  spans: AgentRunTraceSpan[];
};

type MutableTimeline = {
  runId: string;
  sessionKey?: string;
  status: AgentRunTraceStatus;
  startedAt?: number;
  endedAt?: number;
  attemptCount: number;
  stepSeq: number;
  completedToolCount: number;
  spans: AgentRunTraceSpan[];
  activeSpanId?: string;
  lastTouchedAt: number;
};

type StartCommon = {
  runId: string;
  sessionKey?: string;
  attempt: number;
  at?: number;
  provider?: string;
  model?: string;
};

type FinishCommon = {
  runId: string;
  sessionKey?: string;
  at?: number;
  status: Exclude<AgentRunTraceStatus, "running">;
  failureReason?: string;
  error?: string;
  note?: string;
};

const TIMELINE_RETENTION_MS = 10 * 60_000;
const RUNNING_TIMELINE_RETENTION_MS = 30 * 60_000;
const MAX_TERMINAL_TIMELINES = 200;

const timelines = new Map<string, MutableTimeline>();
const timelineOrder: string[] = [];

function nowMs(value?: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function getTimeline(runId: string, sessionKey?: string): MutableTimeline {
  const existing = timelines.get(runId);
  if (existing) {
    if (sessionKey?.trim()) {
      existing.sessionKey = sessionKey.trim();
    }
    existing.lastTouchedAt = Date.now();
    return existing;
  }
  const created: MutableTimeline = {
    runId,
    ...(sessionKey?.trim() ? { sessionKey: sessionKey.trim() } : {}),
    status: "running",
    attemptCount: 0,
    stepSeq: 0,
    completedToolCount: 0,
    spans: [],
    lastTouchedAt: Date.now(),
  };
  timelines.set(runId, created);
  timelineOrder.push(runId);
  pruneTimelines();
  return created;
}

function touchTimeline(timeline: MutableTimeline) {
  timeline.lastTouchedAt = Date.now();
}

function getActiveSpan(timeline: MutableTimeline): AgentRunTraceSpan | undefined {
  if (!timeline.activeSpanId) {
    return undefined;
  }
  return timeline.spans.find((span) => span.spanId === timeline.activeSpanId);
}

function computeTotalCostUsd(spans: AgentRunTraceSpan[]): number | undefined {
  let total = 0;
  let hasValue = false;
  for (const span of spans) {
    if (typeof span.costUsd === "number" && Number.isFinite(span.costUsd)) {
      total += span.costUsd;
      hasValue = true;
    }
  }
  return hasValue ? total : undefined;
}

function cloneTimeline(timeline: MutableTimeline): AgentRunTraceTimeline {
  const spans = timeline.spans
    .slice()
    .toSorted((a, b) => a.stepIndex - b.stepIndex)
    .map((span) => ({
      ...span,
      ...(span.usage ? { usage: { ...span.usage } } : {}),
    }));
  const totalCostUsd = computeTotalCostUsd(spans);
  return {
    runId: timeline.runId,
    ...(timeline.sessionKey ? { sessionKey: timeline.sessionKey } : {}),
    status: timeline.status,
    ...(timeline.startedAt !== undefined ? { startedAt: timeline.startedAt } : {}),
    ...(timeline.endedAt !== undefined ? { endedAt: timeline.endedAt } : {}),
    attemptCount: timeline.attemptCount,
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    spans,
  };
}

function setAttemptCount(timeline: MutableTimeline, attempt: number) {
  if (Number.isFinite(attempt) && attempt > timeline.attemptCount) {
    timeline.attemptCount = attempt;
  }
}

function finishSpan(
  timeline: MutableTimeline,
  span: AgentRunTraceSpan | undefined,
  params: Omit<FinishCommon, "runId" | "sessionKey"> & {
    provider?: string;
    model?: string;
    usage?: NormalizedUsage;
    costUsd?: number;
    stopReason?: string;
  },
) {
  if (!span || span.status !== "running") {
    return;
  }
  const endedAt = nowMs(params.at);
  span.status = params.status;
  span.endedAt = endedAt;
  span.durationMs = Math.max(0, endedAt - span.startedAt);
  if (params.failureReason) {
    span.failureReason = params.failureReason;
  }
  if (params.error) {
    span.error = params.error;
  }
  if (params.note) {
    span.note = params.note;
  }
  if (params.provider) {
    span.provider = params.provider;
  }
  if (params.model) {
    span.model = params.model;
  }
  if (params.usage) {
    span.usage = { ...params.usage };
  }
  if (typeof params.costUsd === "number" && Number.isFinite(params.costUsd)) {
    span.costUsd = params.costUsd;
  }
  if (params.stopReason) {
    span.stopReason = params.stopReason;
  }
  if (timeline.activeSpanId === span.spanId) {
    timeline.activeSpanId = undefined;
  }
  touchTimeline(timeline);
}

function createRunningSpan(
  timeline: MutableTimeline,
  params: {
    stage: AgentRunTraceStage;
    attempt: number;
    at?: number;
    sessionKey?: string;
    provider?: string;
    model?: string;
    toolName?: string;
    toolCallId?: string;
    note?: string;
    silent?: boolean;
  },
): AgentRunTraceSpan {
  const startedAt = nowMs(params.at);
  const stepIndex = (timeline.stepSeq += 1);
  const span: AgentRunTraceSpan = {
    spanId: `${params.stage}-${stepIndex}`,
    stepId: `step-${stepIndex}`,
    stepIndex,
    attempt: params.attempt,
    stage: params.stage,
    status: "running",
    startedAt,
    ...(params.sessionKey?.trim() ? { sessionKey: params.sessionKey.trim() } : {}),
    ...(params.provider ? { provider: params.provider } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.toolName ? { toolName: params.toolName } : {}),
    ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
    ...(params.note ? { note: params.note } : {}),
    ...(params.silent ? { silent: true } : {}),
  };
  timeline.spans.push(span);
  timeline.activeSpanId = span.spanId;
  timeline.startedAt = Math.min(timeline.startedAt ?? startedAt, startedAt);
  timeline.status = "running";
  touchTimeline(timeline);
  return span;
}

function createClosedSpan(
  timeline: MutableTimeline,
  params: {
    stage: AgentRunTraceStage;
    attempt: number;
    at?: number;
    sessionKey?: string;
    provider?: string;
    model?: string;
    toolName?: string;
    toolCallId?: string;
    note?: string;
    silent?: boolean;
    status?: Exclude<AgentRunTraceStatus, "running">;
  },
) {
  const span = createRunningSpan(timeline, params);
  finishSpan(timeline, span, {
    status: params.status ?? "ok",
    at: params.at,
    note: params.note,
    provider: params.provider,
    model: params.model,
  });
}

function pruneTimelines() {
  const terminalCutoff = Date.now() - TIMELINE_RETENTION_MS;
  const runningCutoff = Date.now() - RUNNING_TIMELINE_RETENTION_MS;
  for (const runId of timelineOrder.slice()) {
    const timeline = timelines.get(runId);
    if (!timeline) {
      continue;
    }
    if (timeline.status === "running" && timeline.lastTouchedAt < runningCutoff) {
      timelines.delete(runId);
      continue;
    }
    if (timeline.status !== "running" && timeline.lastTouchedAt < terminalCutoff) {
      timelines.delete(runId);
    }
  }

  let terminalIds = timelineOrder.filter((runId) => {
    const timeline = timelines.get(runId);
    return timeline && timeline.status !== "running";
  });
  while (terminalIds.length > MAX_TERMINAL_TIMELINES) {
    const oldestRunId = terminalIds.shift();
    if (!oldestRunId) {
      break;
    }
    timelines.delete(oldestRunId);
  }

  const nextOrder = timelineOrder.filter((runId) => timelines.has(runId));
  timelineOrder.splice(0, timelineOrder.length, ...nextOrder);
}

export function startAgentRunTraceModelTurn(params: StartCommon): AgentRunTraceTimeline {
  const timeline = getTimeline(params.runId, params.sessionKey);
  setAttemptCount(timeline, params.attempt);
  const active = getActiveSpan(timeline);
  if (active?.stage === "plan" || active?.stage === "replan") {
    if (active.attempt === params.attempt) {
      return cloneTimeline(timeline);
    }
    finishSpan(timeline, active, {
      status: "error",
      at: params.at,
      failureReason: "superseded",
      note: "superseded by a new model turn",
    });
  } else if (active?.stage === "observation") {
    finishSpan(timeline, active, {
      status: "ok",
      at: params.at,
      note: "tool observation complete",
    });
  } else if (active?.stage === "tool") {
    finishSpan(timeline, active, {
      status: "error",
      at: params.at,
      failureReason: "interrupted_tool",
      note: "tool span interrupted by a new model turn",
    });
  }

  createRunningSpan(timeline, {
    stage: timeline.completedToolCount > 0 ? "replan" : "plan",
    attempt: params.attempt,
    at: params.at,
    sessionKey: params.sessionKey,
    provider: params.provider,
    model: params.model,
  });
  return cloneTimeline(timeline);
}

export function startAgentRunTraceTool(
  params: StartCommon & { toolName: string; toolCallId: string },
) {
  const timeline = getTimeline(params.runId, params.sessionKey);
  setAttemptCount(timeline, params.attempt);
  const active = getActiveSpan(timeline);

  if (active?.stage === "observation") {
    finishSpan(timeline, active, {
      status: "ok",
      at: params.at,
      note: "tool observation complete",
    });
    createClosedSpan(timeline, {
      stage: "replan",
      attempt: params.attempt,
      at: params.at,
      sessionKey: params.sessionKey,
      provider: params.provider,
      model: params.model,
      note: "implicit replan before tool call",
      silent: true,
    });
  } else if (active?.stage === "plan" || active?.stage === "replan") {
    finishSpan(timeline, active, {
      status: "ok",
      at: params.at,
      provider: params.provider,
      model: params.model,
    });
  } else if (active?.stage === "tool") {
    finishSpan(timeline, active, {
      status: "error",
      at: params.at,
      failureReason: "superseded_tool",
      note: "tool span superseded by a new tool call",
    });
  }

  createRunningSpan(timeline, {
    stage: "tool",
    attempt: params.attempt,
    at: params.at,
    sessionKey: params.sessionKey,
    toolName: params.toolName,
    toolCallId: params.toolCallId,
  });
  return cloneTimeline(timeline);
}

export function finishAgentRunTraceTool(
  params: FinishCommon & {
    toolCallId: string;
    toolName?: string;
    attempt: number;
  },
): AgentRunTraceTimeline {
  const timeline = getTimeline(params.runId, params.sessionKey);
  setAttemptCount(timeline, params.attempt);
  const active = getActiveSpan(timeline);
  if (!active || active.stage !== "tool") {
    return cloneTimeline(timeline);
  }
  finishSpan(timeline, active, {
    status: params.status,
    at: params.at,
    failureReason: params.failureReason,
    error: params.error,
    note: params.note,
  });
  timeline.completedToolCount += 1;
  createRunningSpan(timeline, {
    stage: "observation",
    attempt: params.attempt,
    at: params.at,
    sessionKey: params.sessionKey,
    toolName: params.toolName ?? active.toolName,
    toolCallId: params.toolCallId,
    note: params.status === "error" ? "observing tool error" : undefined,
  });
  return cloneTimeline(timeline);
}

export function recordAgentRunTraceModelOutput(params: {
  runId: string;
  usage?: NormalizedUsage;
  costUsd?: number;
  stopReason?: string;
  provider?: string;
  model?: string;
}) {
  const timeline = timelines.get(params.runId);
  if (!timeline) {
    return undefined;
  }
  const active = getActiveSpan(timeline);
  if (!active || (active.stage !== "plan" && active.stage !== "replan")) {
    return cloneTimeline(timeline);
  }
  if (params.usage) {
    active.usage = { ...params.usage };
  }
  if (typeof params.costUsd === "number" && Number.isFinite(params.costUsd)) {
    active.costUsd = params.costUsd;
  }
  if (params.stopReason) {
    active.stopReason = params.stopReason;
  }
  if (params.provider) {
    active.provider = params.provider;
  }
  if (params.model) {
    active.model = params.model;
  }
  touchTimeline(timeline);
  return cloneTimeline(timeline);
}

export function finishAgentRunTraceRetry(params: FinishCommon): AgentRunTraceTimeline | undefined {
  const timeline = timelines.get(params.runId);
  if (!timeline) {
    return undefined;
  }
  if (params.sessionKey?.trim()) {
    timeline.sessionKey = params.sessionKey.trim();
  }
  const active = getActiveSpan(timeline);
  finishSpan(timeline, active, {
    status: params.status,
    at: params.at,
    failureReason: params.failureReason,
    error: params.error,
    note: params.note,
  });
  timeline.status = "running";
  timeline.endedAt = undefined;
  timeline.completedToolCount = 0;
  return cloneTimeline(timeline);
}

export function finalizeAgentRunTrace(params: FinishCommon): AgentRunTraceTimeline {
  const timeline = getTimeline(params.runId, params.sessionKey);
  const active = getActiveSpan(timeline);
  finishSpan(timeline, active, {
    status: params.status,
    at: params.at,
    failureReason: params.failureReason,
    error: params.error,
    note: params.note,
  });
  timeline.status = params.status;
  timeline.endedAt = nowMs(params.at);
  touchTimeline(timeline);
  pruneTimelines();
  return cloneTimeline(timeline);
}

export function getAgentRunTraceTimeline(runId: string): AgentRunTraceTimeline | undefined {
  pruneTimelines();
  const timeline = timelines.get(runId);
  if (!timeline) {
    return undefined;
  }
  return cloneTimeline(timeline);
}

export function isAgentRunTraceTerminal(runId: string): boolean {
  const timeline = timelines.get(runId);
  if (!timeline) {
    return false;
  }
  return timeline.status !== "running";
}

export function resetAgentRunTraceForTest() {
  timelines.clear();
  timelineOrder.splice(0, timelineOrder.length);
}
