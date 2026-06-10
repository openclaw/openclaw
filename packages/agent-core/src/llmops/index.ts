import type { RuntimeConfig } from "@openclaw/config";
import { Langfuse } from "langfuse";

export class LlmOpsSubsystem {
  private static instance: LlmOpsSubsystem | null = null;
  public tracker: Langfuse | null = null;
  private config: any;

  private constructor(runtimeConfig: RuntimeConfig) {
    this.config = runtimeConfig.llmOps;

    if (this.config?.provider === "langfuse" && this.config.langfuse) {
      this.tracker = new Langfuse({
        publicKey: this.config.langfuse.publicKey,
        secretKey: this.config.langfuse.secretKey,
        baseUrl: this.config.langfuse.baseUrl || "https://cloud.langfuse.com",
        flushAt: 1,
      });
    }
  }

  public static initialize(runtimeConfig: RuntimeConfig): LlmOpsSubsystem {
    if (!LlmOpsSubsystem.instance) {
      LlmOpsSubsystem.instance = new LlmOpsSubsystem(runtimeConfig);
    }
    return LlmOpsSubsystem.instance;
  }

  public static getInstance(): LlmOpsSubsystem | null {
    return LlmOpsSubsystem.instance;
  }

  public startTrace(name: string, sessionId: string, meta: Record<string, any> = {}) {
    if (!this.tracker || !this.config?.tracing?.enabled) return null;

    return this.tracker.trace({
      name,
      sessionId,
      metadata: {
        ...meta,
        clusterNode: process.env.TARGET_NODE || "spark",
      },
    });
  }
}

/**
 * Resolves large structural markdown assets from Langfuse,
 * falling back to the local disk copy if the network is choked.
 */
async function resolveMarkdownAsset(
  promptName: string,
  variables: Record<string, any> = {},
  localFallbackText: string,
): Promise<string> {
  const llmOps = LlmOpsSubsystem.getInstance();

  if (llmOps?.tracker && llmOps.config?.prompts?.enabled) {
    try {
      // Fetches the cached or production-tagged version from Langfuse
      const promptTemplate = await llmOps.tracker.getPrompt(promptName);
      return promptTemplate.compile(variables);
    } catch (error) {
      console.warn(
        `[LLMOps] Failed to resolve remote asset "${promptName}". Falling back to disk context.`,
      );
    }
  }

  return localFallbackText;
}
