/**
 * AIRI Channel Plugin for OpenClaw (Native Plugin)
 *
 * Native OpenClaw extension that provides OpenAI-compatible /airi/v1/chat/completions endpoint.
 * This runs inside the OpenClaw process using the native agent invocation API (api.invokeAgent).
 *
 * Configuration (via OpenClaw config):
 * - channels.airi.token: Bearer token for auth
 * - channels.airi.defaultAgent: Default agent ID (default: kiki)
 * - channels.airi.allowedAgents: Array of allowed agent IDs
 * - channels.airi.systemPrompt: Custom system prompt for AIRI context
 */

import crypto from "crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

// Configuration defaults
const DEFAULT_TOKEN = "airi-secret-token-change-me";
const DEFAULT_AGENT = "kiki";
const DEFAULT_CONTEXT =
  "You are currently serving the AIRI system. Keep responses natural and conversational — suitable for real-time voice interaction.";

// Session storage for AIRI conversation history (in-memory)
// Using simple format for compatibility with invokeAgent
const sessionHistory = new Map<string, Array<{ role: string; content: string }>>();

// Resolve config from plugin config or environment
function resolveConfig(api: OpenClawPluginApi) {
  const pluginConfig = (api.pluginConfig as Record<string, any>) || {};

  return {
    token: pluginConfig.token || process.env.AIRI_TOKEN || DEFAULT_TOKEN,
    defaultAgent: pluginConfig.defaultAgent || process.env.AIRI_DEFAULT_AGENT || DEFAULT_AGENT,
    allowedAgents: pluginConfig.allowedAgents ||
      process.env.AIRI_ALLOWED_AGENTS?.split(",") || [DEFAULT_AGENT],
    contextInject: pluginConfig.systemPrompt || process.env.AIRI_CONTEXT_INJECT || DEFAULT_CONTEXT,
  };
}

const plugin = {
  id: "airi",
  name: "AIRI Channel",
  description: "Native OpenAI-compatible channel for AIRI voice assistant",

  register(api: OpenClawPluginApi) {
    const CONFIG = resolveConfig(api);

    // Log plugin initialization
    console.log(
      `[AIRI] ✓ Native Plugin initialized - allowed agents: ${CONFIG.allowedAgents.join(", ")}`,
    );
    api.logger.info(
      `AIRI native plugin loaded - allowed agents: ${CONFIG.allowedAgents.join(", ")}`,
    );

    // Register HTTP route for OpenAI-compatible endpoint with /airi/ prefix
    api.registerHttpRoute({
      path: "/airi/v1/chat/completions",
      auth: "plugin", // We handle auth ourselves
      match: "exact",
      handler: async (req, res) => {
        // Parse method and headers
        const method = req.method || "GET";
        const authHeader = req.headers["authorization"] || "";
        const conversationId = (req.headers["x-conversation-id"] as string) || "";

        // Bearer token auth
        if (!authHeader.startsWith("Bearer ") || authHeader.slice(7) !== CONFIG.token) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Unauthorized" } }));
          return true;
        }

        if (method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Method not allowed" } }));
          return true;
        }

        // Parse body
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }

        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
          return true;
        }

        const { messages, model, stream } = parsed;
        const requestedModel = model || CONFIG.defaultAgent;

        // Security: Validate model against allowlist
        if (!CONFIG.allowedAgents.includes(requestedModel)) {
          res.writeHead(400, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(
            JSON.stringify({
              error: {
                message: `Model '${requestedModel}' not allowed. Allowed: ${CONFIG.allowedAgents.join(", ")}`,
              },
            }),
          );
          return true;
        }

        const agentId = requestedModel;

        // Session isolation: use conversation ID or generate new session key
        const sessionKey = conversationId ? `airi:${conversationId}` : undefined; // Let invokeAgent generate a new session

        // Build messages with AIRI context - use simple object format for invokeAgent
        const systemMessage = { role: "system" as const, content: CONFIG.contextInject };

        // Get existing conversation history if session exists
        let conversationHistory: Array<{ role: string; content: string }> = [];
        const historyKey = conversationId ? `airi:${conversationId}` : null;
        if (historyKey && sessionHistory.has(historyKey)) {
          conversationHistory = sessionHistory.get(historyKey) || [];
        }

        // Add new user messages
        const userMessages = (messages || []).map((m: any) => ({
          role: m.role || "user",
          content: m.content || "",
        }));

        // Combine: system + history + new messages
        const allMessages = [systemMessage, ...conversationHistory, ...userMessages];

        if (stream) {
          // Streaming response using invokeAgentStream
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          });

          // Send role chunk first
          res.write('data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n');

          try {
            // Use the native invokeAgentStream API
            // Use the native invokeAgentStream API
            if (!api.invokeAgentStream) {
              throw new Error("invokeAgentStream is not available");
            }
            const streamResponse = await api.invokeAgentStream({
              agentId,
              messages: allMessages,
              sessionKey,
              timeoutSeconds: 60,
            });

            // Read from the stream and forward to response
            const reader = streamResponse.getReader();
            const decoder = new TextDecoder();

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              res.write(text);
            }

            res.write("data: [DONE]\n\n");
          } catch (err: any) {
            res.write(`data: {"error":{"message":"${err.message}"}}\n\n`);
            res.write("data: [DONE]\n\n");
          }

          res.end();
          return true;
        } else {
          // Non-streaming response using invokeAgent
          try {
            // Use the native invokeAgent API
            if (!api.invokeAgent) {
              throw new Error("invokeAgent is not available");
            }
            const result = await api.invokeAgent({
              agentId,
              messages: allMessages,
              sessionKey,
              timeoutSeconds: 60,
            });

            if (!result.success) {
              throw new Error(result.error || "Agent execution failed");
            }

            const responseContent = result.content || "";
            const responseReplyTag = result.replyTag;

            // Store the conversation for session continuity
            if (historyKey) {
              const updatedHistory = [
                ...conversationHistory,
                ...userMessages,
                { role: "assistant" as const, content: responseContent },
              ];
              sessionHistory.set(historyKey, updatedHistory);
            }

            // Format OpenAI-compatible response
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: agentId,
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: responseContent },
                    finish_reason: "stop",
                  },
                ],
                ...(responseReplyTag?.hasReplyTag ? { replyTag: responseReplyTag } : {}),
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              }),
            );
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: err.message } }));
          }
          return true;
        }
      },
    });

    // Health check endpoint
    api.registerHttpRoute({
      path: "/airi/health",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            service: "airi-native-channel",
            version: "2.0.0-native-api",
          }),
        );
        return true;
      },
    });

    // Models list endpoint
    api.registerHttpRoute({
      path: "/airi/v1/models",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: CONFIG.allowedAgents.map((id: string) => ({
              id,
              object: "model",
              created: Date.now(),
              owned_by: "openclaw",
            })),
          }),
        );
        return true;
      },
    });
  },
};

export default plugin;
