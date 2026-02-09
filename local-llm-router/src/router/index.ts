/**
 * Main router — the nerve center.
 *
 * Receives user input from any channel, classifies it via local LLM,
 * matches to a route, dispatches to the correct agent.
 */

import type {
  Classification,
  Route,
  Task,
  AgentId,
  ModelsRegistry,
} from "../types.js";
import {
  buildClassifierPrompt,
  parseClassification,
  fallbackClassification,
} from "./classifier.js";
import { matchRoute, createTask, type RoutingConfig } from "./dispatcher.js";
import {
  buildModelAliasIndex,
  resolveModelForEngine,
  type ModelAliasIndex,
} from "./model-selection.js";
import { runWithModelFallback } from "./model-fallback.js";
import { AuditLog } from "../persistence/audit.js";
import { ErrorJournal } from "../errors/journal.js";
import { BaseAgent } from "../agents/base-agent.js";

export interface RouterDeps {
  modelsRegistry: ModelsRegistry;
  routingConfig: RoutingConfig;
  auditLog: AuditLog;
  errorJournal: ErrorJournal;
  agents: Record<AgentId, BaseAgent>;
  callModel: (provider: string, model: string, prompt: string) => Promise<string>;
}

export class Router {
  private deps: RouterDeps;
  private aliasIndex: ModelAliasIndex;

  constructor(deps: RouterDeps) {
    this.deps = deps;
    this.aliasIndex = buildModelAliasIndex(deps.modelsRegistry);
  }

  /**
   * Main entry point: classify a user message and route it.
   */
  async handleMessage(
    userMessage: string,
    channelId: string,
  ): Promise<{ task: Task; result: import("../agents/base-agent.js").AgentResult }> {
    // 1. Classify the intent using the router model
    const classification = await this.classify(userMessage);

    // 2. Match to a route
    const route = matchRoute(classification, this.deps.routingConfig);

    // 3. Create a task
    const task = createTask({
      input: userMessage,
      channelId,
      classification,
      route,
    });

    // 4. Log the routing decision
    await this.deps.auditLog.log({
      agent: route.agent,
      action: "route",
      input: {
        intent: classification.intent,
        confidence: classification.confidence,
        engine: route.model,
      },
    });

    // 5. Dispatch to the correct agent
    const agent = this.deps.agents[route.agent];
    if (!agent) {
      throw new Error(`No agent registered for: ${route.agent}`);
    }

    const result = await agent.execute(task);

    // 6. Capture classification errors if the user rejects later
    if (!result.success) {
      await this.deps.errorJournal.capture({
        type: "tool_failure",
        agent: route.agent,
        model: route.model,
        task: userMessage,
        context: {
          intent: classification.intent,
          confidence: classification.confidence,
          error: result.error,
        },
      });
    }

    return { task, result };
  }

  /**
   * Classify a user message using the local router model.
   */
  private async classify(userMessage: string): Promise<Classification> {
    const routerModel = resolveModelForEngine(
      "local",
      this.deps.modelsRegistry,
      this.aliasIndex,
    );

    // Use router-specific model (Qwen 3B)
    const routerAlias = this.deps.modelsRegistry.defaults.router;
    const routerConfig = this.aliasIndex.get(routerAlias.toLowerCase());
    const model = routerConfig?.ref ?? routerModel;

    const prompt = buildClassifierPrompt(userMessage);

    try {
      const { result: raw } = await runWithModelFallback({
        primary: model,
        fallbacks: [routerModel], // Fallback to default local
        run: (provider, modelId) =>
          this.deps.callModel(provider, modelId, prompt),
      });

      const classification = parseClassification(raw);
      if (classification) {
        return classification;
      }

      // Model returned unparseable output — use heuristic fallback
      console.warn("[router] Could not parse classification, using fallback");
      return fallbackClassification(userMessage);
    } catch (err) {
      // All models failed — use heuristic fallback
      console.error("[router] Classification failed:", err);
      return fallbackClassification(userMessage);
    }
  }
}
