import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolFactory } from "./runtime-api.js";
import { AnticipationEngine } from "./src/anticipation-engine.js";
import {
  createInsightsTool,
  createLearnPreferenceTool,
  createPatternsTool,
} from "./src/intel-tools.js";
import { PatternDetector } from "./src/pattern-detector.js";

export default definePluginEntry({
  id: "proactive-intel",
  name: "Proactive Intelligence",
  description: "Learns interaction patterns and proactively surfaces relevant context",
  register(api: OpenClawPluginApi) {
    const pluginConfig = api.pluginConfig ?? {};

    const detector = new PatternDetector({
      maxInteractions: 500,
      maxPatterns: typeof pluginConfig.maxPatterns === "number" ? pluginConfig.maxPatterns : 100,
      minOccurrences:
        typeof pluginConfig.minInteractionsForPattern === "number"
          ? pluginConfig.minInteractionsForPattern
          : 5,
    });

    const engine = new AnticipationEngine(detector);

    // Register `insights` tool
    api.registerTool(
      ((ctx) => {
        if (ctx.sandboxed) return null;
        return createInsightsTool(detector, engine) as AnyAgentTool;
      }) as OpenClawPluginToolFactory,
      { optional: true },
    );

    // Register `my_patterns` tool
    api.registerTool(
      ((ctx) => {
        if (ctx.sandboxed) return null;
        return createPatternsTool(detector) as AnyAgentTool;
      }) as OpenClawPluginToolFactory,
      { optional: true },
    );

    // Register `learn_preference` tool
    api.registerTool(
      ((ctx) => {
        if (ctx.sandboxed) return null;
        return createLearnPreferenceTool(detector) as AnyAgentTool;
      }) as OpenClawPluginToolFactory,
      { optional: true },
    );

    // Hook: learn from inbound messages (passive observation)
    api.on("message_received", (event, ctx) => {
      const content = event?.content;
      const channelId = ctx?.channelId ?? "unknown";
      if (content && typeof content === "string" && content.length > 2) {
        detector.recordInteraction({
          message: content,
          channelId,
          agentId: "main",
        });
      }
    });

    // Hook: enrich agent context with proactive insights
    if (pluginConfig.contextEnrichment !== false) {
      api.on("before_prompt_build", (_event, _ctx) => {
        const contextEnrichment = engine.getContextEnrichment();
        if (contextEnrichment) {
          return { appendSystemContext: contextEnrichment };
        }
        return {};
      });
    }
  },
});
