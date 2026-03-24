import { Type } from "@sinclair/typebox";
//#region src/channels/plugins/agent-tools/whatsapp-login.ts
function createWhatsAppLoginTool() {
	return {
		label: "WhatsApp Login",
		name: "whatsapp_login",
		ownerOnly: true,
		description: "Generate a WhatsApp QR code for linking, or wait for the scan to complete.",
		parameters: Type.Object({
			action: Type.Unsafe({
				type: "string",
				enum: ["start", "wait"]
			}),
			timeoutMs: Type.Optional(Type.Number()),
			force: Type.Optional(Type.Boolean())
		}),
		execute: async (_toolCallId, args) => {
			const { startWebLoginWithQr, waitForWebLogin } = await import("../../../login-qr-DKyPuJsc.js");
			if ((args?.action ?? "start") === "wait") {
				const result = await waitForWebLogin({ timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : void 0 });
				return {
					content: [{
						type: "text",
						text: result.message
					}],
					details: { connected: result.connected }
				};
			}
			const result = await startWebLoginWithQr({
				timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : void 0,
				force: typeof args.force === "boolean" ? args.force : false
			});
			if (!result.qrDataUrl) return {
				content: [{
					type: "text",
					text: result.message
				}],
				details: { qr: false }
			};
			return {
				content: [{
					type: "text",
					text: [
						result.message,
						"",
						"Open WhatsApp → Linked Devices and scan:",
						"",
						`![whatsapp-qr](${result.qrDataUrl})`
					].join("\n")
				}],
				details: { qr: true }
			};
		}
	};
}
//#endregion
export { createWhatsAppLoginTool };
