import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createClaworksRuntime,
  startClaworksRuntime,
  stopClaworksRuntime,
  createA2aHttpHandler,
  createClaworksRestHandler,
  createMcpHttpHandler,
  serveClaworksStudio,
  bridgeChannelMessageReceived,
  type ClaworksRobotConfig,
  type ClaworksRuntime,
} from "@claworks/runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createClaworksBridge } from "./bridge.js";
import { registerClaworksAgentTools } from "./cw-tools.js";
import { createMemoryKnowledgeBase } from "./memory-kb.js";

let runtime: ClaworksRuntime | null = null;

function resolveRobotConfig(api: OpenClawPluginApi): ClaworksRobotConfig {
  const raw = api.pluginConfig as ClaworksRobotConfig | undefined;
  return raw ?? {};
}

function registerRoutes(api: OpenClawPluginApi): void {
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    if (await serveClaworksStudio(req, res)) {
      return true;
    }
    if (!runtime) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "ClaWorks runtime not ready", code: "NOT_READY" }));
      return true;
    }
    const handled = await createClaworksRestHandler(runtime)(req, res);
    return handled;
  };

  api.registerHttpRoute({
    path: "/studio",
    auth: "plugin",
    match: "prefix",
    replaceExisting: true,
    handler,
  });

  api.registerHttpRoute({
    path: "/v1",
    auth: "plugin",
    match: "prefix",
    replaceExisting: true,
    handler,
  });

  api.registerHttpRoute({
    path: "/.well-known/agent.json",
    auth: "plugin",
    match: "exact",
    replaceExisting: true,
    handler: async (req, res) => {
      req.url = "/v1/.well-known/agent.json";
      return handler(req, res);
    },
  });

  const a2aHandler = createA2aHttpHandler(() => runtime);
  api.registerHttpRoute({
    path: "/a2a",
    auth: "plugin",
    match: "prefix",
    replaceExisting: true,
    handler: a2aHandler,
  });

  const mcpHandler = createMcpHttpHandler(() => runtime);
  api.registerHttpRoute({
    path: "/mcp",
    auth: "plugin",
    match: "prefix",
    replaceExisting: true,
    handler: mcpHandler,
  });
}

export default definePluginEntry({
  id: "claworks-robot",
  name: "ClaWorks Robot",
  description: "ClaWorks industrial robot runtime — EventKernel · DataPlane · OrchPlane · A2A",
  register(api: OpenClawPluginApi) {
    api.registerService({
      id: "claworks-kernel",
      start: async () => {
        const robotConfig = resolveRobotConfig(api);
        const kb =
          robotConfig.data?.kb_provider === "memory-core"
            ? await createMemoryKnowledgeBase(api, {
                agentId: robotConfig.data?.memory_agent_id,
              })
            : undefined;
        const bridge = createClaworksBridge({
          api,
          robotConfig,
          getRuntime: () => runtime,
        });
        runtime = await createClaworksRuntime(robotConfig, {
          version: "2026.5.0-alpha.1",
          logger: (msg) => api.logger.info?.(`[claworks-robot] ${msg}`),
          kb,
          hitl: bridge.createHitlGate(),
          llmComplete: bridge.llmComplete,
          subagentRun: bridge.runSubagent,
          skillRun: bridge.runSkill,
          notify: bridge.notify,
        });
        await startClaworksRuntime(runtime);
        api.logger.info?.(
          `[claworks-robot] started robot=${runtime.robot.name} role=${runtime.robot.role}`,
        );
      },
      stop: async () => {
        if (runtime) {
          await stopClaworksRuntime(runtime);
          runtime = null;
        }
      },
    });
    registerRoutes(api);
    registerClaworksAgentTools(api, () => runtime);

    const autoImBridge = resolveRobotConfig(api).im_bridge?.auto_on_message_received === true;
    if (autoImBridge) {
      api.on("message_received", async (event, ctx) => {
        const rt = runtime;
        if (!rt) {
          return;
        }
        try {
          await bridgeChannelMessageReceived(rt, {
            channelId: ctx.channelId,
            conversationId: ctx.conversationId,
            senderId: event.senderId ?? ctx.senderId,
            messageId: event.messageId ?? ctx.messageId,
            text: event.content,
            metadata: event.metadata,
          });
        } catch (err) {
          api.logger.warn?.(
            `[claworks-robot] im auto-bridge failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
      api.logger.info?.("[claworks-robot] IM auto-bridge enabled (message_received hook)");
    }
  },
});
