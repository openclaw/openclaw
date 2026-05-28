import type { NormalizedFeishuEvent } from "./event.model.js";

export type FeishuEventTriggerMode = "main" | "isolated" | "custom";

export type FeishuEventTriggerSpec = {
  mode?: FeishuEventTriggerMode;
  agentId?: string;
  command?: string;
  instructions?: string;
  customSessionId?: string;
  includeRawPayload?: boolean;
};

export type ResolvedFeishuEventTriggerPlan = {
  mode: FeishuEventTriggerMode;
  agentId: string;
  sessionKeyHint: string;
  commandText: string;
  summary: string;
  event: NormalizedFeishuEvent;
};

function sanitizeSessionToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]/g, "_");
}

function buildSubjectHint(event: NormalizedFeishuEvent): string {
  if (!event.subject) {
    return "subject=none";
  }
  const tokens = Object.entries(event.subject.tokens)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  return tokens ? `subject=${event.subject.kind}[${tokens}]` : `subject=${event.subject.kind}`;
}

function buildActorHint(event: NormalizedFeishuEvent): string {
  if (!event.actor) {
    return "actor=unknown";
  }
  return [
    event.actor.openId ? `open_id=${event.actor.openId}` : undefined,
    event.actor.userId ? `user_id=${event.actor.userId}` : undefined,
    event.actor.unionId ? `union_id=${event.actor.unionId}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function resolveCommandPrefix(spec: FeishuEventTriggerSpec | undefined): string {
  const explicit = spec?.command?.trim();
  return explicit || "/feishu-event";
}

export function renderFeishuEventTriggerCommand(params: {
  event: NormalizedFeishuEvent;
  trigger?: FeishuEventTriggerSpec;
}): string {
  const { event, trigger } = params;
  const lines = [
    `${resolveCommandPrefix(trigger)} ${event.eventType}`,
    `account=${event.accountId}`,
    `category=${event.category}`,
    `subtype=${event.subtype}`,
    `source=${event.sourceId}`,
    buildActorHint(event),
    buildSubjectHint(event),
    `summary=${event.summary}`,
  ];
  const instructions = trigger?.instructions?.trim();
  if (instructions) {
    lines.push(`instructions=${instructions}`);
  }
  if (trigger?.includeRawPayload) {
    lines.push(`raw=${JSON.stringify(event.raw)}`);
  }
  return lines.join("\n");
}

export function resolveFeishuEventTriggerSessionKeyHint(params: {
  event: NormalizedFeishuEvent;
  trigger?: FeishuEventTriggerSpec;
  agentId?: string;
}): string {
  const { event, trigger } = params;
  const agentId = trigger?.agentId?.trim() || params.agentId?.trim() || "main";
  if (trigger?.mode === "main") {
    return `agent:${sanitizeSessionToken(agentId)}:feishu:event:main:${sanitizeSessionToken(event.accountId)}`;
  }
  if (trigger?.mode === "custom") {
    const customSessionId = trigger.customSessionId?.trim() || `${event.category}:${event.subtype}`;
    return `agent:${sanitizeSessionToken(agentId)}:feishu:event:${sanitizeSessionToken(customSessionId)}`;
  }
  return `agent:${sanitizeSessionToken(agentId)}:cron:feishu-event:${sanitizeSessionToken(event.accountId)}:${sanitizeSessionToken(event.category)}:${sanitizeSessionToken(event.sourceId)}`;
}

export function resolveFeishuEventTriggerPlan(params: {
  event: NormalizedFeishuEvent;
  trigger?: FeishuEventTriggerSpec;
  agentId?: string;
}): ResolvedFeishuEventTriggerPlan {
  const { event, trigger } = params;
  const mode = trigger?.mode ?? "isolated";
  const agentId = trigger?.agentId?.trim() || params.agentId?.trim() || "main";
  return {
    mode,
    agentId,
    sessionKeyHint: resolveFeishuEventTriggerSessionKeyHint({ event, trigger, agentId }),
    commandText: renderFeishuEventTriggerCommand({ event, trigger }),
    summary: `trigger ${mode} session for ${event.eventType} (${event.sourceId})`,
    event,
  };
}
