import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { z } from "zod";
import { autofillBrowserGuidance } from "./autofill-browser.js";
import { accessRequestInputSchema } from "./autofill-input.js";
import { AutofillError } from "./autofill-relay.js";
import type { AutofillAuthority, AutofillService } from "./autofill-service.js";

const id = z.string().min(1).max(256);
const toolInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect"), sessionId: id.optional() }).strict(),
  z.object({ action: z.literal("disconnect") }).strict(),
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("request_logins"), requests: accessRequestInputSchema }).strict(),
  z
    .object({
      action: z.literal("check_status"),
      requestId: id,
      approvalOpened: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("fill"),
      requestId: id,
      entryId: id,
      tab: z.object({ targetId: id, profile: id.optional() }).strict(),
    })
    .strict(),
]);

/** Optional sibling: never broadens the service-account tool's curated-secret policy hook. */
export function createAutofillTool(
  service: AutofillService,
  context: OpenClawPluginToolContext<2>,
  inlineView: OpenClawPluginApi["inlineView"],
): AnyAgentTool {
  const scope = JSON.stringify([context.sessionKey, context.sessionId]);
  const authority: AutofillAuthority = {
    assertCurrent() {
      context.assertInvocationCurrent();
      // Agent ids and channel sender strings are not human principals. This preview is owner-only.
      if (context.senderIsOwner !== true || !context.sessionKey || !context.sessionId) {
        throw new AutofillError("gatewayOwnerRequired");
      }
    },
  };
  return {
    name: "onepassword_autofill",
    label: "1Password Agentic Autofill",
    description:
      "Connect your own 1Password, request task-specific logins, check approval, or fill and submit a granted login. Never returns passwords. Owner-only preview; configure the managed browser profile. Approval requires the OpenClaw Control UI on a computer with 1Password.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["connect", "disconnect", "status", "request_logins", "check_status", "fill"],
        },
        sessionId: {
          type: "string",
          description: "Connect session from an earlier connect call; omit to start consent.",
        },
        requests: {
          type: "object",
          additionalProperties: false,
          required: ["version", "goal", "entries"],
          properties: {
            version: { type: "integer", const: 2 },
            goal: { type: "string", minLength: 1, maxLength: 140 },
            entries: {
              type: "array",
              minItems: 1,
              maxItems: 5,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["type", "parameters", "reason"],
                properties: {
                  type: { type: "string", const: "login" },
                  parameters: {
                    type: "object",
                    additionalProperties: false,
                    required: ["website"],
                    properties: {
                      website: {
                        type: "string",
                        maxLength: 2083,
                        description: "Complete HTTPS sign-in website; no credentials in URLs.",
                      },
                    },
                  },
                  reason: { type: "string", minLength: 1, maxLength: 100 },
                  keywords: {
                    type: "array",
                    maxItems: 5,
                    items: { type: "string", minLength: 1, maxLength: 50 },
                  },
                },
              },
            },
          },
        },
        requestId: { type: "string" },
        entryId: { type: "string" },
        approvalOpened: {
          type: "boolean",
          description:
            "Set true only after the user explicitly confirms opening the approval link (or says they approved). Waits up to two minutes on the first call.",
        },
        tab: {
          type: "object",
          additionalProperties: false,
          required: ["targetId"],
          properties: { targetId: { type: "string" }, profile: { type: "string" } },
        },
      },
    },
    async execute(_toolCallId, params, signal) {
      const invocation = { ...authority, signal };
      try {
        authority.assertCurrent();
        const parsed = toolInput.safeParse(params);
        if (!parsed.success) {
          throw new AutofillError("invalidRequest");
        }
        const input = parsed.data;
        switch (input.action) {
          case "connect":
            return jsonResult(
              input.sessionId
                ? await service.pickup(input.sessionId, invocation)
                : await service.connect(invocation),
            );
          case "disconnect":
            return jsonResult(await service.disconnect(invocation));
          case "status":
            return jsonResult(await service.status(invocation));
          case "request_logins": {
            const request = await service.requestLogins(input.requests, scope, invocation);
            authority.assertCurrent();
            return inlineView(
              "approval",
              { requestId: request.requestId },
              {
                version: 1,
                summary: `1Password approval requested for ${request.entries.map((entry) => new URL(entry.website).hostname).join(", ")}. Open the approval card in OpenClaw’s Control UI.`,
              },
            );
          }
          case "check_status":
            return jsonResult(
              await service.checkStatus(
                input.requestId,
                scope,
                input.approvalOpened === true,
                invocation,
              ),
            );
          case "fill":
            return jsonResult(
              await service.fill(input.requestId, input.entryId, input.tab, scope, invocation),
            );
          default:
            throw new AutofillError("invalidRequest");
        }
      } catch (error) {
        // Do not serialize arbitrary exceptions, adapter messages, or validation inputs.
        const code = error instanceof AutofillError ? error.code : "operationFailed";
        return jsonResult({
          state: "error",
          code,
          guidance:
            code === "reconnectRequired"
              ? "The connection ended. Connect 1Password again."
              : code === "extensionNotReady"
                ? autofillBrowserGuidance
                : "The operation did not complete. Check Agentic Autofill setup or reconnect; no secret details were returned.",
        });
      }
    },
  };
}
