/**
 * @claworks/sdk — ClaWorks Extension Pack SDK
 *
 * 面向 Pack 作者的类型安全工具集。使用此 SDK 定义 ObjectType、Playbook、Step，
 * 无需手写原始 YAML / JSON，享受完整类型检查。
 *
 * 典型用法（代码生成 YAML 写入磁盘）：
 *   import { definePlaybook, step } from "@claworks/sdk";
 *   const pb = definePlaybook({ id: "my-playbook", ... });
 */

// ─── Manifest ─────────────────────────────────────────────────────────────────

export type PackManifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  license: string;
  dependencies?: string[];
  provides: {
    objectTypes: string[];
    playbooks: string[];
    actionTypes: string[];
  };
};

export function definePackManifest(manifest: PackManifest): PackManifest {
  if (!manifest.id?.trim()) throw new Error("Pack manifest requires id");
  if (!manifest.version?.trim()) throw new Error("Pack manifest requires version");
  return manifest;
}

// ─── ObjectType ───────────────────────────────────────────────────────────────

export type FieldType = "string" | "number" | "boolean" | "date";

export type FieldDef = {
  name: string;
  type: FieldType;
  required?: boolean;
  description?: string;
  foreignKey?: string;
};

export type ObjectTypeDef = {
  name: string;
  displayName?: string;
  description?: string;
  primaryKey?: string;
  fields: FieldDef[];
};

export function defineObjectType(def: ObjectTypeDef): ObjectTypeDef {
  if (!def.name?.trim()) throw new Error("ObjectType requires name");
  if (!def.fields?.length) throw new Error("ObjectType requires at least one field");
  return { primaryKey: "id", ...def };
}

/** 将 ObjectTypeDef 序列化为 ClaWorks YAML 字符串（fields 数组格式）。 */
export function objectTypeToYaml(def: ObjectTypeDef): string {
  const lines: string[] = [
    `name: ${def.name}`,
    def.displayName ? `displayName: ${def.displayName}` : "",
    def.description ? `description: |\n  ${def.description.replace(/\n/g, "\n  ")}` : "",
    `primaryKey: ${def.primaryKey ?? "id"}`,
    "fields:",
  ].filter(Boolean);

  for (const f of def.fields) {
    lines.push(`  - name: ${f.name}`);
    lines.push(`    type: ${f.type}`);
    if (f.required) lines.push(`    required: true`);
    if (f.description) lines.push(`    description: ${f.description}`);
    if (f.foreignKey) lines.push(`    foreign_key: ${f.foreignKey}`);
  }
  return lines.join("\n") + "\n";
}

// ─── Triggers ─────────────────────────────────────────────────────────────────

export type PlaybookTrigger =
  | { kind: "event"; pattern: string; filter?: Record<string, unknown>; condition?: string }
  | { kind: "schedule"; cron: string; timezone?: string }
  | { kind: "manual" };

// ─── Steps (type-safe builders) ───────────────────────────────────────────────

export type StepMeta = {
  condition?: string;
  onFailure?: "abort" | "continue";
};

export type NotificationStep = StepMeta & {
  kind: "notification";
  id: string;
  message: string;
  channels?: string[];
};
export type LlmStep = StepMeta & {
  kind: "llm";
  id: string;
  prompt: string;
  model?: string;
  output: string;
};
export type ActionStep = StepMeta & {
  kind: "action";
  id: string;
  actionApiName: string;
  params: Record<string, unknown>;
  objectType?: string;
  objectId?: string;
  output?: string;
};
export type FunctionStep = StepMeta & {
  kind: "function";
  id: string;
  functionApiName: string;
  params: Record<string, unknown>;
  output?: string;
};
export type MemoryReadStep = StepMeta & {
  kind: "memory_read";
  id: string;
  subject: string;
  key: string;
  output: string;
};
export type MemoryWriteStep = StepMeta & {
  kind: "memory_write";
  id: string;
  subject: string;
  key: string;
  value: string | number | boolean;
  category?: string;
  confidence?: number;
  source?: string;
  output?: string;
};
export type PublishEventStep = StepMeta & {
  kind: "publish_event";
  id: string;
  eventType: string;
  source?: string;
  payload?: Record<string, unknown>;
  output?: string;
};
export type HitlStep = StepMeta & {
  kind: "hitl";
  id: string;
  message: string;
  options: string[];
  output: string;
  channel?: string;
  timeout_seconds?: number;
};
export type ConditionStep = StepMeta & {
  kind: "condition";
  id: string;
  if: string;
  then: PlaybookStep[];
  else?: PlaybookStep[];
};
export type ConnectorStep = StepMeta & {
  kind: "connector";
  id: string;
  connectorId: string;
  method: string;
  params?: Record<string, unknown>;
};
export type SubPlaybookStep = StepMeta & {
  kind: "playbook";
  id: string;
  playbookId: string;
  input?: Record<string, unknown>;
};
export type A2aDelegateStep = StepMeta & {
  kind: "a2a_delegate";
  id: string;
  target: string;
  task: string;
  waitResult?: boolean;
  output?: string;
};
export type SubagentStep = StepMeta & {
  kind: "subagent";
  id: string;
  prompt: string;
  model?: string;
  output?: string;
};
export type SkillStep = StepMeta & {
  kind: "skill";
  id: string;
  skillId: string;
  input?: Record<string, unknown>;
  output?: string;
};

