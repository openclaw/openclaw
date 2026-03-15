import type { SelfEvolveConfig } from "./types.js";

const DEFAULT_CONFIG: SelfEvolveConfig = {
  embedding: {
    provider: "hash",
    model: "text-embedding-3-small",
    dimensions: 512,
  },
  retrieval: {
    k1: 5,
    k2: 3,
    delta: 0.15,
    tau: 0.85,
    lambda: 0.5,
    epsilon: 0.1,
  },
  learning: {
    alpha: 0.3,
    gamma: 0,
    qInit: 0,
    rewardSuccess: 1,
    rewardFailure: -1,
  },
  memory: {
    maxEntries: 200,
    maxExperienceChars: 1200,
    includeFailures: true,
  },
  reward: {
    provider: "openai",
    model: "gpt-4.1-mini",
    temperature: 0,
  },
  runtime: {
    minPromptChars: 6,
    observeTurns: 0,
    minAbsReward: 0.15,
    minRewardConfidence: 0.55,
    learnMode: "balanced",
    noToolMinAbsReward: 0.8,
    noToolMinRewardConfidence: 0.9,
    newIntentSimilarityThreshold: 0.35,
    idleTurnsToClose: 2,
    pendingTtlMs: 300_000,
    maxTurnsPerTask: 5,
  },
  experience: {
    summarizer: "openai",
    model: "gpt-4.1-mini",
    temperature: 0,
    maxToolEvents: 12,
    maxRawChars: 2200,
    maxSummaryChars: 700,
  },
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readNumber(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = source[key];
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    throw new Error(`${key} must be a number`);
  }
  if (raw < min || raw > max) {
    throw new Error(`${key} must be between ${min} and ${max}`);
  }
  return raw;
}

function readBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const raw = source[key];
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return raw;
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, envVar) => {
    const resolved = process.env[String(envVar)];
    if (!resolved) {
      throw new Error(`Environment variable ${String(envVar)} is not set`);
    }
    return resolved;
  });
}

