import {
  optionalPositiveIntegerSchema,
  readPositiveIntegerParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { ChannelAgentTool } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { readNonBlankString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { startWebLoginWithQr, waitForWebLogin } from "../login-qr-api.js";

const QR_DATA_URL_MAX_LENGTH = 16_384;

export function createWhatsAppLoginTool(
  context: OpenClawPluginToolContext,
): ChannelAgentTool | null {
  if (context.senderIsOwner !== true) {
    return null;
  }
  return {
    label: "WhatsApp Login",
    name: "whatsapp_login",
    description: "Generate a WhatsApp QR code for linking, or wait for the scan to complete.",
    parameters: Type.Object({
      action: Type.Enum(["start", "wait"], { type: "string" }),
      timeoutMs: optionalPositiveIntegerSchema(),
      force: Type.Optional(Type.Boolean()),
      accountId: Type.Optional(Type.String()),
      currentQrDataUrl: Type.Optional(
        Type.String({
          maxLength: QR_DATA_URL_MAX_LENGTH,
          // llama.cpp rejects a whole tool catalog when a model-facing pattern
          // lacks either anchor; real QR images also require a nonempty payload.
          pattern: "^data:image/png;base64,.+$",
        }),
      ),
    }),
    execute: async (_toolCallId, args, signal) => {
      const beforeCredentialPersistence = async () => {
        context.assertInvocationCurrent?.();
        if (!signal || signal.aborted) {
          throw new Error("WhatsApp login authority is no longer active.");
        }
      };
      const renderReply = (
        params: { message: string; qrDataUrl?: string; connected?: boolean },
        noQrDetails: { connected: boolean } | { qr: false },
      ) => {
        if (!params.qrDataUrl) {
          return textResult(params.message, noQrDetails);
        }
        const text = [
          params.message,
          "",
          "Open WhatsApp → Linked Devices and scan:",
          "",
          `![whatsapp-qr](${params.qrDataUrl})`,
        ].join("\n");
        return textResult(text, {
          connected: params.connected ?? false,
          qr: true,
        });
      };

      const action = (args as { action?: string })?.action ?? "start";
      const accountId = readNonBlankString((args as { accountId?: unknown }).accountId);
      const timeoutMs = readPositiveIntegerParam(args as Record<string, unknown>, "timeoutMs");
      if (action === "wait") {
        const result = await waitForWebLogin({
          accountId,
          timeoutMs,
          currentQrDataUrl: readNonBlankString(
            (args as { currentQrDataUrl?: unknown }).currentQrDataUrl,
          ),
        });
        return renderReply(result, { connected: result.connected });
      }

      await beforeCredentialPersistence();
      const result = await startWebLoginWithQr({
        accountId,
        timeoutMs,
        beforeCredentialPersistence,
        force:
          typeof (args as { force?: unknown }).force === "boolean"
            ? (args as { force?: boolean }).force
            : false,
      });

      return renderReply(result, { qr: false });
    },
  };
}

export function registerWhatsAppLoginTool(api: OpenClawPluginApi): void {
  api.registerTool(
    { contextVersion: 2, create: (context) => createWhatsAppLoginTool(context) },
    { name: "whatsapp_login" },
  );
}
