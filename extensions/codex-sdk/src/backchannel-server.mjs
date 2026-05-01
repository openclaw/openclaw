#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callGateway } from "./backchannel-gateway.mjs";
import {
  authorizeGatewayMethod,
  createBackchannelSettings,
  isMethodAllowed,
  normalizeMethod,
  requiresWriteToken,
} from "./backchannel-settings.mjs";
import {
  asRecord,
  createProposalInState,
  proposalFromArgs,
  readLocalStatus,
} from "./backchannel-state.mjs";

function jsonToolResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorToolResult(error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

function listTools() {
  return {
    tools: [
      {
        name: "openclaw_status",
        description:
          "Read OpenClaw Codex runtime status, active sessions, routes, and proposal inbox.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      {
        name: "openclaw_gateway_request",
        description:
          "Call an allowed OpenClaw Gateway RPC method through the Codex backchannel. Read methods are available by default; broader writes require the configured write token.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["method"],
          properties: {
            method: { type: "string" },
            params: { type: "object" },
            writeToken: { type: "string" },
          },
        },
      },
      {
        name: "openclaw_proposal",
        description:
          "Create a proposal in the OpenClaw Codex inbox for follow-up work, handoff, or operator approval.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          properties: {
            title: { type: "string" },
            summary: { type: "string" },
            body: { type: "string" },
            actions: { type: "array", items: { type: "string" } },
            sessionKey: { type: "string" },
            routeId: { type: "string" },
            routeLabel: { type: "string" },
          },
        },
      },
    ],
  };
}

async function handleToolCall(settings, request) {
  const name = request.params?.name;
  const args = asRecord(request.params?.arguments);
  try {
    if (name === "openclaw_status") {
      try {
        return jsonToolResult(await callGateway(settings, "codex.status", {}));
      } catch (error) {
        return jsonToolResult({
          warning: error instanceof Error ? error.message : String(error),
          status: await readLocalStatus(settings),
        });
      }
    }
    if (name === "openclaw_gateway_request") {
      const method = normalizeMethod(args.method);
      if (!method) {
        throw new Error("openclaw_gateway_request requires a valid method.");
      }
      authorizeGatewayMethod(settings, method, args);
      return jsonToolResult(await callGateway(settings, method, asRecord(args.params)));
    }
    if (name === "openclaw_proposal") {
      const proposal = proposalFromArgs(args);
      if (isMethodAllowed(settings, "codex.proposal.create")) {
        try {
          return jsonToolResult(await callGateway(settings, "codex.proposal.create", proposal));
        } catch {
          return jsonToolResult(await createProposalInState(settings, proposal));
        }
      }
      return jsonToolResult(await createProposalInState(settings, proposal));
    }
    throw new Error(`Unknown OpenClaw backchannel tool: ${name}`);
  } catch (error) {
    return errorToolResult(error);
  }
}

async function main() {
  const settings = createBackchannelSettings();
  const server = new Server(
    {
      name: "openclaw-codex-backchannel",
      version: "2026.5.1",
    },
    {
      capabilities: { tools: {} },
      instructions:
        "Use these tools to keep Codex and OpenClaw synchronized. Prefer openclaw_status before making assumptions, and use openclaw_proposal for operator-visible follow-up work.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => listTools());
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleToolCall(settings, request),
  );
  await server.connect(new StdioServerTransport());
}

const mainUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === mainUrl) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}

export {
  createBackchannelSettings,
  createProposalInState,
  handleToolCall,
  isMethodAllowed,
  listTools,
  readLocalStatus,
  requiresWriteToken,
};
