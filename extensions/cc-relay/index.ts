import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginToolContext, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/core";
import { resolveConfig } from "./src/config.js";
import { createCcDispatchTool } from "./src/cc-dispatch-tool.js";
import { CcRelayDispatcher } from "./src/dispatcher.js";
import { getPromptDirective } from "./src/prompt-directives.js";

/**
 * cc-relay plugin
 *
 * Bridges OpenClaw agents to Claude Code CLI, enabling an architecture where
 * the agent can delegate work to a local Claude Code process.
 *
 * Three modes (configured via `mode` in plugin config):
 *
 * - **relay**:    Agent forwards ALL user requests to CC. The SOUL personality
 *                 and memory are fully preserved — only a behavioral directive
 *                 is appended via the `before_prompt_build` hook. No SOUL.md
 *                 changes required.
 *
 * - **hybrid**:   (default) Agent decides when to use CC. A softer hint is
 *                 injected suggesting CC for complex tasks.
 *
 * - **tool-only**: The `cc_dispatch` tool is registered with no prompt changes.
 *                  The agent uses CC only if its SOUL or the user asks.
 *
 * Inspired by the T800 bridge architecture.
 */
const plugin = {
  id: "cc-relay",
  name: "Claude Code Relay",
  description:
    "Dispatches agent tasks to a local Claude Code CLI process and relays results back to the channel.",

  register(api: OpenClawPluginApi) {
    if (api.registrationMode !== "full") return;

    const pluginConfig = resolveConfig(api.pluginConfig);
    let dispatcher: CcRelayDispatcher | null = null;

    // ── Hook: inject behavioral directive into the system prompt ──
    // This is the key design: instead of replacing SOUL.md, we APPEND a
    // directive that tells the agent how to use the cc_dispatch tool.
    // The agent's personality, memory, and identity remain fully intact.
    const directive = getPromptDirective(pluginConfig.mode);
    if (directive) {
      api.on("before_prompt_build", () => {
        return { appendSystemContext: directive };
      });
    }

    // ── Tool: register cc_dispatch via factory ──
    api.registerTool(((ctx: OpenClawPluginToolContext) => {
      if (!dispatcher) {
        dispatcher = new CcRelayDispatcher(
          {
            ...pluginConfig,
            workdir: pluginConfig.workdir || ctx.workspaceDir || process.cwd(),
          },
          {
            sendMessage: createMessageSender(api),
            sendFile: createFileSender(api),
          },
        );
      }

      const channel = ctx.messageChannel ?? ctx.deliveryContext?.channel ?? "";
      const target = ctx.deliveryContext?.to ?? "";
      return createCcDispatchTool(() => dispatcher, channel, target);
    }) as OpenClawPluginToolFactory);

    // ── Service: manage dispatcher lifecycle ──
    api.registerService({
      id: "cc-relay-dispatcher",
      start: async () => {
        api.logger.info(`[cc-relay] Service started (mode: ${pluginConfig.mode})`);
      },
      stop: async () => {
        if (dispatcher) {
          dispatcher.stop();
          dispatcher = null;
        }
        api.logger.info("[cc-relay] Service stopped");
      },
    });
  },
};

export default plugin;

/**
 * Create a message sender using the outbound adapter system.
 */
function createMessageSender(
  api: OpenClawPluginApi,
): (channel: string, target: string, text: string) => Promise<void> {
  return async (channel, target, text) => {
    try {
      const adapter = await api.runtime.channel.outbound.loadAdapter(channel);
      const send = adapter?.sendText;
      if (!send) {
        api.logger.warn(`[cc-relay] No outbound adapter for channel: ${channel}`);
        return;
      }
      await send({ cfg: api.config, to: target, text });
    } catch (err) {
      api.logger.warn(`[cc-relay] Failed to send message: ${err}`);
    }
  };
}

/**
 * Create a file sender using the outbound adapter system.
 */
function createFileSender(
  api: OpenClawPluginApi,
): (channel: string, target: string, filePath: string, fileName: string) => Promise<void> {
  return async (channel, target, filePath, fileName) => {
    try {
      const adapter = await api.runtime.channel.outbound.loadAdapter(channel);
      if (adapter?.sendMedia) {
        await adapter.sendMedia({
          cfg: api.config,
          to: target,
          text: fileName,
          mediaUrl: `file://${filePath}`,
          mediaLocalRoots: [filePath.replace(/[/\\][^/\\]*$/, "")],
        });
      } else if (adapter?.sendText) {
        await adapter.sendText({ cfg: api.config, to: target, text: `[File: ${fileName}]` });
      }
    } catch (err) {
      api.logger.warn(`[cc-relay] Failed to send file ${fileName}: ${err}`);
    }
  };
}
