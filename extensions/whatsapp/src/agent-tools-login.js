import { Type } from "@sinclair/typebox";
function createWhatsAppLoginTool() {
  return {
    label: "WhatsApp Login",
    name: "whatsapp_login",
    ownerOnly: true,
    description: "Generate a WhatsApp QR code for linking, or wait for the scan to complete.",
    // NOTE: Using Type.Unsafe for action enum instead of Type.Union([Type.Literal(...)]
    // because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
    parameters: Type.Object({
      action: Type.Unsafe({
        type: "string",
        enum: ["start", "wait"]
      }),
      timeoutMs: Type.Optional(Type.Number()),
      force: Type.Optional(Type.Boolean())
    }),
    execute: async (_toolCallId, args) => {
      const { startWebLoginWithQr, waitForWebLogin } = await import("./login-qr.js");
      const action = args?.action ?? "start";
      if (action === "wait") {
        const result2 = await waitForWebLogin({
          timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : void 0
        });
        return {
          content: [{ type: "text", text: result2.message }],
          details: { connected: result2.connected }
        };
      }
      const result = await startWebLoginWithQr({
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : void 0,
        force: typeof args.force === "boolean" ? args.force : false
      });
      if (!result.qrDataUrl) {
        return {
          content: [
            {
              type: "text",
              text: result.message
            }
          ],
          details: { qr: false }
        };
      }
      const text = [
        result.message,
        "",
        "Open WhatsApp \u2192 Linked Devices and scan:",
        "",
        `![whatsapp-qr](${result.qrDataUrl})`
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { qr: true }
      };
    }
  };
}
export {
  createWhatsAppLoginTool
};
