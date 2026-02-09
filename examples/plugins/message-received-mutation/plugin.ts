/**
 * Example: Message Received Mutation Plugin
 *
 * Demonstrates how to use the `message_received` hook to modify or cancel
 * incoming messages before they reach the agent.
 *
 * Use cases:
 * - Append memory discipline instructions to every message
 * - Filter spam or unwanted messages
 * - Normalize message content (e.g., expand abbreviations)
 * - Add context based on sender or conversation
 */

import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk";

const plugin: OpenClawPluginDefinition = {
  id: "message-received-mutation-example",
  name: "Message Received Mutation Example",
  description: "Demonstrates message_received hook for mutating incoming messages",
  version: "1.0.0",

  register(api) {
    api.on("message_received", async (event, ctx) => {
      api.logger.info(`[message-received] from=${event.from} channel=${ctx.channelId}`);

      // Example 1: Append memory discipline to every message
      // Useful for enforcing consistent agent behavior
      const memoryReminder =
        "\n\n[System: Remember to check MEMORY.md before answering questions about prior work]";

      // Example 2: Cancel spam messages
      if (event.content.toLowerCase().includes("buy now")) {
        api.logger.info("[message-received] Blocking spam message");
        return { cancel: true };
      }

      // Example 3: Mutate the message content
      // Return modified content (appending the memory reminder)
      return {
        content: event.content + memoryReminder,
      };
    });

    api.logger.info("Message received mutation plugin registered");
  },
};

export default plugin;
