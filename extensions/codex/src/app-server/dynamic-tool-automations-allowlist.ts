import {
  isJsonObject,
  type CodexDynamicToolSpec,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";

export function createCodexAutomationsToolsAllowResolver(specs: readonly CodexDynamicToolSpec[]) {
  const names = new Set<string>();
  const qualifiedNames = new Map<string, string>();
  for (const spec of specs) {
    if (spec.type === "function") {
      names.add(spec.name);
      continue;
    }
    for (const tool of spec.tools) {
      names.add(tool.name);
      // Match Codex's code_mode_name_for_tool_name, including leading underscores.
      const separator = spec.name.endsWith("_") || tool.name.startsWith("_") ? "" : "__";
      qualifiedNames.set(`${spec.name}${separator}${tool.name}`, tool.name);
    }
  }

  function resolveList(value: JsonValue[]): JsonValue[] {
    const resolved = value.map((name) =>
      typeof name !== "string" || names.has(name) ? name : (qualifiedNames.get(name) ?? name),
    );
    return resolved.every((name, index) => name === value[index]) ? value : resolved;
  }

  function resolvePayload(value: JsonValue): JsonValue {
    if (!isJsonObject(value) || !Array.isArray(value.toolsAllow)) {
      return value;
    }
    const toolsAllow = resolveList(value.toolsAllow);
    return toolsAllow === value.toolsAllow ? value : { ...value, toolsAllow };
  }

  // Keep the existing flat/nested recovery shapes intact. The automation tool
  // still owns key repair, payload normalization, validation and creator caps.
  function resolveJobFields(value: JsonObject, paddedKeys: boolean): JsonObject {
    let resolved = value;
    for (const [key, entry] of Object.entries(value)) {
      const field = paddedKeys ? key.trim() : key;
      if (key !== field && Object.hasOwn(value, field)) {
        continue;
      }
      const next =
        field === "toolsAllow" && Array.isArray(entry)
          ? resolveList(entry)
          : field === "payload" || field === "namePayload"
            ? resolvePayload(entry)
            : entry;
      if (next !== entry) {
        if (resolved === value) {
          resolved = { ...value };
        }
        resolved[key] = next;
      }
    }
    return resolved;
  }

  return (args: JsonValue | undefined): JsonValue | undefined => {
    if (!isJsonObject(args)) {
      return args;
    }
    const job = args.job;
    if (!job || (isJsonObject(job) && Object.keys(job).length === 0)) {
      return resolveJobFields(args, false);
    }
    if (!isJsonObject(job)) {
      return args;
    }
    const wrapper = isJsonObject(job.data) ? "data" : isJsonObject(job.job) ? "job" : undefined;
    const wrapped = wrapper ? job[wrapper] : undefined;
    const resolved =
      wrapper && isJsonObject(wrapped)
        ? { ...job, [wrapper]: resolveJobFields(wrapped, true) }
        : resolveJobFields(job, true);
    return resolved === job ? args : { ...args, job: resolved };
  };
}
