import { r as buildChannelConfigSchema } from "./config-schema-ChfiQrSg.js";
import { i as IMessageConfigSchema } from "./bundled-channel-config-schema-CA36mrPs.js";
import "./config-api-BwW6j7nL.js";
//#endregion
//#region extensions/imessage/src/config-schema.ts
const IMessageChannelConfigSchema = buildChannelConfigSchema(IMessageConfigSchema, { uiHints: {
	"": {
		label: "iMessage",
		help: "iMessage channel provider configuration for CLI integration and DM access policy handling. Use explicit CLI paths when runtime environments have non-standard binary locations."
	},
	dmPolicy: {
		label: "iMessage DM Policy",
		help: "Direct message access control (\"pairing\" recommended). \"open\" requires channels.imessage.allowFrom=[\"*\"]."
	},
	configWrites: {
		label: "iMessage Config Writes",
		help: "Allow iMessage to write config in response to channel events/commands (default: true)."
	},
	cliPath: {
		label: "iMessage CLI Path",
		help: "Filesystem path to the iMessage bridge CLI binary used for send/receive operations. Set explicitly when the binary is not on PATH in service runtime environments."
	}
} });
//#endregion
export { IMessageChannelConfigSchema as t };
