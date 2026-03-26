import type { StreamFn } from "@mariozechner/pi-agent-core";
import { updateModelCapability, type CapabilityStatus } from "./capabilities-cache.js";
import { isUnsupportedToolError } from "./react-fallback-stream.js";

/**
 * Runs a background request to verify if a model supports native tool calling.
 * This runs asynchronously and does not block the user's primary request.
 */
export async function runBackgroundCapabilityProbe(params: {
  streamFn: StreamFn;
  model: unknown;
  modelId: string; // The user-configured model ID (stable key)
  providerId: string;
  configDir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options?: any; // Propagate AbortSignal and other request options
}): Promise<void> {
  const { streamFn, model, modelId, providerId, configDir, options } = params;

  try {
    const dummyTools = [
      {
        name: "check_capability_ping",
        description: "A dummy tool to check if the model can trigger native tool calls.",
        parameters: {
          type: "object",
          properties: {
            nonce: { type: "string" },
          },
          required: ["nonce"],
        },
      },
    ];

    const context = {
      messages: [
        {
          role: "user",
          content:
            "You are a capability tester. CALL the 'check_capability_ping' tool now with a random nonce. ONLY output the tool call.",
        },
      ],
      tools: dummyTools,
    };

    const stream = await streamFn(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      context as unknown as any,
      options || {},
    );

    let finalStatus: CapabilityStatus = "unknown";
    let hasReActEvidence = false;
    const reactMarkerRegex = /(?:^|[\r\n])\s*(?:Action|Thought):/i;

    for await (const chunk of stream) {
      if (chunk.type === "done") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const content = chunk.message.content as any[];
        if (
          content.some(
            (p) => p.type === "toolCall" || p.type === "toolUse" || p.type === "functionCall",
          )
        ) {
          finalStatus = "native";
        }

        const textOutput = content
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("");
        if (reactMarkerRegex.test(textOutput)) {
          hasReActEvidence = true;
        }
      } else if (chunk.type === "error") {
        if (isUnsupportedToolError(JSON.stringify(chunk.error || {}))) {
          finalStatus = "react";
        }
      }
    }

    if (finalStatus === "unknown" && hasReActEvidence) {
      finalStatus = "react";
    }

    // Only update if we got a definitive result (not unknown)
    if (finalStatus !== "unknown") {
      await updateModelCapability(configDir, providerId, modelId, finalStatus);
    }
  } catch (err: unknown) {
    const error = err as Record<string, unknown>;
    const errorMessage = (error?.message as string) || String(err);
    if (isUnsupportedToolError(errorMessage)) {
      await updateModelCapability(configDir, providerId, modelId, "react");
    }
    console.error(`[CapabilityProber] Failed to probe ${providerId}:${modelId}`, errorMessage);
  }
}
