import type { OpenClawPlugin } from "../../src/plugins/types.js";

/**
 * Tool Response Limiter Plugin
 *
 * This plugin hooks into tool_result_persist to enforce size limits on tool responses.
 * Large responses are truncated with a clear message indicating the original and truncated sizes.
 *
 * Configuration:
 * - enabled: Enable/disable the plugin (default: true)
 * - maxResponseSizeKb: Maximum size in KB (default: 30)
 * - exemptTools: Array of tool names to exempt from limits (default: [])
 */

type PluginConfig = {
  enabled?: boolean;
  maxResponseSizeKb?: number;
  exemptTools?: string[];
};

/**
 * Serialize a message to JSON and get its byte size
 */
function getMessageSize(message: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(message)).length;
  } catch {
    return 0;
  }
}

/**
 * Truncate message content to fit within size limit
 */
function truncateMessage(message: any, maxBytes: number, originalSize: number): any {
  const truncationMessage = `[Response truncated from ${formatBytes(originalSize)} to ~${formatBytes(maxBytes)}]`;

  // Try to preserve the message structure while truncating content
  const truncated = { ...message };

  // If there's text content, truncate it
  if (truncated.content && Array.isArray(truncated.content)) {
    const textBlocks = truncated.content.filter((c: any) => c.type === "text");
    if (textBlocks.length > 0) {
      // Calculate overhead size (everything except text content)
      const nonTextContent = truncated.content.filter((c: any) => c.type !== "text");
      const overhead = getMessageSize({ ...truncated, content: nonTextContent });
      const availableForText = Math.max(0, maxBytes - overhead - truncationMessage.length - 100); // 100 byte buffer

      // Truncate the first text block
      const firstText = textBlocks[0];
      const truncatedText = firstText.text.substring(0, availableForText);

      truncated.content = [
        ...nonTextContent,
        {
          type: "text",
          text: truncatedText + "\n\n" + truncationMessage,
        },
      ];
    }
  } else if (typeof truncated.content === "string") {
    // Handle simple string content
    const overhead = getMessageSize({ ...truncated, content: "" });
    const availableForText = Math.max(0, maxBytes - overhead - truncationMessage.length - 100);
    truncated.content =
      truncated.content.substring(0, availableForText) + "\n\n" + truncationMessage;
  }

  // Remove or truncate large details objects
  if (truncated.details) {
    truncated.details = {
      _truncated: true,
      _note: "Details removed due to size constraints",
    };
  }

  return truncated;
}

/**
 * Format bytes into human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const plugin: OpenClawPlugin = {
  id: "tool-response-limiter",

  register(api) {
    const config = (api.getConfig?.() || {}) as PluginConfig;
    const logger = api.logger;

    // Default configuration
    const enabled = config.enabled !== false;
    const maxResponseSizeKb = config.maxResponseSizeKb || 30;
    const exemptTools = new Set(config.exemptTools || []);
    const maxBytes = maxResponseSizeKb * 1024;

    if (!enabled) {
      logger.info("[tool-response-limiter] Plugin is disabled");
      return;
    }

    logger.info(
      `[tool-response-limiter] Registered with ${maxResponseSizeKb}KB limit` +
        (exemptTools.size > 0 ? `, exempt tools: ${Array.from(exemptTools).join(", ")}` : ""),
    );

    api.on(
      "tool_result_persist",
      (event, _ctx) => {
        const { toolName, message } = event;

        // Skip if tool is exempt
        if (toolName && exemptTools.has(toolName)) {
          return;
        }

        // Check message size
        const messageSize = getMessageSize(message);

        if (messageSize > maxBytes) {
          logger.info(
            `[tool-response-limiter] Truncating ${toolName || "unknown"} response: ` +
              `${formatBytes(messageSize)} -> ${formatBytes(maxBytes)}`,
          );

          return {
            message: truncateMessage(message, maxBytes, messageSize),
          };
        }

        // No modification needed
        return;
      },
      { priority: 100 }, // High priority to run before other transforms
    );
  },
};

export default plugin;
