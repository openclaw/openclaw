import type { StreamFn } from "@mariozechner/pi-agent-core";
import { updateModelCapability } from "./capabilities-cache.js";

/**
 * Runs a background request to verify if a model supports native tool calling.
 * This runs asynchronously and does not block the user's primary request.
 */
export async function runBackgroundCapabilityProbe(params: {
  streamFn: StreamFn;
  modelId: string;
  providerId: string;
  configDir: string;
}): Promise<void> {
  const { streamFn, modelId, providerId, configDir } = params;

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

    const modelObj = { id: modelId, api: "", provider: "" }; // Minimal model object
    const stream = await streamFn(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modelObj as unknown as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      context as unknown as any,
      {},
    );

    let finalStatus: "native" | "react" | "unknown" = "unknown";
    for await (const chunk of stream) {
      if (chunk.type === "done") {
        const content = chunk.message.content as unknown as Array<Record<string, unknown>>;
        if (content.some((p) => p.type === "toolCall")) {
          finalStatus = "native";
        } else {
          const textOutput = content
            .filter((p) => p.type === "text")
            .map((p) => (p.text as string) ?? "")
            .join("");

          if (textOutput.includes("Action:") || textOutput.includes("Thought:")) {
            finalStatus = "react";
          }
        }
      } else if (chunk.type === "error") {
        const error = chunk.error as unknown as Record<string, unknown>;
        const msg = (error?.message as string) || (error?.errorMessage as string) || "";
        if (msg.includes("does not support tools") || msg.includes("not support tool")) {
          finalStatus = "react";
        }
      }
    }

    // Only update if we got a definitive result (not unknown) or if it's currently unknown
    if (finalStatus !== "unknown") {
      await updateModelCapability(configDir, providerId, modelId, finalStatus);
    }
  } catch (err: unknown) {
    const error = err as Record<string, unknown>;
    const errorMessage = (error?.message as string) || String(err);
    if (
      errorMessage.includes("does not support tools") ||
      errorMessage.includes("not support tool")
    ) {
      await updateModelCapability(configDir, providerId, modelId, "react");
    }
    console.error(`[CapabilityProber] Failed to probe ${providerId}:${modelId}`, errorMessage);
  }
}
