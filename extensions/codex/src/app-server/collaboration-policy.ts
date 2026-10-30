import { readCodexAuthoredConfigValue, readCodexConfigValue } from "./config-layer-policy.js";
import type { CodexConfigReadResponse, JsonObject } from "./protocol.js";
import type { CodexThreadConfigurationOptions } from "./thread-configuration-options.js";

export function usesManagedCollaboration(
  params: { trigger?: string },
  options: CodexThreadConfigurationOptions,
) {
  return !options.preserveNativeCollaboration && params.trigger !== "cron";
}

/** Managed turns select Default; native-supervised turns retain Codex's mode policy. */
export function buildCodexDefaultCollaborationPolicy(
  config: JsonObject,
  nativeConfig: CodexConfigReadResponse | undefined,
): string {
  const value = (key: string) =>
    readCodexConfigValue(config, key) ??
    (nativeConfig &&
      (readCodexAuthoredConfigValue(nativeConfig, key) ??
        readCodexConfigValue(nativeConfig.config, key)));
  // Codex 0.164.0 registers this tool by default, but Default-mode use is a
  // separate opt-in (core/src/tools/{spec_plan.rs,handlers/request_user_input.rs}).
  const nativeQuestions =
    value("tools.experimental_request_user_input.enabled") !== false &&
    value("features.default_mode_request_user_input") === true;
  return [
    "<collaboration_mode>",
    "Prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. Ask the user directly when required input prevents progress; silence is not an answer or approval.",
    ...(nativeQuestions
      ? [
          "Use `request_user_input` only for optional questions where the answer would materially improve the work, and only when the tool is available to this root thread. If it returns no answers, continue with best judgment. Never use it for permission requests or required input.",
        ]
      : []),
    "</collaboration_mode>",
  ].join("\n");
}
