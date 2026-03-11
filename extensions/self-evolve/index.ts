import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { selfEvolveConfigSchema } from "./src/config.js";
import { createEmbeddingAdapter } from "./src/embedding.js";
import {
  buildLlmTrace,
  buildToolTrace,
  composeExperience,
  ExperienceSummarizer,
  type LlmTrace,
  type ToolTrace,
} from "./src/experience.js";
import { IntentJudge } from "./src/intent.js";
import { selectPhaseB } from "./src/policy.js";
import {
  buildMemRLContext,
  extractMessageText,
  sanitizeMemoryText,
  truncateText,
} from "./src/prompt.js";
import { RewardScorer } from "./src/reward.js";
import { EpisodicStore } from "./src/store.js";
import type { ScoredCandidate } from "./src/types.js";

type TaskState = "open" | "waiting_feedback";

type TaskTurn = {
  id: string;
  turnIndex: number;
  prompt: string;
  queryEmbedding: number[];
  selected: ScoredCandidate[];
  assistantResponse?: string;
  toolTrace: ToolTrace[];
  llmTrace?: LlmTrace;
  runId?: string;
  createdAt: number;
};

type PendingTask = {
  id: string;
  intent: string;
  intentEmbedding: number[];
  turnStart: number;
  turns: TaskTurn[];
  state: TaskState;
  idleTurns: number;
  createdAt: number;
  updatedAt: number;
};

const EXPLICIT_FEEDBACK_PATTERNS = [
  /\b(thanks|thank you|great|good job|works|worked|fixed|resolved|perfect)\b/i,
  /\b(wrong|bad|failed|still broken|doesn'?t work|not working|error)\b/i,
  /(谢谢|很好|不错|可以了|解决了|搞定了|不对|没解决|不行|还是不行|有问题|报错|失败)/,
];
const FEEDBACK_EMOJIS = new Set(["👍", "👎", "✅", "❌", "👌", "🙏"]);
const FEEDBACK_SCORE_THRESHOLD = 0.2;
const FEEDBACK_CONFIDENCE_THRESHOLD = 0.5;

function resolveSessionKey(ctx: { sessionKey?: string; sessionId?: string }): string {
  return ctx.sessionKey ?? ctx.sessionId ?? "global";
}

function shouldTriggerRetrieval(prompt: string, minPromptChars: number): boolean {
  if (prompt.length < minPromptChars) {
    return false;
  }
  const normalized = prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) {
    return false;
  }
  const nonLearnable = new Set([
    "hi",
    "hello",
    "hey",
    "thanks",
    "thank you",
    "ok",
    "okay",
    "good",
    "谢谢",
    "很好",
    "收到",
    "不客气",
    "赞",
    "好的",
    "好",
    "ok了",
  ]);
  return !nonLearnable.has(normalized);
}

function isOnlySymbolsOrEmoji(text: string): boolean {
  if (text.trim().length === 0) {
    return true;
  }
  return !/[\p{L}\p{N}]/u.test(text);
}

function isExplicitFeedback(text: string): boolean {
  const cleaned = sanitizeMemoryText(text).trim();
  if (!cleaned) {
    return false;
  }
  if (isOnlySymbolsOrEmoji(cleaned)) {
    const normalized = cleaned.replace(/\uFE0F/g, "").replace(/\s+/g, "");
    if (!normalized) {
      return false;
    }
    for (const char of [...normalized]) {
      if (!FEEDBACK_EMOJIS.has(char)) {
        return false;
      }
    }
    return true;
  }
  for (const pattern of EXPLICIT_FEEDBACK_PATTERNS) {
    if (pattern.test(cleaned)) {
      return true;
    }
  }
  return false;
}

