import { t as WhatsAppConfigSchema } from "./zod-schema.providers-whatsapp-DgRFv5mw.js";
import { r as buildChannelConfigSchema } from "./config-schema-DJNyYIkR.js";
import "./bundled-channel-config-schema-DJEBpx_I.js";
//#endregion
//#region extensions/whatsapp/src/config-schema.ts
const WhatsAppChannelConfigSchema = buildChannelConfigSchema(WhatsAppConfigSchema, { uiHints: {
	"": {
		label: "WhatsApp",
		help: "WhatsApp channel provider configuration for access policy and message batching behavior. Use this section to tune responsiveness and direct-message routing safety for WhatsApp chats."
	},
	dmPolicy: {
		label: "WhatsApp DM Policy",
		help: "Direct message access control (\"pairing\" recommended). \"open\" requires channels.whatsapp.allowFrom=[\"*\"]."
	},
	selfChatMode: {
		label: "WhatsApp Self-Phone Mode",
		help: "Same-phone setup (bot uses your personal WhatsApp number)."
	},
	debounceMs: {
		label: "WhatsApp Message Debounce (ms)",
		help: "Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable)."
	},
	configWrites: {
		label: "WhatsApp Config Writes",
		help: "Allow WhatsApp to write config in response to channel events/commands (default: true)."
	}
} });
//#endregion
export { WhatsAppChannelConfigSchema as t };
