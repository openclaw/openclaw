import { isJsonObject, type JsonObject } from "./protocol.js";

export type CodexNativeModelInputTools = readonly string[];

/** Stock native hooks flatten the configured V2 namespace without a delimiter. */
export function resolveCodexNativeModelInputTools(config: JsonObject): CodexNativeModelInputTools {
  const features = isJsonObject(config.features) ? config.features : undefined;
  const multiAgent = isJsonObject(features?.multi_agent_v2) ? features.multi_agent_v2 : undefined;
  const namespace =
    typeof multiAgent?.tool_namespace === "string"
      ? multiAgent.tool_namespace.trim()
      : "collaboration";
  return [
    "multi_agent_v1send_input",
    "send_message",
    "followup_task",
    ...(namespace ? [`${namespace}send_message`, `${namespace}followup_task`] : []),
  ];
}
