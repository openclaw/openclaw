import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import type { EventTrigger } from "../kernel/types.js";
import type { FieldDefinition, ObjectTypeDefinition } from "../planes/data/ontology-types.js";
import type {
  PlaybookDefinition,
  PlaybookStep,
  StepHitlConfig,
  StepMeta,
} from "../planes/orch/playbook-types.js";
import type { PackManifest } from "./types.js";

/** Accept snake_case (pack YAML) and camelCase (SDK-style) field names. */
function readField(raw: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = raw[key];
    if (value != null && String(value).trim() !== "") {
      return String(value);
    }
  }
  return "";
}

export async function readPackManifest(manifestPath: string): Promise<PackManifest> {
  const raw = parseYaml(await readFile(manifestPath, "utf8")) as PackManifest;
  if (!raw?.id || !raw?.version) {
    throw new Error(`Invalid pack manifest: ${manifestPath}`);
  }
  return raw;
}

export function parseObjectTypeYaml(
  content: string,
  packId: string,
  fileName: string,
): ObjectTypeDefinition {
  const doc = parseYaml(content) as Record<string, unknown>;
  const ot = (doc.object_type ?? doc) as Record<string, unknown>;
  // 支持 `name:` 或 `api_name:` 作为类型名
  const apiName = String(ot.api_name ?? ot.name ?? basename(fileName, ".yaml"));

  let fields: import("../planes/data/ontology-types.js").FieldDefinition[] = [];

  if (Array.isArray(ot.fields)) {
    // 新格式：fields 数组（`- name: foo\n  type: string\n  required: true`）
    fields = (ot.fields as Record<string, unknown>[]).map((spec) => ({
      name: String(spec.name ?? ""),
      type: mapYamlType(String(spec.type ?? "string")),
      required: spec.required === true,
      refType: spec.foreign_key ? String(spec.foreign_key).split(".")[0] : undefined,
    }));
  } else {
    // 旧格式：properties 字典（`properties:\n  foo:\n    type: string`）
    const properties = (ot.properties ?? {}) as Record<string, Record<string, unknown>>;
    fields = Object.entries(properties).map(([name, spec]) => ({
      name,
      type: mapYamlType(String(spec.type ?? "string")),
      required: spec.required === true,
      refType: spec.foreign_key ? String(spec.foreign_key).split(".")[0] : undefined,
    }));
  }

  return {
    name: apiName,
    description: ot.description ? String(ot.description).trim() : undefined,
    pack: packId,
    primaryKey: String(ot.primary_key ?? ot.primaryKey ?? "id"),
    fields,
    actions: [],
  };
}

export function parsePlaybookYaml(content: string, packId: string): PlaybookDefinition {
  const doc = parseYaml(content) as Record<string, unknown>;
  const id = String(doc.id ?? "");
  const triggerRaw = (doc.trigger ?? {}) as Record<string, unknown>;
  const trigger = parseTrigger(triggerRaw);
  const stepsRaw = Array.isArray(doc.steps) ? doc.steps : [];
  const steps = stepsRaw.map((s, i) => parseStep(s as Record<string, unknown>, i));

  return {
    id,
    name: String(doc.name ?? id),
    description: doc.description ? String(doc.description).trim() : undefined,
    pack: packId,
    version: doc.version ? String(doc.version) : undefined,
    trigger,
    priority: typeof doc.priority === "number" ? doc.priority : 0,
    steps,
  };
}

function parseTrigger(raw: Record<string, unknown>): EventTrigger {
  // 支持 `kind:` 和 `type:` 两种写法；有 cron/schedule 字段时优先 schedule
  const rawKind = String(raw.kind ?? raw.type ?? "");
  // `event: task.created` 是 `kind: event` + `pattern: task.created` 的简写
  const hasPattern = raw.event_type != null || raw.pattern != null || raw.event != null;
  const hasCron = raw.cron != null || rawKind === "schedule";

  if (rawKind === "manual") {
    return { kind: "manual" };
  }
  if (hasCron) {
    return {
      kind: "schedule",
      cron: String(raw.cron ?? "0 * * * *"),
      timezone: raw.timezone ? String(raw.timezone) : undefined,
    };
  }
  if (rawKind === "event" || hasPattern) {
    return {
      kind: "event",
      pattern: String(raw.event ?? raw.event_type ?? raw.pattern ?? "*"),
      condition: raw.condition ? String(raw.condition) : undefined,
      filter: raw.filter as Record<string, unknown> | undefined,
    };
  }
  // 未知/空 kind，降级为 manual
  return { kind: "manual" };
}

