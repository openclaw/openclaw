import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPromptGuardCommand } from "./src/command.js";
import { resolvePromptGuardConfig } from "./src/config.js";
import { PromptGuardClient } from "./src/guard-client.js";
import {
  createBeforeAgentReplyHandler,
  createBeforeToolCallHandler,
  createMessageSendingHandler,
  createLlmInputHandler,
  createLlmOutputHandler,
} from "./src/hooks.js";

export default definePluginEntry({
  id: "promptguard",
  name: "PromptGuard Security",
  description:
    "AI security scanning — prompt injection detection, PII redaction, tool argument validation, and threat telemetry",

  register(api) {
    const config = resolvePromptGuardConfig(api.config);
    const logger = api.logger;

    api.registerCommand(createPromptGuardCommand());

    if (!config) {
      return;
    }

    const client = new PromptGuardClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });

    api.on("before_agent_reply", createBeforeAgentReplyHandler(client, config, logger));
    api.on("before_tool_call", createBeforeToolCallHandler(client, config, logger));
    api.on("message_sending", createMessageSendingHandler(client, config, logger));
    api.on("llm_input", createLlmInputHandler(client, config, logger));
    api.on("llm_output", createLlmOutputHandler(client, config, logger));
  },
});
