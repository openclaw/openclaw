/**
 * OpenClaw AgentExecutor — bridges inbound A2A tasks to OpenClaw agent sessions.
 *
 * Uses the Gateway's OpenAI-compatible /v1/chat/completions endpoint to
 * dispatch messages to the local agent. This avoids relying on internal
 * PluginRuntime APIs and uses a stable public interface.
 */

import type { Message, Part } from "@a2a-js/sdk";
import type { AgentExecutor, RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import type { A2APluginConfig } from "./config.js";

// ── Types ──────────────────────────────────────────────────────────

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

// ── Helpers ────────────────────────────────────────────────────────

/** Extract plain text from A2A Message parts. */
function extractText(message: Message): string {
  if (!message.parts || !Array.isArray(message.parts)) return "";
  return message.parts
    .filter((p: Part) => p.kind === "text")
    .map((p) => ("text" in p ? (p as { text: string }).text : ""))
    .join("\n")
    .trim();
}

/**
 * Resolve the target OpenClaw agentId for an inbound A2A request.
 * Checks the standard metadata extension field for routing.
 */
function resolveAgentId(message: Message, defaultAgentId: string): string {
  const meta = message.metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta["openclaw.agentId"] === "string") {
    const id = (meta["openclaw.agentId"] as string).trim();
    if (id) return id;
  }
  return defaultAgentId;
}

/** Build a v0.3.0 Message object for event publishing. */
function makeMessage(role: "agent" | "user", text: string): Message {
  return {
    kind: "message",
    messageId: crypto.randomUUID(),
    role,
    parts: [{ kind: "text", text }],
  };
}

// ── Executor ───────────────────────────────────────────────────────

export class OpenClawAgentExecutor implements AgentExecutor {
  constructor(
    private readonly cfg: A2APluginConfig,
    private readonly gatewayBaseUrl: string,
    private readonly gatewayAuthToken: string | undefined,
    private readonly log: Logger,
  ) {}

  async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const text = extractText(ctx.userMessage);
    if (!text) {
      this.publishFinal(eventBus, ctx, "failed", "Empty message — nothing to process.");
      return;
    }

    const agentId = resolveAgentId(ctx.userMessage, this.cfg.routing.defaultAgentId);

    try {
      // Mark task as working
      eventBus.publish({
        kind: "status-update",
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        final: false,
        status: {
          state: "working",
          message: makeMessage("agent", "Processing..."),
        },
      });

      // Call local Gateway via OpenAI-compatible endpoint
      const replyText = await this.callLocalAgent(text, agentId);
      this.publishFinal(eventBus, ctx, "completed", replyText);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log.error(`[a2a] executor error for task ${ctx.taskId}: ${errMsg}`);
      this.publishFinal(eventBus, ctx, "failed", `Error: ${errMsg}`);
    } finally {
      eventBus.finished();
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    this.log.info(`[a2a] cancel requested for task ${taskId}`);
    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId: taskId,
      final: true,
      status: { state: "canceled" },
    });
    eventBus.finished();
  }

  // ── Internal ───────────────────────────────────────────────────

  /**
   * Call the local Gateway's OpenAI-compatible /v1/chat/completions endpoint.
   * This is a stable public API that handles routing, model selection, etc.
   */
  private async callLocalAgent(message: string, agentId: string): Promise<string> {
    const url = `${this.gatewayBaseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Use gateway auth if available
    if (this.gatewayAuthToken) {
      headers.Authorization = `Bearer ${this.gatewayAuthToken}`;
    }

    const body = {
      model: agentId,
      messages: [{ role: "user", content: message }],
      stream: false,
    };

    const timeoutMs = this.cfg.timeouts.agentResponseMs;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Gateway returned ${res.status}: ${errBody.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Gateway returned empty response");
    }
    return content;
  }

  private publishFinal(
    eventBus: ExecutionEventBus,
    ctx: RequestContext,
    state: "completed" | "failed",
    text: string,
  ): void {
    eventBus.publish({
      kind: "status-update",
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      final: true,
      status: {
        state,
        message: makeMessage("agent", text),
      },
    });
  }
}
