import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { PromptGuardConfig } from "./config.js";
import type { PromptGuardClient } from "./guard-client.js";

export function createBeforeAgentReplyHandler(
  client: PromptGuardClient,
  config: PromptGuardConfig,
  logger: PluginLogger,
) {
  return async (
    event: { cleanedBody: string },
    _ctx: unknown,
  ): Promise<{ handled: boolean; reply?: { text: string }; reason?: string } | void> => {
    if (!config.scanInputs) return;

    const text = event.cleanedBody?.trim();
    if (!text) return;

    try {
      const result = await client.guard({
        content: text,
        direction: "input",
        detectors: config.detectors,
      });

      if (result.decision === "block") {
        const threat = result.threat_type ?? "security threat";
        logger.warn(`[promptguard] Blocked input: ${threat} (confidence: ${result.confidence})`);

        if (config.mode === "enforce") {
          return {
            handled: true,
            reply: {
              text: `PromptGuard blocked this message: **${threat}** detected. If you believe this is a false positive, contact your administrator.`,
            },
            reason: `promptguard:${threat}`,
          };
        }

        logger.info(`[promptguard] Monitor mode -- threat logged but not blocked: ${threat}`);
      }
    } catch (err) {
      logger.warn(`[promptguard] Input scan failed (fail-open): ${err}`);
    }
  };
}

export function createBeforeToolCallHandler(
  client: PromptGuardClient,
  config: PromptGuardConfig,
  logger: PluginLogger,
) {
  return async (
    event: { toolName: string; params: Record<string, unknown> },
    _ctx: unknown,
  ): Promise<{ block?: boolean; blockReason?: string } | void> => {
    if (!config.scanToolArgs) return;

    try {
      const result = await client.validateTool({
        tool_name: event.toolName,
        arguments: event.params,
      });

      if (!result.allowed) {
        const reason = result.reason ?? "suspicious tool arguments";
        logger.warn(
          `[promptguard] Tool ${event.toolName} flagged: ${reason} (risk: ${result.risk_level})`,
        );

        if (config.mode === "enforce") {
          return {
            block: true,
            blockReason: `PromptGuard: ${reason}`,
          };
        }

        logger.info(`[promptguard] Monitor mode -- tool call logged but not blocked`);
        return { block: false };
      }
    } catch (err) {
      logger.warn(`[promptguard] Tool validation failed (fail-open): ${err}`);
    }
  };
}

export function createMessageSendingHandler(
  client: PromptGuardClient,
  config: PromptGuardConfig,
  logger: PluginLogger,
) {
  return async (
    event: { content: string; to: string },
    _ctx: unknown,
  ): Promise<{ content?: string } | void> => {
    if (!config.redactPii) return;

    const text = event.content?.trim();
    if (!text) return;

    try {
      const result = await client.redact({ content: text });
      if (result.redacted !== text) {
        const entityCount = result.entities?.length ?? 0;
        logger.info(`[promptguard] Redacted ${entityCount} PII entities from outgoing message`);
        return { content: result.redacted };
      }
    } catch (err) {
      logger.warn(`[promptguard] PII redaction failed (fail-open): ${err}`);
    }
  };
}

export function createLlmInputHandler(
  client: PromptGuardClient,
  config: PromptGuardConfig,
  logger: PluginLogger,
) {
  return async (event: { prompt: string }, _ctx: unknown): Promise<void> => {
    if (!config.scanInputs) return;

    try {
      await client.guard({
        content: event.prompt,
        direction: "input",
        detectors: config.detectors,
      });
    } catch {
      logger.warn("[promptguard] Telemetry llm_input forwarding failed");
    }
  };
}

export function createLlmOutputHandler(
  client: PromptGuardClient,
  config: PromptGuardConfig,
  logger: PluginLogger,
) {
  return async (event: { assistantTexts?: string[] }, _ctx: unknown): Promise<void> => {
    if (!config.scanInputs) return;

    const text = event.assistantTexts?.join("\n") ?? "";
    if (!text) return;

    try {
      await client.guard({
        content: text,
        direction: "output",
        detectors: config.detectors,
      });
    } catch {
      logger.warn("[promptguard] Telemetry llm_output forwarding failed");
    }
  };
}
