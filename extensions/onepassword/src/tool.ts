import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  asNonArrayRecord,
  asRecord,
  readStringField,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { parseToolInput, type OnePasswordBroker } from "./broker.js";
import { AUTHORIZATION_NONCE_PARAM } from "./pending-authorization.js";

const OnePasswordToolSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["list", "get"],
      description: "List registered secret slugs or get one registered secret.",
    },
    slug: {
      type: "string",
      pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
      description: "Registered secret slug. Required for get.",
    },
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 300,
      description: "Why the agent needs this secret. Required for get.",
    },
    authorizationNonce: {
      type: "string",
      description: "Internal. Injected by the gateway policy layer; never set this manually.",
    },
  },
} satisfies AnyAgentTool["parameters"];

function errorResult(error: unknown) {
  const code = readStringField(asRecord(error), "code") ?? "OP_ERROR";
  const message = error instanceof Error ? error.message : "1Password request failed";
  return jsonResult({ ok: false, error: { code, message } });
}

export function createOnePasswordTool(
  broker: OnePasswordBroker,
  invocation: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "onepassword",
    label: "1Password",
    description:
      "List curated 1Password secret slugs or retrieve one secret under its configured access policy.",
    parameters: OnePasswordToolSchema,
    execute: async (toolCallId, rawParams) => {
      const params = asNonArrayRecord(rawParams);
      try {
        const input = parseToolInput(params);
        if (input.action === "list") {
          return jsonResult({ ok: true, items: await broker.list(invocation) });
        }
        const nonceValue = params[AUTHORIZATION_NONCE_PARAM];
        const nonce = typeof nonceValue === "string" ? nonceValue : undefined;
        const secret = await broker.get(toolCallId, input, invocation, nonce);
        return jsonResult({ ok: true, ...secret });
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}
