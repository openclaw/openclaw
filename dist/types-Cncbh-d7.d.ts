//#region src/tools/types.d.ts
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | {
  readonly [key: string]: JsonValue;
};
type JsonObject = {
  readonly [key: string]: JsonValue;
};
type ToolOwnerRef = {
  readonly kind: "core";
} | {
  readonly kind: "plugin";
  readonly pluginId: string;
} | {
  readonly kind: "channel";
  readonly channelId: string;
  readonly pluginId?: string;
} | {
  readonly kind: "mcp";
  readonly serverId: string;
};
type ToolExecutorRef = {
  readonly kind: "core";
  readonly executorId: string;
} | {
  readonly kind: "plugin";
  readonly pluginId: string;
  readonly toolName: string;
} | {
  readonly kind: "channel";
  readonly channelId: string;
  readonly actionId: string;
} | {
  readonly kind: "mcp";
  readonly serverId: string;
  readonly toolName: string;
};
type ToolAvailabilitySignal = {
  readonly kind: "always";
} | {
  readonly kind: "auth";
  readonly providerId: string;
} | {
  readonly kind: "config";
  readonly path: readonly string[];
  readonly check?: "exists" | "non-empty" | "available";
} | {
  readonly kind: "env";
  readonly name: string;
} | {
  readonly kind: "plugin-enabled";
  readonly pluginId: string;
} | {
  readonly kind: "context";
  readonly key: string;
  readonly equals?: JsonPrimitive;
};
type ToolAvailabilityExpression = ToolAvailabilitySignal | {
  readonly allOf: readonly ToolAvailabilityExpression[];
} | {
  readonly anyOf: readonly ToolAvailabilityExpression[];
};
type ToolDescriptor = {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly owner: ToolOwnerRef;
  readonly executor?: ToolExecutorRef;
  readonly availability?: ToolAvailabilityExpression;
  readonly annotations?: JsonObject;
  readonly sortKey?: string;
};
type ToolAvailabilityContext = {
  readonly authProviderIds?: ReadonlySet<string>;
  readonly config?: JsonObject;
  readonly isConfigValueAvailable?: (params: {
    readonly value: JsonValue;
    readonly path: readonly string[];
    readonly signal: Extract<ToolAvailabilitySignal, {
      readonly kind: "config";
    }>;
  }) => boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly enabledPluginIds?: ReadonlySet<string>;
  readonly values?: Readonly<Record<string, JsonPrimitive | undefined>>;
};
type ToolUnavailableReason = "auth-missing" | "config-missing" | "context-mismatch" | "env-missing" | "plugin-disabled" | "unsupported-signal";
type ToolAvailabilityDiagnostic = {
  readonly reason: ToolUnavailableReason;
  readonly signal?: ToolAvailabilitySignal;
  readonly message: string;
};
type ToolPlanEntry = {
  readonly descriptor: ToolDescriptor;
  readonly executor: ToolExecutorRef;
};
type HiddenToolPlanEntry = {
  readonly descriptor: ToolDescriptor;
  readonly diagnostics: readonly ToolAvailabilityDiagnostic[];
};
type ToolPlan = {
  readonly visible: readonly ToolPlanEntry[];
  readonly hidden: readonly HiddenToolPlanEntry[];
};
type BuildToolPlanOptions = {
  readonly descriptors: readonly ToolDescriptor[];
  readonly availability?: ToolAvailabilityContext;
};
//#endregion
export { JsonValue as a, ToolAvailabilityExpression as c, ToolExecutorRef as d, ToolOwnerRef as f, ToolUnavailableReason as h, JsonPrimitive as i, ToolAvailabilitySignal as l, ToolPlanEntry as m, HiddenToolPlanEntry as n, ToolAvailabilityContext as o, ToolPlan as p, JsonObject as r, ToolAvailabilityDiagnostic as s, BuildToolPlanOptions as t, ToolDescriptor as u };