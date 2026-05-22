//#region src/index.d.ts
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
type PackManifest = {
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
declare function definePackManifest(manifest: PackManifest): PackManifest;
type FieldType = "string" | "number" | "boolean" | "date";
type FieldDef = {
  name: string;
  type: FieldType;
  required?: boolean;
  description?: string;
  foreignKey?: string;
};
type ObjectTypeDef = {
  name: string;
  displayName?: string;
  description?: string;
  primaryKey?: string;
  fields: FieldDef[];
};
declare function defineObjectType(def: ObjectTypeDef): ObjectTypeDef;
/** 将 ObjectTypeDef 序列化为 ClaWorks YAML 字符串（fields 数组格式）。 */
declare function objectTypeToYaml(def: ObjectTypeDef): string;
type PlaybookTrigger = {
  kind: "event";
  pattern: string;
  filter?: Record<string, unknown>;
  condition?: string;
} | {
  kind: "schedule";
  cron: string;
  timezone?: string;
} | {
  kind: "manual";
};
type StepMeta = {
  condition?: string;
  onFailure?: "abort" | "continue";
};
type NotificationStep = StepMeta & {
  kind: "notification";
  id: string;
  message: string;
  channels?: string[];
};
type LlmStep = StepMeta & {
  kind: "llm";
  id: string;
  prompt: string;
  model?: string;
  output: string;
};
type ActionStep = StepMeta & {
  kind: "action";
  id: string;
  actionApiName: string;
  params: Record<string, unknown>;
  objectType?: string;
  objectId?: string;
  output?: string;
};
type FunctionStep = StepMeta & {
  kind: "function";
  id: string;
  functionApiName: string;
  params: Record<string, unknown>;
  output?: string;
};
type MemoryReadStep = StepMeta & {
  kind: "memory_read";
  id: string;
  subject: string;
  key: string;
  output: string;
};
type MemoryWriteStep = StepMeta & {
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
type PublishEventStep = StepMeta & {
  kind: "publish_event";
  id: string;
  eventType: string;
  source?: string;
  payload?: Record<string, unknown>;
  output?: string;
};
type HitlStep = StepMeta & {
  kind: "hitl";
  id: string;
  message: string;
  options: string[];
  output: string;
  channel?: string;
  timeout_seconds?: number;
};
type ConditionStep = StepMeta & {
  kind: "condition";
  id: string;
  if: string;
  then: PlaybookStep[];
  else?: PlaybookStep[];
};
type ConnectorStep = StepMeta & {
  kind: "connector";
  id: string;
  connectorId: string;
  method: string;
  params?: Record<string, unknown>;
};
type SubPlaybookStep = StepMeta & {
  kind: "playbook";
  id: string;
  playbookId: string;
  input?: Record<string, unknown>;
};
type A2aDelegateStep = StepMeta & {
  kind: "a2a_delegate";
  id: string;
  target: string;
  task: string;
  waitResult?: boolean;
  output?: string;
};
type SubagentStep = StepMeta & {
  kind: "subagent";
  id: string;
  prompt: string;
  model?: string;
  output?: string;
};
type SkillStep = StepMeta & {
  kind: "skill";
  id: string;
  skillId: string;
  input?: Record<string, unknown>;
  output?: string;
};
type PlaybookStep = NotificationStep | LlmStep | ActionStep | FunctionStep | MemoryReadStep | MemoryWriteStep | PublishEventStep | HitlStep | ConditionStep | ConnectorStep | SubPlaybookStep | A2aDelegateStep | SubagentStep | SkillStep;
/** Convenience namespace for building steps with minimal boilerplate. */
declare const step: {
  notify: (id: string, message: string, channels?: string[]) => NotificationStep;
  llm: (id: string, prompt: string, output: string, opts?: {
    model?: string;
  }) => LlmStep;
  action: (id: string, actionApiName: string, params: Record<string, unknown>, opts?: {
    output?: string;
  }) => ActionStep;
  fn: (id: string, functionApiName: string, params: Record<string, unknown>, output?: string) => FunctionStep;
  memRead: (id: string, subject: string, key: string, output: string) => MemoryReadStep;
  memWrite: (id: string, subject: string, key: string, value: string | number | boolean, opts?: {
    category?: string;
    confidence?: number;
    source?: string;
  }) => MemoryWriteStep;
  publish: (id: string, eventType: string, payload?: Record<string, unknown>, opts?: {
    source?: string;
    output?: string;
  }) => PublishEventStep;
  hitl: (id: string, message: string, options: string[], output: string, opts?: {
    channel?: string;
    timeout_seconds?: number;
  }) => HitlStep;
  cond: (id: string, ifExpr: string, then: PlaybookStep[], elseBranch?: PlaybookStep[]) => ConditionStep;
  connector: (id: string, connectorId: string, method: string, params?: Record<string, unknown>) => ConnectorStep;
  subPlaybook: (id: string, playbookId: string, input?: Record<string, unknown>) => SubPlaybookStep;
  a2a: (id: string, target: string, task: string, opts?: {
    waitResult?: boolean;
    output?: string;
  }) => A2aDelegateStep;
  subagent: (id: string, prompt: string, opts?: {
    model?: string;
    output?: string;
  }) => SubagentStep;
  skill: (id: string, skillId: string, input?: Record<string, unknown>, output?: string) => SkillStep;
};
type PlaybookDraft = {
  id: string;
  name: string;
  description?: string;
  pack: string;
  trigger: PlaybookTrigger;
  steps: PlaybookStep[];
  priority?: number;
};
declare function definePlaybook(draft: PlaybookDraft): PlaybookDraft;
/** 将 PlaybookDraft 序列化为 YAML 字符串（适合写入 Pack ontology/playbooks/ 目录）。 */
declare function playbookToYaml(draft: PlaybookDraft): string;
//#endregion
export { A2aDelegateStep, ActionStep, ConditionStep, ConnectorStep, FieldDef, FieldType, FunctionStep, HitlStep, LlmStep, MemoryReadStep, MemoryWriteStep, NotificationStep, ObjectTypeDef, PackManifest, PlaybookDraft, PlaybookStep, PlaybookTrigger, PublishEventStep, SkillStep, StepMeta, SubPlaybookStep, SubagentStep, defineObjectType, definePackManifest, definePlaybook, objectTypeToYaml, playbookToYaml, step };