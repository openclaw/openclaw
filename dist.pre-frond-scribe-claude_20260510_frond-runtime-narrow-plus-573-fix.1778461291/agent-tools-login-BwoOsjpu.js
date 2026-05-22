import { n as waitForWebLogin, t as startWebLoginWithQr } from "./login-qr-runtime-DKaxAVfs.js";
import "./login-qr-api-DUtRBY92.js";
import { Type } from "typebox";
//#region extensions/whatsapp/src/agent-tools-login.ts
const QR_DATA_URL_MAX_LENGTH = 16384;
function readOptionalString(value) {
	return typeof value === "string" && value.trim() ? value : void 0;
}
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
			force: Type.Optional(Type.Boolean()),
			accountId: Type.Optional(Type.String()),
			currentQrDataUrl: Type.Optional(Type.String({
				maxLength: QR_DATA_URL_MAX_LENGTH,
				pattern: "^data:image/png;base64,"
			}))
		}),
		execute: async (_toolCallId, args) => {
			const renderQrReply = (params) => {
				return {
					content: [{
						type: "text",
						text: [
							params.message,
							"",
							"Open WhatsApp → Linked Devices and scan:",
							"",
							`![whatsapp-qr](${params.qrDataUrl})`
						].join("\n")
					}],
					details: {
						connected: params.connected ?? false,
						qr: true
					}
				};
			};
			const action = args?.action ?? "start";
			const accountId = readOptionalString(args.accountId);
			if (action === "wait") {
				const result = await waitForWebLogin({
					accountId,
					timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : void 0,
					currentQrDataUrl: readOptionalString(args.currentQrDataUrl)
				});
				if (result.qrDataUrl) return renderQrReply({
					message: result.message,
					qrDataUrl: result.qrDataUrl,
					connected: result.connected
				});
				return {
					content: [{
						type: "text",
						text: result.message
					}],
					details: { connected: result.connected }
				};
			}
			const result = await startWebLoginWithQr({
				accountId,
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
			return renderQrReply({
				message: result.message,
				qrDataUrl: result.qrDataUrl,
				connected: result.connected
			});
		}
	};
}
//#endregion
export { createWhatsAppLoginTool as t };