function parseStepMeta(raw: Record<string, unknown>): StepMeta {
  const hitlRaw = raw.hitl as Record<string, unknown> | undefined;
  const hitl: StepHitlConfig | undefined = hitlRaw
    ? {
        requiredIf: hitlRaw.required_if ? String(hitlRaw.required_if) : undefined,
        autoApproveIf: hitlRaw.auto_approve_if ? String(hitlRaw.auto_approve_if) : undefined,
        timeoutHours: typeof hitlRaw.timeout_hours === "number" ? hitlRaw.timeout_hours : undefined,
      }
    : undefined;

  return {
    condition: raw.condition ? String(raw.condition) : undefined,
    onFailure: raw.on_failure === "continue" ? "continue" : "abort",
    hitl,
  };
}

function parseStep(raw: Record<string, unknown>, index: number): PlaybookStep {
  const id = String(raw.id ?? `step_${index}`);
  const stepType = String(raw.type ?? raw.kind ?? "notification");
  const meta = parseStepMeta(raw);

  if (stepType === "notification") {
    // 兼容 channel: "string" 和 channels: ["array"] 两种写法
    let channels: string[] | undefined;
    if (Array.isArray(raw.channels)) {
      channels = raw.channels.map(String);
    } else if (raw.channel && typeof raw.channel === "string") {
      channels = [raw.channel];
    }
    return {
      ...meta,
      kind: "notification",
      id,
      message: String(raw.message ?? ""),
      channels,
    };
  }
  if (stepType === "hitl") {
    return {
      ...meta,
      kind: "hitl",
      id,
      message: String(raw.message ?? ""),
      channel: raw.channel ? String(raw.channel) : undefined,
      options: Array.isArray(raw.options) ? raw.options.map(String) : ["approve", "reject"],
      output: String(raw.output ?? `${id}_decision`),
      timeout_seconds: typeof raw.timeout_seconds === "number" ? raw.timeout_seconds : undefined,
    };
  }
  if (stepType === "llm" || stepType === "llm_reason" || stepType === "llm_reasoning") {
    const llmOutput = readField(raw, "output", "output_var", "outputVar");
    return {
      ...meta,
      kind: "llm",
      id,
      prompt: String(raw.prompt ?? ""),
      model: raw.model ? String(raw.model) : undefined,
      output: llmOutput || `${id}_result`,
    };
  }
  if (stepType === "condition") {
    const thenRaw = Array.isArray(raw.then) ? raw.then : [];
    const elseRaw = Array.isArray(raw.else) ? raw.else : [];
    return {
      kind: "condition",
      id,
      if: String(raw.if ?? "true"),
      then: thenRaw.map((s, i) => parseStep(s as Record<string, unknown>, i)),
      else: elseRaw.map((s, i) => parseStep(s as Record<string, unknown>, i + 100)),
    };
  }
  if (stepType === "action") {
    const outputKey = readField(raw, "output", "output_var", "outputVar");
    return {
      ...meta,
      kind: "action",
      id,
      actionApiName: readField(raw, "action_api_name", "actionApiName", "action", "fn"),
      params: (raw.params ?? raw.input ?? {}) as Record<string, unknown>,
      objectType: raw.object_type ? String(raw.object_type) : undefined,
      objectId: raw.object_id ? String(raw.object_id) : undefined,
      output: outputKey || id,
    };
  }
  if (stepType === "function") {
    const outputKey = readField(raw, "output", "output_var", "outputVar");
    return {
      ...meta,
      kind: "function",
      id,
      functionApiName: readField(raw, "function_api_name", "functionApiName", "function"),
      params: (raw.params ?? raw.input ?? {}) as Record<string, unknown>,
      output: outputKey || id,
    };
  }
  if (stepType === "connector") {
    return {
      ...meta,
      kind: "connector",
      id,
      connectorId: String(raw.connector_id ?? raw.connector ?? ""),
      method: String(raw.method ?? "start"),
      params: (raw.params ?? {}) as Record<string, unknown>,
    };
  }
  if (stepType === "playbook") {
    return {
      ...meta,
      kind: "playbook",
      id,
      playbookId: String(raw.playbook_id ?? raw.playbook ?? ""),
      input: (raw.input ?? raw.params) as Record<string, unknown> | undefined,
    };
  }
  if (stepType === "a2a_delegate") {
    const a2aOutput = readField(raw, "output", "output_var", "outputVar");
    return {
      ...meta,
      kind: "a2a_delegate",
      id,
      target: String(raw.target ?? raw.target_url ?? ""),
      task: String(raw.task ?? raw.message ?? ""),
      waitResult: raw.wait_result !== false && raw.waitResult !== false,
      output: a2aOutput || id,
    };
  }
  if (stepType === "subagent") {
    const subagentOutput = readField(raw, "output", "output_var", "outputVar");
    return {
      ...meta,
      kind: "subagent",
      id,
      prompt: String(raw.prompt ?? ""),
      model: raw.model ? String(raw.model) : undefined,
      output: subagentOutput || id,
    };
  }
  if (stepType === "skill") {
    return {
      ...meta,
      kind: "skill",
      id,
      skillId: String(raw.skill_id ?? raw.skill ?? ""),
      input: (raw.input ?? raw.params) as Record<string, unknown> | undefined,
      output: raw.output ? String(raw.output) : id,
    };
  }
  if (stepType === "notify") {
    return {
      ...meta,
      kind: "notification",
      id,
      message: String(raw.message ?? ""),
      channels: raw.channel
        ? [String(raw.channel)]
        : Array.isArray(raw.channels)
          ? raw.channels.map(String)
          : undefined,
    };
  }
  if (stepType === "memory_read") {
    return {
      ...meta,
      kind: "memory_read",
      id,
      subject: String(raw.subject ?? "global"),
      key: String(raw.key ?? ""),
      output: String(raw.output ?? `${id}_memory`),
    };
  }
  if (stepType === "memory_write") {
    return {
      ...meta,
      kind: "memory_write",
      id,
      subject: String(raw.subject ?? "global"),
      key: String(raw.key ?? ""),
      value: raw.value as string | number | boolean,
      category: raw.category ? String(raw.category) : undefined,
      confidence:
        typeof raw.confidence === "number"
          ? raw.confidence
          : raw.confidence
            ? Number(raw.confidence)
            : undefined,
      source: raw.source ? String(raw.source) : undefined,
      output: raw.output ? String(raw.output) : undefined,
    };
  }
  if (stepType === "publish_event") {
    return {
      ...meta,
      kind: "publish_event",
      id,
      eventType: String(raw.event_type ?? raw.eventType ?? ""),
      source: raw.source ? String(raw.source) : undefined,
      payload: raw.payload ? (raw.payload as Record<string, unknown>) : undefined,
      output: raw.output ? String(raw.output) : undefined,
    };
  }
  return {
    ...meta,
    kind: "atomic",
    id,
    fn: String(raw.fn ?? raw.action ?? stepType),
    params: (raw.params ?? raw.input ?? {}) as Record<string, unknown>,
    output: raw.output ? String(raw.output) : undefined,
  };
}

function mapYamlType(t: string): FieldDefinition["type"] {
  if (t === "integer" || t === "float" || t === "number") {
    return "number";
  }
  if (t === "boolean") {
    return "boolean";
  }
  if (t === "datetime" || t === "date") {
    return "date";
  }
  return "string";
}