export const selfEvolveConfigSchema = {
  parse(value: unknown): SelfEvolveConfig {
    if (value === undefined || value === null) {
      return DEFAULT_CONFIG;
    }
    const root = asRecord(value, "self-evolve config");

    const embeddingRaw = root.embedding ? asRecord(root.embedding, "embedding") : {};
    const provider =
      embeddingRaw.provider === "openai" || embeddingRaw.provider === "hash"
        ? embeddingRaw.provider
        : DEFAULT_CONFIG.embedding.provider;
    const model =
      typeof embeddingRaw.model === "string" && embeddingRaw.model.trim().length > 0
        ? embeddingRaw.model
        : DEFAULT_CONFIG.embedding.model;
    const dimensions = readNumber(
      embeddingRaw,
      "dimensions",
      DEFAULT_CONFIG.embedding.dimensions ?? 512,
      16,
      4096,
    );
    const apiKeyRaw =
      typeof embeddingRaw.apiKey === "string" && embeddingRaw.apiKey.trim().length > 0
        ? resolveEnvVars(embeddingRaw.apiKey)
        : undefined;
    if (provider === "openai" && !apiKeyRaw) {
      throw new Error("embedding.apiKey is required when embedding.provider is openai");
    }
    const baseUrl =
      typeof embeddingRaw.baseUrl === "string" && embeddingRaw.baseUrl.trim().length > 0
        ? resolveEnvVars(embeddingRaw.baseUrl)
        : undefined;

    const retrievalRaw = root.retrieval ? asRecord(root.retrieval, "retrieval") : {};
    const k1 = Math.floor(readNumber(retrievalRaw, "k1", DEFAULT_CONFIG.retrieval.k1, 1, 100));
    const k2 = Math.floor(readNumber(retrievalRaw, "k2", DEFAULT_CONFIG.retrieval.k2, 1, 20));
    if (k2 > k1) {
      throw new Error("retrieval.k2 must be <= retrieval.k1");
    }

    const learningRaw = root.learning ? asRecord(root.learning, "learning") : {};
    const memoryRaw = root.memory ? asRecord(root.memory, "memory") : {};
    const rewardRaw = root.reward ? asRecord(root.reward, "reward") : {};
    const runtimeRaw = root.runtime ? asRecord(root.runtime, "runtime") : {};
    const experienceRaw = root.experience ? asRecord(root.experience, "experience") : {};

    const rewardProvider =
      rewardRaw.provider === "openai" ? rewardRaw.provider : DEFAULT_CONFIG.reward.provider;
    const rewardApiKey =
      typeof rewardRaw.apiKey === "string" && rewardRaw.apiKey.trim().length > 0
        ? resolveEnvVars(rewardRaw.apiKey)
        : undefined;

    const experienceSummarizer =
      experienceRaw.summarizer === "openai"
        ? experienceRaw.summarizer
        : DEFAULT_CONFIG.experience.summarizer;
    const experienceApiKey =
      typeof experienceRaw.apiKey === "string" && experienceRaw.apiKey.trim().length > 0
        ? resolveEnvVars(experienceRaw.apiKey)
        : undefined;

    return {
      embedding: {
        provider,
        model,
        dimensions,
        apiKey: apiKeyRaw,
        baseUrl,
      },
      retrieval: {
        k1,
        k2,
        delta: readNumber(retrievalRaw, "delta", DEFAULT_CONFIG.retrieval.delta, -1, 1),
        tau: readNumber(retrievalRaw, "tau", DEFAULT_CONFIG.retrieval.tau, -1, 1),
        lambda: readNumber(retrievalRaw, "lambda", DEFAULT_CONFIG.retrieval.lambda, 0, 1),
        epsilon: readNumber(retrievalRaw, "epsilon", DEFAULT_CONFIG.retrieval.epsilon, 0, 1),
      },
      learning: {
        alpha: readNumber(learningRaw, "alpha", DEFAULT_CONFIG.learning.alpha, 0.0001, 1),
        gamma: readNumber(learningRaw, "gamma", DEFAULT_CONFIG.learning.gamma, 0, 1),
        qInit: readNumber(learningRaw, "qInit", DEFAULT_CONFIG.learning.qInit, -1, 1),
        rewardSuccess: readNumber(
          learningRaw,
          "rewardSuccess",
          DEFAULT_CONFIG.learning.rewardSuccess,
          -1,
          2,
        ),
        rewardFailure: readNumber(
          learningRaw,
          "rewardFailure",
          DEFAULT_CONFIG.learning.rewardFailure,
          -2,
          1,
        ),
      },
      memory: {
        maxEntries: Math.floor(
          readNumber(memoryRaw, "maxEntries", DEFAULT_CONFIG.memory.maxEntries, 20, 50000),
        ),
        maxExperienceChars: Math.floor(
          readNumber(
            memoryRaw,
            "maxExperienceChars",
            DEFAULT_CONFIG.memory.maxExperienceChars,
            120,
            12000,
          ),
        ),
        includeFailures: readBoolean(
          memoryRaw,
          "includeFailures",
          DEFAULT_CONFIG.memory.includeFailures,
        ),
        stateFile:
          typeof memoryRaw.stateFile === "string" && memoryRaw.stateFile.trim().length > 0
            ? memoryRaw.stateFile
            : undefined,
      },
      reward: {
        provider: rewardProvider,
        apiKey: rewardApiKey,
        baseUrl:
          typeof rewardRaw.baseUrl === "string" && rewardRaw.baseUrl.trim().length > 0
            ? resolveEnvVars(rewardRaw.baseUrl)
            : undefined,
        model:
          typeof rewardRaw.model === "string" && rewardRaw.model.trim().length > 0
            ? rewardRaw.model
            : DEFAULT_CONFIG.reward.model,
        temperature: readNumber(rewardRaw, "temperature", DEFAULT_CONFIG.reward.temperature, 0, 1),
      },
      runtime: {
        minPromptChars: Math.floor(
          readNumber(runtimeRaw, "minPromptChars", DEFAULT_CONFIG.runtime.minPromptChars, 1, 200),
        ),
        observeTurns: Math.floor(
          readNumber(runtimeRaw, "observeTurns", DEFAULT_CONFIG.runtime.observeTurns, 0, 500),
        ),
        minAbsReward: readNumber(
          runtimeRaw,
          "minAbsReward",
          DEFAULT_CONFIG.runtime.minAbsReward,
          0,
          1,
        ),
        minRewardConfidence: readNumber(
          runtimeRaw,
          "minRewardConfidence",
          DEFAULT_CONFIG.runtime.minRewardConfidence,
          0,
          1,
        ),
        learnMode:
          runtimeRaw.learnMode === "balanced" ||
          runtimeRaw.learnMode === "tools_only" ||
          runtimeRaw.learnMode === "all"
            ? runtimeRaw.learnMode
            : DEFAULT_CONFIG.runtime.learnMode,
        noToolMinAbsReward: readNumber(
          runtimeRaw,
          "noToolMinAbsReward",
          DEFAULT_CONFIG.runtime.noToolMinAbsReward,
          0,
          1,
        ),
        noToolMinRewardConfidence: readNumber(
          runtimeRaw,
          "noToolMinRewardConfidence",
          DEFAULT_CONFIG.runtime.noToolMinRewardConfidence,
          0,
          1,
        ),
        newIntentSimilarityThreshold: readNumber(
          runtimeRaw,
          "newIntentSimilarityThreshold",
          DEFAULT_CONFIG.runtime.newIntentSimilarityThreshold,
          -1,
          1,
        ),
        idleTurnsToClose: Math.floor(
          readNumber(
            runtimeRaw,
            "idleTurnsToClose",
            DEFAULT_CONFIG.runtime.idleTurnsToClose,
            0,
            20,
          ),
        ),
        pendingTtlMs: Math.floor(
          readNumber(
            runtimeRaw,
            "pendingTtlMs",
            DEFAULT_CONFIG.runtime.pendingTtlMs,
            1_000,
            86_400_000,
          ),
        ),
        maxTurnsPerTask: Math.floor(
          readNumber(runtimeRaw, "maxTurnsPerTask", DEFAULT_CONFIG.runtime.maxTurnsPerTask, 1, 100),
        ),
      },
      experience: {
        summarizer: experienceSummarizer,
        apiKey: experienceApiKey,
        baseUrl:
          typeof experienceRaw.baseUrl === "string" && experienceRaw.baseUrl.trim().length > 0
            ? resolveEnvVars(experienceRaw.baseUrl)
            : undefined,
        model:
          typeof experienceRaw.model === "string" && experienceRaw.model.trim().length > 0
            ? experienceRaw.model
            : DEFAULT_CONFIG.experience.model,
        temperature: readNumber(
          experienceRaw,
          "temperature",
          DEFAULT_CONFIG.experience.temperature,
          0,
          1,
        ),
        maxToolEvents: Math.floor(
          readNumber(
            experienceRaw,
            "maxToolEvents",
            DEFAULT_CONFIG.experience.maxToolEvents,
            1,
            100,
          ),
        ),
        maxRawChars: Math.floor(
          readNumber(
            experienceRaw,
            "maxRawChars",
            DEFAULT_CONFIG.experience.maxRawChars,
            200,
            20000,
          ),
        ),
        maxSummaryChars: Math.floor(
          readNumber(
            experienceRaw,
            "maxSummaryChars",
            DEFAULT_CONFIG.experience.maxSummaryChars,
            100,
            4000,
          ),
        ),
      },
    };
  },
};
