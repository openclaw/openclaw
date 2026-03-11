export const PI_TOOL_DEFINITION_ADAPTER_CONFORMANCE = {
  agentToolAdapter: {
    executeArgLayouts: ["current", "legacy"],
    outputModes: ["standard_result", "details_only_object", "plain_object", "primitive_value"],
    errorModes: [
      "structured_error_result",
      "abort_error_passthrough",
      "already_aborted_signal_passthrough",
    ],
  },
  clientToolAdapter: {
    executeArgLayouts: ["current", "legacy"],
    outputModes: ["pending_result"],
    errorModes: ["blocked_hook_passthrough", "already_aborted_signal_passthrough"],
  },
} as const;
