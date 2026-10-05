import {
  definePluginEntry,
  type OpenClawPluginServiceContextV2,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveMcpEventsConfig } from "./src/config.js";
import { createCallbackHandler } from "./src/http.js";
import { CALLBACK_PREFIX, MCP_EVENTS_PROFILE, record } from "./src/protocol.js";
import { McpEventsService } from "./src/service.js";
import type { EventCron } from "./src/types.js";

function currentCron(context: OpenClawPluginServiceContextV2): EventCron {
  const cron = context.getCron?.();
  if (!cron?.readEventSources || !cron.runEvent) {
    throw new Error("MCP Events requires Gateway event-driven automation admission");
  }
  return { readEventSources: cron.readEventSources, runEvent: cron.runEvent };
}

export default definePluginEntry({
  id: "mcp-events",
  name: "MCP Events",
  description: "Authenticated MCP webhook events for authored automations.",
  configSchema: { parse: resolveMcpEventsConfig },
  register(api) {
    api.registerTool(
      {
        contextVersion: 2,
        create: (context) => ({
          name: "mcp_events",
          label: "MCP Events",
          description:
            "List webhook events and subscription argument schemas from a configured MCP server. Use the descriptors to create an Automation event source; this tool does not schedule or subscribe by itself. Pass nextCursor as cursor for another page.",
          parameters: {
            type: "object",
            properties: {
              serverName: { type: "string", minLength: 1, maxLength: 256 },
              cursor: { type: "string", minLength: 1, maxLength: 16384 },
            },
            required: ["serverName"],
            additionalProperties: false,
          },
          execute: async (_id, input) => {
            context.assertInvocationCurrent();
            const params = record(input);
            if (
              !params ||
              typeof params.serverName !== "string" ||
              !params.serverName.trim() ||
              (params.cursor !== undefined && typeof params.cursor !== "string")
            ) {
              throw new Error("Expected a configured serverName and optional cursor");
            }
            const result = await api.runtime.gateway.request("mcp.events.list", {
              agentId: context.agentId,
              serverName: params.serverName,
              ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
            });
            context.assertInvocationCurrent();
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
          },
        }),
      },
      { names: ["mcp_events"] },
    );
    if (api.registrationMode !== "full") {
      return;
    }
    let service: McpEventsService | undefined;
    api.registerHttpRoute({
      path: CALLBACK_PREFIX,
      auth: "plugin",
      match: "prefix",
      handler: createCallbackHandler(() => service),
    });
    // Hooks carry change notifications, never retained caller-scoped scheduler handles.
    api.on("cron_changed", (event) => {
      if (event.action === "finished") {
        service?.requestDrain(event.jobId);
      } else if (
        event.action === "added" ||
        event.action === "updated" ||
        event.action === "removed"
      ) {
        service?.requestReconcile();
      }
    });
    api.on("cron_reconciled", () => {
      service?.requestReconcile();
    });
    api.registerGatewayMethod(
      "mcp-events.status",
      ({ respond }) => {
        respond(true, {
          running: Boolean(service),
          profile: MCP_EVENTS_PROFILE,
          subscriptions: service?.diagnostics() ?? [],
        });
      },
      { scope: "operator.admin" },
    );
    api.registerService({
      id: "mcp-events",
      apiVersion: 2,
      reload: { configPrefixes: ["plugins.entries.mcp-events", "mcp"] },
      async start(context: OpenClawPluginServiceContextV2) {
        const config = resolveMcpEventsConfig(
          context.config.plugins?.entries?.["mcp-events"]?.config,
        );
        if (!context.mcpEvents?.prepareSource) {
          throw new Error(
            "MCP Events requires the Gateway's source authority and scheduler capabilities",
          );
        }
        currentCron(context);
        const active = new McpEventsService({
          runtime: api.runtime,
          config,
          scheduler: context.scheduler,
          prepareSource: context.mcpEvents.prepareSource,
          // Reacquire after Cron reconciliation: each native facade owns one scheduler lifetime.
          cron: {
            readEventSources: () => currentCron(context).readEventSources(),
            runEvent: (id, input) => currentCron(context).runEvent(id, input),
          },
          logger: context.logger,
        });
        // Verification can arrive during the first subscribe request, before start resolves.
        service = active;
        try {
          await active.start();
        } catch (error) {
          if (service === active) {
            service = undefined;
          }
          await active.stop();
          throw error;
        }
      },
      async stop() {
        const active = service;
        service = undefined;
        await active?.stop();
      },
    });
  },
});