export type PlaybookStep =
  | NotificationStep
  | LlmStep
  | ActionStep
  | FunctionStep
  | MemoryReadStep
  | MemoryWriteStep
  | PublishEventStep
  | HitlStep
  | ConditionStep
  | ConnectorStep
  | SubPlaybookStep
  | A2aDelegateStep
  | SubagentStep
  | SkillStep;

/** Convenience namespace for building steps with minimal boilerplate. */
export const step = {
  notify: (id: string, message: string, channels?: string[]): NotificationStep => ({
    kind: "notification",
    id,
    message,
    channels,
  }),

  llm: (id: string, prompt: string, output: string, opts?: { model?: string }): LlmStep => ({
    kind: "llm",
    id,
    prompt,
    output,
    ...opts,
  }),

  action: (
    id: string,
    actionApiName: string,
    params: Record<string, unknown>,
    opts?: { output?: string },
  ): ActionStep => ({ kind: "action", id, actionApiName, params, output: opts?.output ?? id }),

  fn: (
    id: string,
    functionApiName: string,
    params: Record<string, unknown>,
    output?: string,
  ): FunctionStep => ({ kind: "function", id, functionApiName, params, output }),

  memRead: (id: string, subject: string, key: string, output: string): MemoryReadStep => ({
    kind: "memory_read",
    id,
    subject,
    key,
    output,
  }),

  memWrite: (
    id: string,
    subject: string,
    key: string,
    value: string | number | boolean,
    opts?: { category?: string; confidence?: number; source?: string },
  ): MemoryWriteStep => ({ kind: "memory_write", id, subject, key, value, ...opts }),

  publish: (
    id: string,
    eventType: string,
    payload?: Record<string, unknown>,
    opts?: { source?: string; output?: string },
  ): PublishEventStep => ({ kind: "publish_event", id, eventType, payload, ...opts }),

  hitl: (
    id: string,
    message: string,
    options: string[],
    output: string,
    opts?: { channel?: string; timeout_seconds?: number },
  ): HitlStep => ({ kind: "hitl", id, message, options, output, ...opts }),

  cond: (
    id: string,
    ifExpr: string,
    then: PlaybookStep[],
    elseBranch?: PlaybookStep[],
  ): ConditionStep => ({ kind: "condition", id, if: ifExpr, then, else: elseBranch }),

  connector: (
    id: string,
    connectorId: string,
    method: string,
    params?: Record<string, unknown>,
  ): ConnectorStep => ({ kind: "connector", id, connectorId, method, params }),

  subPlaybook: (
    id: string,
    playbookId: string,
    input?: Record<string, unknown>,
  ): SubPlaybookStep => ({ kind: "playbook", id, playbookId, input }),

  a2a: (
    id: string,
    target: string,
    task: string,
    opts?: { waitResult?: boolean; output?: string },
  ): A2aDelegateStep => ({ kind: "a2a_delegate", id, target, task, ...opts }),

  subagent: (
    id: string,
    prompt: string,
    opts?: { model?: string; output?: string },
  ): SubagentStep => ({ kind: "subagent", id, prompt, ...opts }),

  skill: (
    id: string,
    skillId: string,
    input?: Record<string, unknown>,
    output?: string,
  ): SkillStep => ({ kind: "skill", id, skillId, input, output }),
};

// ─── Playbook ─────────────────────────────────────────────────────────────────

export type PlaybookDraft = {
  id: string;
  name: string;
  description?: string;
  pack: string;
  trigger: PlaybookTrigger;
  steps: PlaybookStep[];
  priority?: number;
};

export function definePlaybook(draft: PlaybookDraft): PlaybookDraft {
  if (!draft.id?.trim()) throw new Error("Playbook requires id");
  if (!draft.pack?.trim()) throw new Error("Playbook requires pack");
  return { priority: 50, ...draft };
}

