import type {
  AgentRunConfig,
  AgentTransport,
  ProviderTransportOptions,
} from "@mariozechner/pi-agent-core";
import type {
  AgentContext,
  AgentLoopConfig,
  Message,
  UserMessage,
} from "@mariozechner/pi-ai";
import { agentLoop, agentLoopContinue } from "./steerable-agent-loop.js";

export class SteerableProviderTransport implements AgentTransport {
  private options: ProviderTransportOptions;

  constructor(options: ProviderTransportOptions = {}) {
    this.options = options;
  }

  private getModel(cfg: AgentRunConfig) {
    let model = cfg.model;
    if (this.options.corsProxyUrl && cfg.model.baseUrl) {
      model = {
        ...cfg.model,
        baseUrl: `${this.options.corsProxyUrl}/?url=${encodeURIComponent(cfg.model.baseUrl)}`,
      };
    }
    return model;
  }

  private buildContext(messages: Message[], cfg: AgentRunConfig): AgentContext {
    return {
      systemPrompt: cfg.systemPrompt,
      messages,
      tools: cfg.tools,
    };
  }

  private buildLoopConfig(
    model: AgentRunConfig["model"],
    cfg: AgentRunConfig,
  ): AgentLoopConfig {
    return {
      model,
      reasoning: cfg.reasoning,
      getApiKey: this.options.getApiKey,
      getQueuedMessages: cfg.getQueuedMessages,
    };
  }

  async *run(
    messages: Message[],
    userMessage: Message,
    cfg: AgentRunConfig,
    signal?: AbortSignal,
  ) {
    const model = this.getModel(cfg);
    const context = this.buildContext(messages, cfg);
    const pc = this.buildLoopConfig(model, cfg);

    for await (const ev of agentLoop(
      userMessage as unknown as UserMessage,
      context,
      pc,
      signal,
    )) {
      yield ev;
    }
  }

  async *continue(
    messages: Message[],
    cfg: AgentRunConfig,
    signal?: AbortSignal,
  ) {
    const model = this.getModel(cfg);
    const context = this.buildContext(messages, cfg);
    const pc = this.buildLoopConfig(model, cfg);

    for await (const ev of agentLoopContinue(context, pc, signal)) {
      yield ev;
    }
  }
}