function isLikelyNewRequest(text: string): boolean {
  const cleaned = sanitizeMemoryText(text).trim().toLowerCase();
  if (!cleaned) {
    return false;
  }
  if (cleaned.includes("?") || cleaned.includes("？")) {
    return true;
  }
  const starters = [
    "帮我",
    "请",
    "请你",
    "how ",
    "what ",
    "why ",
    "can you",
    "could you",
    "show me",
    "list ",
  ];
  return starters.some((prefix) => cleaned.startsWith(prefix));
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm <= 0 || rightNorm <= 0) {
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function debugLog(logger: { debug?: (message: string) => void }, message: string): void {
  logger.debug?.(`[self-evolve] ${message}`);
}

function oneLineForLog(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function passLearnModeGate(params: {
  hasToolTrace: boolean;
  scoreAbs: number;
  confidence: number;
  mode: "balanced" | "tools_only" | "all";
  noToolMinAbsReward: number;
  noToolMinRewardConfidence: number;
}): { pass: boolean; reason: string } {
  if (params.mode === "all") {
    return { pass: true, reason: "mode-all" };
  }
  if (params.mode === "tools_only") {
    return params.hasToolTrace
      ? { pass: true, reason: "mode-tools-only-pass" }
      : { pass: false, reason: "mode-tools-only-no-tools" };
  }
  if (params.hasToolTrace) {
    return { pass: true, reason: "mode-balanced-tools" };
  }
  const highReward =
    params.scoreAbs >= params.noToolMinAbsReward &&
    params.confidence >= params.noToolMinRewardConfidence;
  return highReward
    ? { pass: true, reason: "mode-balanced-high-reward-no-tools" }
    : { pass: false, reason: "mode-balanced-no-tools-low-confidence" };
}

function gatherSelectedMemoryIds(task: PendingTask): string[] {
  const ids = new Set<string>();
  for (const turn of task.turns) {
    for (const selected of turn.selected) {
      ids.add(selected.triplet.id);
    }
  }
  return [...ids];
}

function gatherToolTrace(task: PendingTask, maxToolEvents: number): ToolTrace[] {
  const merged: ToolTrace[] = [];
  for (const turn of task.turns) {
    for (const event of turn.toolTrace) {
      merged.push(event);
    }
  }
  if (merged.length <= maxToolEvents) {
    return merged;
  }
  return merged.slice(-maxToolEvents);
}

function lastLlmTrace(task: PendingTask): LlmTrace | undefined {
  for (let index = task.turns.length - 1; index >= 0; index -= 1) {
    if (task.turns[index].llmTrace) {
      return task.turns[index].llmTrace;
    }
  }
  return undefined;
}

function collectAssistantResponse(task: PendingTask, maxChars: number): string {
  const chunks = task.turns
    .map((turn) => turn.assistantResponse?.trim() ?? "")
    .filter((value) => value.length > 0);
  return truncateText(chunks.join("\n\n"), maxChars);
}

function buildToolSignals(toolTrace: ToolTrace[]): {
  toolCalls: number;
  toolFailures: number;
  toolSuccessRate: number;
  hasToolError: boolean;
} {
  const toolCalls = toolTrace.length;
  const toolFailures = toolTrace.filter((event) => Boolean(event.error)).length;
  const hasToolError = toolFailures > 0;
  const toolSuccessRate = toolCalls === 0 ? 1 : (toolCalls - toolFailures) / toolCalls;
  return { toolCalls, toolFailures, toolSuccessRate, hasToolError };
}

function buildActionPath(
  toolTrace: ToolTrace[],
  assistantResponse: string,
  maxChars: number,
): string {
  if (toolTrace.length === 0) {
    return truncateText(
      assistantResponse.trim().length > 0 ? "assistant_direct_response" : "no_action_captured",
      maxChars,
    );
  }
  const steps = toolTrace.map((event) => `${event.toolName}:${event.error ? "error" : "ok"}`);
  return truncateText(steps.join(" -> "), maxChars);
}

function buildToolOutcomeSummary(
  toolSignals: {
    toolCalls: number;
    toolFailures: number;
    toolSuccessRate: number;
    hasToolError: boolean;
  },
  maxChars: number,
): string {
  if (toolSignals.toolCalls === 0) {
    return "no_tool_calls";
  }
  return truncateText(
    `calls=${toolSignals.toolCalls}, failures=${toolSignals.toolFailures}, success_rate=${toolSignals.toolSuccessRate.toFixed(3)}, has_error=${String(toolSignals.hasToolError)}`,
    maxChars,
  );
}

const plugin = {
  id: "self-evolve",
  name: "Self Evolve",
  description: "MemRL-style self-evolving retrieval policy over episodic memory.",
  configSchema: selfEvolveConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = selfEvolveConfigSchema.parse(api.pluginConfig);
    const adapter = createEmbeddingAdapter(config);
    const rewardScorer = new RewardScorer(config);
    const intentJudge = new IntentJudge(config);
    const experienceSummarizer = new ExperienceSummarizer(config);
    const stateDir = api.runtime.state.resolveStateDir();
    const stateFile =
      config.memory.stateFile ?? join(stateDir, "plugins", "self-evolve", "episodic-memory.json");
    const store = new EpisodicStore(stateFile);
    const ready = store.load();
    const pendingBySession = new Map<string, PendingTask>();
    const sessionByRunId = new Map<string, string>();
    const turnBySession = new Map<string, number>();

    function setPending(sessionKey: string, task: PendingTask): void {
      const previous = pendingBySession.get(sessionKey);
      if (previous) {
        for (const turn of previous.turns) {
          if (turn.runId) {
            sessionByRunId.delete(turn.runId);
          }
        }
      }
      pendingBySession.set(sessionKey, task);
      for (const turn of task.turns) {
        if (turn.runId) {
          sessionByRunId.set(turn.runId, sessionKey);
        }
      }
    }

    function deletePending(sessionKey: string): void {
      const previous = pendingBySession.get(sessionKey);
      if (previous) {
        for (const turn of previous.turns) {
          if (turn.runId) {
            sessionByRunId.delete(turn.runId);
          }
        }
      }
      pendingBySession.delete(sessionKey);
    }

    function findPending(params: { sessionKey: string; runId?: string }): {
      sessionKey: string;
      task: PendingTask;
    } | null {
      if (params.runId) {
        const mappedSession = sessionByRunId.get(params.runId);
        if (mappedSession) {
          const task = pendingBySession.get(mappedSession);
          if (task) {
            return { sessionKey: mappedSession, task };
          }
        }
      }

      const bySession = pendingBySession.get(params.sessionKey);
      if (bySession) {
        return { sessionKey: params.sessionKey, task: bySession };
      }

      if (params.sessionKey === "global" && pendingBySession.size === 1) {
        const [fallbackSession, task] = pendingBySession.entries().next().value as [
          string,
          PendingTask,
        ];
        return { sessionKey: fallbackSession, task };
      }

      return null;
    }

    function findTurn(task: PendingTask, runId?: string): TaskTurn | null {
      if (runId) {
        const exact = task.turns.find((turn) => turn.runId === runId);
        if (exact) {
          return exact;
        }
      }
      if (task.turns.length === 0) {
        return null;
      }
      return task.turns[task.turns.length - 1];
    }

    async function finalizeTaskWithReward(params: {
      task: PendingTask;
      reward: number;
      feedbackText: string;
    }): Promise<void> {
      const selectedIds = gatherSelectedMemoryIds(params.task);
      const toolTrace = gatherToolTrace(params.task, config.experience.maxToolEvents);
      const toolSignals = buildToolSignals(toolTrace);
      const llmTrace = lastLlmTrace(params.task);
      const assistantResponse = sanitizeMemoryText(
        collectAssistantResponse(params.task, config.memory.maxExperienceChars),
      );
      const cleanedIntent = sanitizeMemoryText(params.task.intent);
      const cleanedFeedback = sanitizeMemoryText(params.feedbackText);

      debugLog(
        api.logger,
        `learning start task=${params.task.id.slice(0, 8)} turns=${params.task.turns.length} selected=${selectedIds.length} reward=${params.reward.toFixed(3)} feedbackChars=${params.feedbackText.length}`,
      );

      store.updateQ({
        memoryIds: selectedIds,
        reward: params.reward,
        alpha: config.learning.alpha,
        gamma: config.learning.gamma,
        bootstrapNextMax: 0,
      });

      if (params.reward > 0 || config.memory.includeFailures) {
        const intentDecision = await intentJudge.judge(cleanedIntent);
        if (!intentDecision.isMeaningful) {
          debugLog(
            api.logger,
            `memory append skipped reason=intent-not-meaningful source=${intentDecision.source} confidence=${intentDecision.confidence.toFixed(3)} detail=${intentDecision.reason}`,
          );
          await store.save();
          debugLog(api.logger, "learning persisted to episodic store");
          return;
        }

        const rawTrace = experienceSummarizer.formatRawTrace({
          intent: cleanedIntent,
          assistantResponse,
          userFeedback: cleanedFeedback,
          reward: params.reward,
          llmTrace,
          toolTrace,
        });
        const summary = await experienceSummarizer.summarize({
          intent: cleanedIntent,
          assistantResponse,
          userFeedback: cleanedFeedback,
          reward: params.reward,
          rawTrace,
          llmTrace,
          toolTrace,
        });
        const actionPath = buildActionPath(toolTrace, assistantResponse, 320);
        const outcome = params.reward > 0 ? "success" : params.reward < 0 ? "failure" : "neutral";
        const toolOutcome = buildToolOutcomeSummary(toolSignals, 220);
        const cleanedExperience = composeExperience({
          summary,
          actionPath,
          outcome,
          assistantResponse,
          userFeedback: cleanedFeedback,
          reward: params.reward,
          toolOutcome,
          maxChars: config.memory.maxExperienceChars,
        });
        debugLog(
          api.logger,
          `memory triplet preview intent="${oneLineForLog(cleanedIntent)}" experience="${oneLineForLog(cleanedExperience)}" embeddingDims=${params.task.intentEmbedding.length} reward=${params.reward.toFixed(3)} selected=${selectedIds.length}`,
        );
        store.add({
          intent: cleanedIntent,
          experience: cleanedExperience,
          embedding: params.task.intentEmbedding,
          qInit: config.learning.qInit,
          maxEntries: config.memory.maxEntries,
        });
        debugLog(
          api.logger,
          `memory append task=${params.task.id.slice(0, 8)} summaryChars=${summary.length} rawTraceChars=${rawTrace.length} toolEvents=${toolTrace.length} reasoningSignals=${llmTrace?.reasoningSignals.length ?? 0} intentJudge=${intentDecision.source}:${intentDecision.confidence.toFixed(3)}`,
        );
      }

      await store.save();
      debugLog(api.logger, "learning persisted to episodic store");
    }

    async function maybeLearnOnFeedback(params: {
      task: PendingTask;
      feedbackText: string;
      explicitFeedback: boolean;
    }): Promise<{
      feedbackDetected: boolean;
      shouldLearn: boolean;
      skipReason: string;
      reward: number;
    }> {
      const cleanedFeedback = sanitizeMemoryText(params.feedbackText);
      const assistantResponse = sanitizeMemoryText(
        collectAssistantResponse(params.task, config.memory.maxExperienceChars),
      );
      const toolSignals = buildToolSignals(
        gatherToolTrace(params.task, config.experience.maxToolEvents),
      );
      const scored = await rewardScorer.score({
        userFeedback: cleanedFeedback,
        intent: sanitizeMemoryText(params.task.intent),
        assistantResponse,
        toolSignals,
      });
      const feedbackDetected =
        params.explicitFeedback ||
        (scored.source === "openai" &&
          scored.confidence >= FEEDBACK_CONFIDENCE_THRESHOLD &&
          Math.abs(scored.score) >= FEEDBACK_SCORE_THRESHOLD);

      let shouldLearn = false;
      let skipReason = "feedback-not-detected";
      const pastObserveWindow = params.task.turnStart > config.runtime.observeTurns;
      const passRewardGate =
        feedbackDetected &&
        pastObserveWindow &&
        Math.abs(scored.score) >= config.runtime.minAbsReward &&
        scored.confidence >= config.runtime.minRewardConfidence;

      if (passRewardGate) {
        const modeGate = passLearnModeGate({
          hasToolTrace: gatherToolTrace(params.task, config.experience.maxToolEvents).length > 0,
          scoreAbs: Math.abs(scored.score),
          confidence: scored.confidence,
          mode: config.runtime.learnMode,
          noToolMinAbsReward: config.runtime.noToolMinAbsReward,
          noToolMinRewardConfidence: config.runtime.noToolMinRewardConfidence,
        });
        shouldLearn = modeGate.pass;
        skipReason = modeGate.reason;
      }

      if (!pastObserveWindow) {
        skipReason = "observe-window";
      } else if (!feedbackDetected) {
        skipReason = "feedback-not-detected";
      } else if (Math.abs(scored.score) < config.runtime.minAbsReward) {
        skipReason = "reward-magnitude";
      } else if (scored.confidence < config.runtime.minRewardConfidence) {
        skipReason = "reward-confidence";
      } else if (shouldLearn && !skipReason.startsWith("mode-")) {
        skipReason = "none";
      }

      api.logger.info(
        `self-evolve: feedback scored score=${scored.score.toFixed(3)} confidence=${scored.confidence.toFixed(3)} source=${scored.source}${scored.source === "unavailable" ? ` unavailableReason=${scored.unavailableReason ?? "unknown"}` : ""} feedbackDetected=${String(feedbackDetected)} learn=${String(shouldLearn)}`,
      );

      if (shouldLearn) {
        await finalizeTaskWithReward({
          task: params.task,
          reward: scored.score,
          feedbackText: cleanedFeedback,
        });
      } else {
        debugLog(
          api.logger,
          `learning skipped task=${params.task.id.slice(0, 8)} turns=${params.task.turns.length} reason=${skipReason}`,
        );
      }

      return { feedbackDetected, shouldLearn, skipReason, reward: scored.score };
    }

    debugLog(
      api.logger,
      `config loaded retrieval(k1=${config.retrieval.k1},k2=${config.retrieval.k2},delta=${config.retrieval.delta},tau=${config.retrieval.tau},lambda=${config.retrieval.lambda}) runtime(observeTurns=${config.runtime.observeTurns},minAbsReward=${config.runtime.minAbsReward},minRewardConfidence=${config.runtime.minRewardConfidence},newIntentSimilarityThreshold=${config.runtime.newIntentSimilarityThreshold},idleTurnsToClose=${config.runtime.idleTurnsToClose},pendingTtlMs=${config.runtime.pendingTtlMs},maxTurnsPerTask=${config.runtime.maxTurnsPerTask})`,
    );

    api.logger.info(
      `self-evolve: initialized (embedder=${adapter.name}, k1=${config.retrieval.k1}, k2=${config.retrieval.k2})`,
    );

    api.on("before_prompt_build", async (event, ctx) => {
      const prompt = sanitizeMemoryText(event.prompt?.trim() ?? "");
      await ready;
      const sessionKey = resolveSessionKey(ctx);
      const now = Date.now();
      const currentTurn = (turnBySession.get(sessionKey) ?? 0) + 1;
      turnBySession.set(sessionKey, currentTurn);
      debugLog(
        api.logger,
        `hook before_prompt_build session=${sessionKey} turn=${currentTurn} promptChars=${prompt.length}`,
      );

      const existingTask = pendingBySession.get(sessionKey);
      let precomputedEmbedding: number[] | null = null;

      if (existingTask) {
        if (now - existingTask.updatedAt > config.runtime.pendingTtlMs) {
          debugLog(
            api.logger,
            `task closed reason=ttl task=${existingTask.id.slice(0, 8)} ageMs=${now - existingTask.updatedAt}`,
          );
          deletePending(sessionKey);
        } else if (existingTask.turns.length >= config.runtime.maxTurnsPerTask) {
          debugLog(
            api.logger,
            `task closed reason=max-turns task=${existingTask.id.slice(0, 8)} turns=${existingTask.turns.length}`,
          );
          deletePending(sessionKey);
        }
      }

      const activeTask = pendingBySession.get(sessionKey);
      if (activeTask && activeTask.state === "waiting_feedback") {
        const explicitFeedback = isExplicitFeedback(prompt);
        const likelyNewRequest = isLikelyNewRequest(prompt);
        if (likelyNewRequest) {
          debugLog(api.logger, "task closed reason=likely-new-request");
          deletePending(sessionKey);
        } else {
          const feedbackResult = await maybeLearnOnFeedback({
            task: activeTask,
            feedbackText: prompt,
            explicitFeedback,
          });
          if (feedbackResult.feedbackDetected) {
            deletePending(sessionKey);
            debugLog(
              api.logger,
              "feedback handled; skip retrieval/task creation for feedback-only turn",
            );
            return;
          }
        }

        if (pendingBySession.get(sessionKey)?.state === "waiting_feedback") {
          if (!shouldTriggerRetrieval(prompt, config.runtime.minPromptChars)) {
            const nextIdle = activeTask.idleTurns + 1;
            if (nextIdle >= config.runtime.idleTurnsToClose) {
              debugLog(
                api.logger,
                `task closed reason=idle task=${activeTask.id.slice(0, 8)} idleTurns=${nextIdle}`,
              );
              deletePending(sessionKey);
            } else {
              setPending(sessionKey, {
                ...activeTask,
                idleTurns: nextIdle,
                updatedAt: now,
              });
            }
            debugLog(api.logger, "retrieval skipped by trigger gate");
            return;
          }

          precomputedEmbedding = await adapter.embed(prompt);
          if (precomputedEmbedding.length > 0) {
            const sim = cosineSimilarity(precomputedEmbedding, activeTask.intentEmbedding);
            if (sim < config.runtime.newIntentSimilarityThreshold) {
              debugLog(
                api.logger,
                `task closed reason=new-intent task=${activeTask.id.slice(0, 8)} similarity=${sim.toFixed(3)} threshold=${config.runtime.newIntentSimilarityThreshold.toFixed(3)}`,
              );
              deletePending(sessionKey);
            } else {
              setPending(sessionKey, {
                ...activeTask,
                state: "open",
                idleTurns: 0,
                updatedAt: now,
              });
            }
          }
        }
      }

      if (!shouldTriggerRetrieval(prompt, config.runtime.minPromptChars)) {
        debugLog(api.logger, "retrieval skipped by trigger gate");
        return;
      }

      const queryEmbedding = precomputedEmbedding ?? (await adapter.embed(prompt));
      if (queryEmbedding.length === 0) {
        debugLog(api.logger, "retrieval skipped due to empty embedding");
        return;
      }
      debugLog(api.logger, `embedding created dims=${queryEmbedding.length}`);

      const candidates = store.search(queryEmbedding, config);
      debugLog(api.logger, `phase-a candidates=${candidates.length}`);
      const phaseB = selectPhaseB({ candidates, config });
      debugLog(
        api.logger,
        `phase-b scored=${phaseB.scored.length} selected=${phaseB.selected.length} simMax=${phaseB.simMax.toFixed(3)}`,
      );

      const currentTask = pendingBySession.get(sessionKey);
      const nextTask: PendingTask = currentTask ?? {
        id: randomUUID(),
        intent: prompt,
        intentEmbedding: queryEmbedding,
        turnStart: currentTurn,
        turns: [],
        state: "open",
        idleTurns: 0,
        createdAt: now,
        updatedAt: now,
      };

      const turn: TaskTurn = {
        id: randomUUID(),
        turnIndex: currentTurn,
        prompt,
        queryEmbedding,
        selected: phaseB.selected,
        toolTrace: [],
        createdAt: now,
      };
      nextTask.turns = [...nextTask.turns, turn];
      nextTask.state = "open";
      nextTask.idleTurns = 0;
      nextTask.updatedAt = now;
      setPending(sessionKey, nextTask);

      debugLog(
        api.logger,
        `pending created task=${nextTask.id.slice(0, 8)} turns=${nextTask.turns.length} selectedIds=${phaseB.selected.map((item) => item.triplet.id.slice(0, 8)).join(",") || "none"}`,
      );

      if (phaseB.selected.length === 0) {
        debugLog(
          api.logger,
          "retrieval returned null action; pending kept for task-level learning",
        );
        return;
      }

      const prependContext = buildMemRLContext(phaseB.selected);
      debugLog(
        api.logger,
        `prependContext preview=${prependContext.slice(0, 200).replaceAll("\n", "\\n")}`,
      );
      return {
        prependContext,
      };
    });

    api.on("agent_end", async (event, ctx) => {
      await ready;
      const sessionKey = resolveSessionKey(ctx);
      const matched = findPending({ sessionKey });
      if (!matched) {
        debugLog(api.logger, "agent_end skipped: no pending task");
        return;
      }

      const task = matched.task;
      const turn = findTurn(task);
      if (!turn) {
        debugLog(api.logger, "agent_end skipped: task has no turn");
        return;
      }

      const messages = Array.isArray(event.messages) ? event.messages : [];
      const assistantText = [...messages].reverse().find((message) => {
        if (!message || typeof message !== "object") {
          return false;
        }
        return (message as Record<string, unknown>).role === "assistant";
      });
      const assistantContent = truncateText(
        extractMessageText(assistantText),
        config.memory.maxExperienceChars,
      );
      turn.assistantResponse = assistantContent;

      setPending(matched.sessionKey, {
        ...task,
        state: "waiting_feedback",
        updatedAt: Date.now(),
      });

      debugLog(
        api.logger,
        `agent_end captured task=${task.id.slice(0, 8)} assistantChars=${assistantContent.length} success=${String(event.success)}`,
      );
    });

    api.on("llm_output", (event, ctx) => {
      const sessionKey = resolveSessionKey(ctx);
      const matched = findPending({ sessionKey, runId: event.runId });
      if (!matched) {
        debugLog(
          api.logger,
          `llm_output skipped: no pending for session=${sessionKey} runId=${event.runId}`,
        );
        return;
      }
      const task = matched.task;
      const turn = findTurn(task, event.runId);
      if (!turn) {
        debugLog(api.logger, `llm_output skipped: no turn for session=${matched.sessionKey}`);
        return;
      }
      turn.runId = event.runId;
      turn.llmTrace = buildLlmTrace(event, config.experience.maxRawChars);
      sessionByRunId.set(event.runId, matched.sessionKey);
      setPending(matched.sessionKey, {
        ...task,
        updatedAt: Date.now(),
      });
      debugLog(
        api.logger,
        `llm_output captured session=${matched.sessionKey} task=${task.id.slice(0, 8)} runId=${event.runId} provider=${event.provider} model=${event.model} assistantTexts=${event.assistantTexts.length}`,
      );
    });

    api.on("after_tool_call", (event, ctx) => {
      const sessionKey = resolveSessionKey(ctx);
      const matched = findPending({ sessionKey, runId: event.runId });
      if (!matched) {
        debugLog(
          api.logger,
          `tool trace skipped: no pending for session=${sessionKey} tool=${event.toolName} runId=${event.runId ?? "unknown"}`,
        );
        return;
      }

      const task = matched.task;
      const turn = findTurn(task, event.runId);
      if (!turn) {
        debugLog(api.logger, `tool trace skipped: no turn for session=${matched.sessionKey}`);
        return;
      }

      if (event.runId) {
        turn.runId = event.runId;
        sessionByRunId.set(event.runId, matched.sessionKey);
      }
      turn.toolTrace = [
        ...turn.toolTrace,
        buildToolTrace(event, config.experience.maxRawChars),
      ].slice(-config.experience.maxToolEvents);
      setPending(matched.sessionKey, {
        ...task,
        updatedAt: Date.now(),
      });
      debugLog(
        api.logger,
        `tool trace append session=${matched.sessionKey} task=${task.id.slice(0, 8)} runId=${event.runId ?? "unknown"} tool=${event.toolName} hasError=${String(Boolean(event.error))} durationMs=${event.durationMs ?? 0} turnToolEvents=${turn.toolTrace.length}`,
      );
    });

    api.registerService({
      id: "self-evolve",
      start: async () => {
        await ready;
        api.logger.info(`self-evolve: loaded ${store.list().length} episodic memories`);
      },
      stop: async () => {
        debugLog(api.logger, `service stop drop pending without feedback=${pendingBySession.size}`);
        pendingBySession.clear();
        sessionByRunId.clear();
        await store.save();
        api.logger.info("self-evolve: state saved");
      },
    });
  },
};

export default plugin;
