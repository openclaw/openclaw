import type { SpeechModel } from "@camb-ai/sdk/api/index.js";
import { CambClient } from "@camb-ai/sdk";
import type { CambAiConfig } from "./config.js";

/**
 * Lazy-initialized Camb AI client wrapper
 */
export class CambClientWrapper {
  private client: CambClient | null = null;
  private readonly config: CambAiConfig;

  constructor(config: CambAiConfig) {
    this.config = config;
  }

  /**
   * Get or create the Camb AI client
   */
  getClient(): CambClient {
    if (!this.client) {
      if (!this.config.apiKey) {
        throw new Error("Camb AI API key not configured");
      }
      this.client = new CambClient({
        apiKey: this.config.apiKey,
      });
    }
    return this.client;
  }

  /**
   * Poll for task completion with exponential backoff
   */
  async pollForCompletion<T>(
    checkStatus: () => Promise<{ status: string; run_id?: number }>,
    getResult: (runId: number) => Promise<T>,
  ): Promise<T> {
    const startTime = Date.now();
    const intervalMs = this.config.pollingIntervalMs;
    const timeoutMs = this.config.pollingTimeoutMs;

    while (Date.now() - startTime < timeoutMs) {
      const status = await checkStatus();

      if (status.status === "SUCCESS" && status.run_id !== undefined) {
        return await getResult(status.run_id);
      }

      if (status.status === "FAILED") {
        throw new Error("Task failed");
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Task timed out after ${timeoutMs}ms`);
  }

  /**
   * Map speech model name to API value
   */
  getSpeechModel(): SpeechModel | undefined {
    const model = this.config.tts.model;
    switch (model) {
      case "auto":
        return "auto";
      case "mars-pro":
        return "mars-pro";
      case "mars-flash":
        return "mars-flash";
      case "mars-instruct":
        return "mars-instruct";
      default:
        return undefined;
    }
  }
}
