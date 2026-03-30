// Private runtime barrel for the bundled Feishu extension.
// Keep this barrel thin and aligned with the local extension surface.

export type {
	ChannelMessageActionName,
	ChannelMeta,
	ChannelOutboundAdapter,
	OpenClawConfig as ClawdbotConfig,
	OpenClawConfig,
	OpenClawPluginApi,
	PluginRuntime,
	RuntimeEnv,
} from "openclaw/plugin-sdk/feishu";
export * from "openclaw/plugin-sdk/feishu";
export {
	buildChannelConfigSchema,
	buildProbeChannelStatusSummary,
	createActionGate,
	createDefaultChannelRuntimeState,
	DEFAULT_ACCOUNT_ID,
	PAIRING_APPROVED_MESSAGE,
} from "openclaw/plugin-sdk/feishu";
export {
	isRequestBodyLimitError,
	readRequestBodyWithLimit,
	requestBodyErrorToText,
} from "openclaw/plugin-sdk/webhook-ingress";
