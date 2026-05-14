import type { LogIngestor } from "./ingestor.js";

export interface ContextInjectorOptions {
  // Maximum number of memory entries to include in the injected context.
  limit?: number;
  // Minimum hybrid score (0–1) required for an entry to be included.
  // Lower values include more entries; raise this if the injected context
  // becomes noisy. Default: 0.2
  minScore?: number;
  // Header text prepended before the list of memory entries.
  header?: string;
}

// ContextInjector queries the memory store with the user's prompt and
// returns a formatted string ready to be prepended to the agent's system
// prompt. This is the missing link between stored knowledge and agent
// behavior: call buildContext(userPrompt) before every LLM call and inject
// the result at the top of your system prompt.
//
// Typical host wiring:
//   const injector = new ContextInjector(ingestor);
//   const memCtx = await injector.buildContext(userMessage);
//   const systemPrompt = memCtx ? `${memCtx}\n\n${baseSystemPrompt}` : baseSystemPrompt;
export class ContextInjector {
  private readonly limit: number;
  private readonly minScore: number;
  private readonly header: string;

  constructor(
    private readonly ingestor: LogIngestor,
    opts?: ContextInjectorOptions,
  ) {
    this.limit = opts?.limit ?? 5;
    this.minScore = opts?.minScore ?? 0.2;
    this.header =
      opts?.header ?? "[Relevant rules and knowledge from memory — follow these when responding]";
  }

  // Returns a formatted context block, or an empty string when nothing
  // relevant was found above the score threshold.
  async buildContext(userPrompt: string): Promise<string> {
    if (!userPrompt.trim()) {
      return "";
    }
    const results = await this.ingestor.query(userPrompt, {
      layer: "semantic",
      limit: this.limit,
    });
    const relevant = results.filter((r) => r.score >= this.minScore);
    if (relevant.length === 0) {
      return "";
    }
    const lines = relevant.map((r) => `- ${r.entry.payload.content.trim()}`);
    return `${this.header}\n${lines.join("\n")}`;
  }

  // Convenience helper: returns a context block that includes ALL pinned
  // semantic entries regardless of query relevance. Use this when you want
  // mandatory rules (e.g. naming conventions) injected on every turn, not
  // just when the query happens to score them highly.
  async buildPinnedContext(): Promise<string> {
    const results = await this.ingestor.query("", { layer: "semantic", limit: 200 });
    const pinned = results.filter((r) => r.entry.payload.pinned);
    if (pinned.length === 0) {
      return "";
    }
    const lines = pinned.map((r) => `- ${r.entry.payload.content.trim()}`);
    return `[Mandatory rules — always follow these]\n${lines.join("\n")}`;
  }
}