/** 将 PlaybookDraft 序列化为 YAML 字符串（适合写入 Pack ontology/playbooks/ 目录）。 */
export function playbookToYaml(draft: PlaybookDraft): string {
  const lines: string[] = [
    `id: ${draft.id}`,
    `name: ${draft.name}`,
    draft.description ? `description: |\n  ${draft.description.replace(/\n/g, "\n  ")}` : "",
    `pack: ${draft.pack}`,
    `priority: ${draft.priority ?? 50}`,
  ].filter(Boolean);

  // Trigger
  const t = draft.trigger;
  lines.push("trigger:");
  lines.push(`  kind: ${t.kind}`);
  if (t.kind === "event") {
    lines.push(`  pattern: ${t.pattern}`);
    if (t.condition) lines.push(`  condition: ${t.condition}`);
    if (t.filter)
      lines.push(
        `  filter:\n${Object.entries(t.filter)
          .map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`)
          .join("\n")}`,
      );
  }
  if (t.kind === "schedule") {
    lines.push(`  cron: "${t.cron}"`);
    if (t.timezone) lines.push(`  timezone: ${t.timezone}`);
  }

  lines.push("steps:");
  for (const s of draft.steps) {
    lines.push(...serializeStep(s, "  "));
  }
  return lines.join("\n") + "\n";
}

function serializeStep(s: PlaybookStep, indent: string): string[] {
  const lines: string[] = [`${indent}- id: ${s.id}`, `${indent}  kind: ${s.kind}`];
  if (s.condition) lines.push(`${indent}  condition: "${s.condition}"`);
  switch (s.kind) {
    case "notification":
      lines.push(`${indent}  message: "${s.message.replace(/"/g, '\\"')}"`);
      if (s.channels?.length)
        lines.push(
          `${indent}  channels:\n${s.channels.map((c) => `${indent}    - ${c}`).join("\n")}`,
        );
      break;
    case "llm":
      lines.push(
        `${indent}  prompt: |\n${s.prompt
          .split("\n")
          .map((l) => `${indent}    ${l}`)
          .join("\n")}`,
      );
      if (s.model) lines.push(`${indent}  model: ${s.model}`);
      lines.push(`${indent}  output: ${s.output}`);
      break;
    case "action":
      lines.push(`${indent}  actionApiName: ${s.actionApiName}`);
      lines.push(`${indent}  params:`);
      for (const [k, v] of Object.entries(s.params)) lines.push(`${indent}    ${k}: "${v}"`);
      if (s.output) lines.push(`${indent}  output: ${s.output}`);
      break;
    case "function":
      lines.push(`${indent}  functionApiName: ${s.functionApiName}`);
      lines.push(`${indent}  params:`);
      for (const [k, v] of Object.entries(s.params)) lines.push(`${indent}    ${k}: "${v}"`);
      if (s.output) lines.push(`${indent}  output: ${s.output}`);
      break;
    case "memory_read":
      lines.push(`${indent}  subject: "${s.subject}"`);
      lines.push(`${indent}  key: "${s.key}"`);
      lines.push(`${indent}  output: ${s.output}`);
      break;
    case "memory_write":
      lines.push(`${indent}  subject: "${s.subject}"`);
      lines.push(`${indent}  key: "${s.key}"`);
      lines.push(`${indent}  value: "${s.value}"`);
      if (s.category) lines.push(`${indent}  category: ${s.category}`);
      if (s.confidence !== undefined) lines.push(`${indent}  confidence: ${s.confidence}`);
      if (s.source) lines.push(`${indent}  source: "${s.source}"`);
      if (s.output) lines.push(`${indent}  output: ${s.output}`);
      break;
    case "publish_event":
      lines.push(`${indent}  eventType: ${s.eventType}`);
      if (s.source) lines.push(`${indent}  source: ${s.source}`);
      if (s.payload) {
        lines.push(`${indent}  payload:`);
        for (const [k, v] of Object.entries(s.payload)) lines.push(`${indent}    ${k}: "${v}"`);
      }
      if (s.output) lines.push(`${indent}  output: ${s.output}`);
      break;
    case "hitl":
      lines.push(`${indent}  message: "${s.message.replace(/"/g, '\\"')}"`);
      lines.push(`${indent}  options:\n${s.options.map((o) => `${indent}    - ${o}`).join("\n")}`);
      lines.push(`${indent}  output: ${s.output}`);
      if (s.channel) lines.push(`${indent}  channel: ${s.channel}`);
      break;
    case "condition":
      lines.push(`${indent}  if: "${s.if.replace(/"/g, '\\"')}"`);
      lines.push(`${indent}  then:`);
      for (const child of s.then) lines.push(...serializeStep(child, indent + "    "));
      if (s.else?.length) {
        lines.push(`${indent}  else:`);
        for (const child of s.else) lines.push(...serializeStep(child, indent + "    "));
      }
      break;
    case "a2a_delegate":
      lines.push(`${indent}  target: ${s.target}`);
      lines.push(`${indent}  task: "${s.task.replace(/"/g, '\\"')}"`);
      if (s.waitResult !== undefined) lines.push(`${indent}  waitResult: ${s.waitResult}`);
      if (s.output) lines.push(`${indent}  output: ${s.output}`);
      break;
    case "subagent":
      lines.push(
        `${indent}  prompt: |\n${s.prompt
          .split("\n")
          .map((l) => `${indent}    ${l}`)
          .join("\n")}`,
      );
      if (s.model) lines.push(`${indent}  model: ${s.model}`);
      if (s.output) lines.push(`${indent}  output: ${s.output}`);
      break;
    case "skill":
      lines.push(`${indent}  skillId: ${s.skillId}`);
      if (s.output) lines.push(`${indent}  output: ${s.output}`);
      break;
    case "connector":
      lines.push(`${indent}  connectorId: ${s.connectorId}`);
      lines.push(`${indent}  method: ${s.method}`);
      break;
    case "playbook":
      lines.push(`${indent}  playbookId: ${s.playbookId}`);
      break;
  }
  return lines;
}
