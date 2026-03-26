/**
 * AOP Observability Bridge — subscribes to all upstream plugin hooks and
 * diagnostic events, forwards them to the AOP Server.
 *
 * Replaces the fork's:
 * - hook_emitter.py (Claude Code hook handler)
 * - shipper.py (event shipper daemon)
 * - shared/logger.py event emission
 *
 * With a single in-process extension that uses upstream's native hook system.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { EventBuffer, type AopEvent } from "./src/event-buffer.js";

export default definePluginEntry({
  id: "observability-aop",
  name: "AOP Observability Bridge",
  description: "Bridges upstream hooks to AOP Server for fleet-wide observability",
  register(api) {
    const pluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
    const aopUrl =
      (pluginConfig?.aopServerUrl as string) ||
      process.env.AOP_SERVER_URL ||
      "http://100.69.32.10:3010";
    const nodeName =
      (pluginConfig?.nodeName as string) || process.env.WORKER_NODE_NAME || "unknown";
    const batchSize = (pluginConfig?.batchSize as number) || 10;
    const flushIntervalMs = (pluginConfig?.flushIntervalMs as number) || 5000;

    const buffer = new EventBuffer(aopUrl, batchSize, flushIntervalMs, api.logger);

    function emit(eventType: string, data: Partial<AopEvent>): void {
      buffer.push({
        timestamp: new Date().toISOString(),
        event_type: eventType,
        source_node: nodeName,
        ...data,
      });
    }

    // Session lifecycle
    api.on("session_start", async (event) => {
      const ev = event as Record<string, unknown>;
      emit("session.start", {
        session_key: ev.sessionKey as string,
        session_id: ev.sessionId as string,
        agent_id: ev.agentId as string,
        workspace_dir: ev.workspaceDir as string,
        trigger: ev.trigger as string,
        channel_id: ev.channelId as string,
      });
    });

    api.on("session_end", async (event) => {
      const ev = event as Record<string, unknown>;
      emit("session.end", {
        session_key: ev.sessionKey as string,
        session_id: ev.sessionId as string,
        duration_ms: ev.durationMs as number,
      });
    });

    // Tool lifecycle
    api.on("before_tool_call", async (event) => {
      const ev = event as Record<string, unknown>;
      emit("tool.call.before", {
        session_key: ev.sessionKey as string,
        payload: { toolName: ev.toolName, args: ev.args },
      });
    });

    api.on("after_tool_call", async (event) => {
      const ev = event as Record<string, unknown>;
      emit("tool.call.after", {
        session_key: ev.sessionKey as string,
        duration_ms: ev.durationMs as number,
        success: ev.success as boolean,
        payload: { toolName: ev.toolName },
      });
    });

    // Subagent lifecycle
    api.on("subagent_spawned", async (event) => {
      const ev = event as Record<string, unknown>;
      emit("subagent.spawned", {
        session_key: ev.sessionKey as string,
        payload: { childSessionKey: ev.childSessionKey, childAgentId: ev.childAgentId },
      });
    });

    api.on("subagent_ended", async (event) => {
      const ev = event as Record<string, unknown>;
      emit("subagent.ended", {
        session_key: ev.sessionKey as string,
        duration_ms: ev.durationMs as number,
        success: ev.success as boolean,
      });
    });

    // LLM usage
    api.on("llm_output", async (event) => {
      const ev = event as Record<string, unknown>;
      emit("model.usage", {
        session_key: ev.sessionKey as string,
        model: ev.model as string,
        provider: ev.provider as string,
        tokens_input: ev.tokensInput as number,
        tokens_output: ev.tokensOutput as number,
        tokens_cache_read: ev.tokensCacheRead as number,
        tokens_cache_write: ev.tokensCacheWrite as number,
        cost_usd: ev.costUsd as number,
        duration_ms: ev.durationMs as number,
      });
    });

    // Message lifecycle
    api.on("message_received", async (event) => {
      const ev = event as Record<string, unknown>;
      emit("message.received", {
        session_key: ev.sessionKey as string,
        channel_id: ev.channelId as string,
      });
    });

    api.on("message_sent", async (event) => {
      const ev = event as Record<string, unknown>;
      emit("message.sent", {
        session_key: ev.sessionKey as string,
        channel_id: ev.channelId as string,
      });
    });

    // Gateway lifecycle
    api.on("gateway_start", async () => {
      emit("gateway.start", {});
    });

    api.on("gateway_stop", async () => {
      emit("gateway.stop", {});
      await buffer.stop();
    });

    // Compaction events
    api.on("before_compaction", async (event) => {
      const ev = event as Record<string, unknown>;
      emit("session.compaction", {
        session_key: ev.sessionKey as string,
        payload: { reason: ev.reason },
      });
    });

    api.logger.info(`observability-aop: forwarding events from ${nodeName} to ${aopUrl}`);
  },
});
