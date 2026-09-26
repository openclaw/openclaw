export const privateHarnessParamCases = [
  {
    field: "runtimePluginToolGrant",
    value: { pluginId: "grant-owner", toolNames: ["optional_tool"] },
  },
  { field: "semanticNoProgressObserver", value: { close: () => undefined } },
  { field: "__openclawSourceReplyDeliveryRuntime", value: { currentMode: "automatic" } },
  { field: "compactionCountOwner", value: "caller" },
  { field: "onContextAccountingEvent", value: () => undefined },
  { field: "onCompactionRequestBudget", value: () => undefined },
] as const;
