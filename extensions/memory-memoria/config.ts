export const MEMORIA_MEMORY_TYPES = [
  "profile",
  "semantic",
  "procedural",
  "working",
  "tool_result",
] as const;

export const MEMORIA_TRUST_TIERS = ["T1", "T2", "T3", "T4"] as const;
export const MEMORIA_BACKENDS = ["embedded", "http"] as const;
export const MEMORIA_USER_ID_STRATEGIES = ["config", "agentId", "sessionKey"] as const;

export type MemoriaMemoryType = (typeof MEMORIA_MEMORY_TYPES)[number];
export type MemoriaTrustTier = (typeof MEMORIA_TRUST_TIERS)[number];
export type MemoriaBackendMode = (typeof MEMORIA_BACKENDS)[number];
export type MemoriaUserIdStrategy = (typeof MEMORIA_USER_ID_STRATEGIES)[number];

export type MemoriaPluginConfig = {
  backend: MemoriaBackendMode;
  dbUrl: string;
  apiUrl?: string;
  apiKey?: string;
  pythonExecutable: string;
  memoriaRoot?: string;
  defaultUserId: string;
  userIdStrategy: MemoriaUserIdStrategy;
  timeoutMs: number;
  maxListPages: number;
  autoRecall: boolean;
  autoObserve: boolean;
  retrieveTopK: number;
  recallMinPromptLength: number;
  includeCrossSession: boolean;
  retrieveMemoryTypes?: MemoriaMemoryType[];
  observeTailMessages: number;
  observeMaxChars: number;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  embeddingDim?: number;
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
};

type Issue = { path: Array<string | number>; message: string };
type SafeParseResult =
  | { success: true; data: MemoriaPluginConfig }
  | { success: false; error: { issues: Issue[] } };

const DEFAULTS = {
  backend: "http" as MemoriaBackendMode,
  dbUrl: "mysql+pymysql://root:111@127.0.0.1:6001/memoria",
  apiUrl: "http://127.0.0.1:8100",
  pythonExecutable: "python3",
  defaultUserId: "openclaw-user",
  userIdStrategy: "config" as MemoriaUserIdStrategy,
  timeoutMs: 15_000,
  maxListPages: 20,
  autoRecall: true,
  autoObserve: false,
  retrieveTopK: 5,
  recallMinPromptLength: 8,
  includeCrossSession: true,
  observeTailMessages: 6,
  observeMaxChars: 6_000,
  embeddingProvider: "local",
  embeddingModel: "all-MiniLM-L6-v2",
  llmModel: "gpt-4o-mini",
} as const;

const UI_HINTS: Record<
  string,
  {
    label?: string;
    help?: string;
    tags?: string[];
    advanced?: boolean;
    sensitive?: boolean;
    placeholder?: string;
  }
> = {
  backend: {
    label: "Backend Mode",
    help: "HTTP is the official path. Embedded is advanced and requires a user-managed Python environment.",
    placeholder: DEFAULTS.backend,
  },
  dbUrl: {
    label: "MatrixOne Connection String",
    help: "Used by embedded mode. Replace with your MatrixOne Cloud DSN when needed.",
    placeholder: DEFAULTS.dbUrl,
  },
  apiUrl: {
    label: "Memoria API URL",
    help: "HTTP backend endpoint.",
    placeholder: DEFAULTS.apiUrl,
  },
  apiKey: {
    label: "Memoria API Key",
    help: "Bearer token for HTTP backend (optional when your endpoint is open).",
    sensitive: true,
    placeholder: "mem-...",
  },
  pythonExecutable: {
    label: "Python Executable",
    help: "Embedded mode only. You must provide your own Python + Memoria runtime.",
    advanced: true,
    placeholder: DEFAULTS.pythonExecutable,
  },
  memoriaRoot: {
    label: "Memoria Root Path",
    help: "Embedded mode only. Optional external Memoria checkout/package root.",
    advanced: true,
  },
  defaultUserId: {
    label: "Default User ID",
    help: "Fallback identity when no strategy-specific runtime id exists.",
    placeholder: DEFAULTS.defaultUserId,
  },
  userIdStrategy: {
    label: "User ID Strategy",
    help: "config keeps one shared user; agentId/sessionKey derive ids from runtime context.",
    advanced: true,
    placeholder: DEFAULTS.userIdStrategy,
  },
  timeoutMs: {
    label: "Request Timeout",
    help: "Timeout for backend requests in milliseconds.",
    advanced: true,
    placeholder: String(DEFAULTS.timeoutMs),
  },
  maxListPages: {
    label: "List Page Limit",
    help: "Maximum pages scanned when resolving memoria:// paths over HTTP.",
    advanced: true,
    placeholder: String(DEFAULTS.maxListPages),
  },
  autoRecall: {
    label: "Auto-Recall",
    help: "Inject relevant memories into prompt context before each run.",
  },
  autoObserve: {
    label: "Auto-Observe",
    help: "Capture durable user signals after successful runs.",
  },
  retrieveTopK: {
    label: "Recall Top K",
    help: "Maximum memories returned for retrieve/search and auto-recall.",
    placeholder: String(DEFAULTS.retrieveTopK),
  },
  recallMinPromptLength: {
    label: "Recall Min Length",
    help: "Auto-recall is skipped for prompts shorter than this length.",
    advanced: true,
    placeholder: String(DEFAULTS.recallMinPromptLength),
  },
  includeCrossSession: {
    label: "Cross-Session Recall",
    help: "When disabled, retrieval is scoped to the current session id when available.",
  },
  retrieveMemoryTypes: {
    label: "Retrieve Memory Types",
    help: "Optional memory type filter for retrieve/search and auto-recall.",
    advanced: true,
  },
  observeTailMessages: {
    label: "Observe Tail Messages",
    help: "How many recent user messages are considered for auto-observe.",
    advanced: true,
    placeholder: String(DEFAULTS.observeTailMessages),
  },
  observeMaxChars: {
    label: "Observe Max Chars",
    help: "Maximum total characters considered for auto-observe.",
    advanced: true,
    placeholder: String(DEFAULTS.observeMaxChars),
  },
  embeddingProvider: {
    label: "Embedding Provider",
    help: "Embedded mode only.",
    advanced: true,
    placeholder: DEFAULTS.embeddingProvider,
  },
  embeddingModel: {
    label: "Embedding Model",
    help: "Embedded mode only.",
    advanced: true,
    placeholder: DEFAULTS.embeddingModel,
  },
  embeddingBaseUrl: {
    label: "Embedding Base URL",
    help: "Embedded mode only.",
    advanced: true,
    placeholder: "https://api.openai.com/v1",
  },
  embeddingApiKey: {
    label: "Embedding API Key",
    help: "Embedded mode only.",
    advanced: true,
    sensitive: true,
    placeholder: "sk-...",
  },
  embeddingDim: {
    label: "Embedding Dimensions",
    help: "Embedded mode only.",
    advanced: true,
    placeholder: "1536",
  },
  llmApiKey: {
    label: "Observer LLM API Key",
    help: "Embedded mode only.",
    advanced: true,
    sensitive: true,
    placeholder: "sk-...",
  },
  llmBaseUrl: {
    label: "Observer LLM Base URL",
    help: "Embedded mode only.",
    advanced: true,
    placeholder: "https://api.openai.com/v1",
  },
  llmModel: {
    label: "Observer LLM Model",
    help: "Embedded mode only.",
    advanced: true,
    placeholder: DEFAULTS.llmModel,
  },
};

export const memoriaPluginJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    backend: {
      type: "string",
      enum: [...MEMORIA_BACKENDS],
    },
    dbUrl: {
      type: "string",
    },
    apiUrl: {
      type: "string",
    },
    apiKey: {
      type: "string",
    },
    pythonExecutable: {
      type: "string",
    },
    memoriaRoot: {
      type: "string",
    },
    defaultUserId: {
      type: "string",
    },
    userIdStrategy: {
      type: "string",
      enum: [...MEMORIA_USER_ID_STRATEGIES],
    },
    timeoutMs: {
      type: "integer",
      minimum: 1000,
      maximum: 120000,
    },
    maxListPages: {
      type: "integer",
      minimum: 1,
      maximum: 100,
    },
    autoRecall: {
      type: "boolean",
    },
    autoObserve: {
      type: "boolean",
    },
    retrieveTopK: {
      type: "integer",
      minimum: 1,
      maximum: 20,
    },
    recallMinPromptLength: {
      type: "integer",
      minimum: 1,
      maximum: 500,
    },
    includeCrossSession: {
      type: "boolean",
    },
    retrieveMemoryTypes: {
      type: "array",
      items: {
        type: "string",
        enum: [...MEMORIA_MEMORY_TYPES],
      },
    },
    observeTailMessages: {
      type: "integer",
      minimum: 2,
      maximum: 30,
    },
    observeMaxChars: {
      type: "integer",
      minimum: 256,
      maximum: 50000,
    },
    embeddingProvider: {
      type: "string",
    },
    embeddingModel: {
      type: "string",
    },
    embeddingBaseUrl: {
      type: "string",
    },
    embeddingApiKey: {
      type: "string",
    },
    embeddingDim: {
      type: "integer",
      minimum: 1,
    },
    llmApiKey: {
      type: "string",
    },
    llmBaseUrl: {
      type: "string",
    },
    llmModel: {
      type: "string",
    },
  },
};

function addIssue(issues: Issue[], path: Array<string | number>, message: string) {
  issues.push({ path, message });
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function parseString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? resolveEnvVars(trimmed) : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.trunc(value);
}

function parseMemoryTypes(value: unknown): MemoriaMemoryType[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parsed: MemoriaMemoryType[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return undefined;
    }
    const normalized = entry.trim() as MemoriaMemoryType;
    if (!MEMORIA_MEMORY_TYPES.includes(normalized)) {
      return undefined;
    }
    parsed.push(normalized);
  }
  return parsed.length > 0 ? parsed : undefined;
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, envVar: string) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function clampInteger(value: number, min: number, max: number) {
  if (value < min || value > max) {
    return undefined;
  }
  return value;
}

export function parseMemoriaPluginConfig(value: unknown): MemoriaPluginConfig {
  const result = safeParseMemoriaPluginConfig(value);
  if (!result.success) {
    const rendered = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid memory-memoria config: ${rendered}`);
  }
  return result.data;
}

export function safeParseMemoriaPluginConfig(value: unknown): SafeParseResult {
  const cfg = asObject(value);
  const issues: Issue[] = [];

  const backendRaw = parseString(cfg.backend) ?? DEFAULTS.backend;
  const backend = MEMORIA_BACKENDS.includes(backendRaw as MemoriaBackendMode)
    ? (backendRaw as MemoriaBackendMode)
    : undefined;
  if (!backend) {
    addIssue(issues, ["backend"], `must be one of ${MEMORIA_BACKENDS.join(", ")}`);
  }

  const userIdStrategyRaw = parseString(cfg.userIdStrategy) ?? DEFAULTS.userIdStrategy;
  const userIdStrategy = MEMORIA_USER_ID_STRATEGIES.includes(
    userIdStrategyRaw as MemoriaUserIdStrategy,
  )
    ? (userIdStrategyRaw as MemoriaUserIdStrategy)
    : undefined;
  if (!userIdStrategy) {
    addIssue(issues, ["userIdStrategy"], `must be one of ${MEMORIA_USER_ID_STRATEGIES.join(", ")}`);
  }

  const retrieveMemoryTypes = parseMemoryTypes(cfg.retrieveMemoryTypes);
  if (cfg.retrieveMemoryTypes !== undefined && !retrieveMemoryTypes) {
    addIssue(
      issues,
      ["retrieveMemoryTypes"],
      `must be an array of ${MEMORIA_MEMORY_TYPES.join(", ")}`,
    );
  }

  const timeoutMs = clampInteger(parseInteger(cfg.timeoutMs) ?? DEFAULTS.timeoutMs, 1000, 120000);
  if (!timeoutMs) {
    addIssue(issues, ["timeoutMs"], "must be between 1000 and 120000");
  }

  const maxListPages = clampInteger(
    parseInteger(cfg.maxListPages) ?? DEFAULTS.maxListPages,
    1,
    100,
  );
  if (!maxListPages) {
    addIssue(issues, ["maxListPages"], "must be between 1 and 100");
  }

  const retrieveTopK = clampInteger(parseInteger(cfg.retrieveTopK) ?? DEFAULTS.retrieveTopK, 1, 20);
  if (!retrieveTopK) {
    addIssue(issues, ["retrieveTopK"], "must be between 1 and 20");
  }

  const recallMinPromptLength = clampInteger(
    parseInteger(cfg.recallMinPromptLength) ?? DEFAULTS.recallMinPromptLength,
    1,
    500,
  );
  if (!recallMinPromptLength) {
    addIssue(issues, ["recallMinPromptLength"], "must be between 1 and 500");
  }

  const observeTailMessages = clampInteger(
    parseInteger(cfg.observeTailMessages) ?? DEFAULTS.observeTailMessages,
    2,
    30,
  );
  if (!observeTailMessages) {
    addIssue(issues, ["observeTailMessages"], "must be between 2 and 30");
  }

  const observeMaxChars = clampInteger(
    parseInteger(cfg.observeMaxChars) ?? DEFAULTS.observeMaxChars,
    256,
    50000,
  );
  if (!observeMaxChars) {
    addIssue(issues, ["observeMaxChars"], "must be between 256 and 50000");
  }

  const embeddingDimRaw = parseInteger(cfg.embeddingDim);
  const embeddingDim =
    embeddingDimRaw === undefined ? undefined : clampInteger(embeddingDimRaw, 1, 1000000);
  if (embeddingDimRaw !== undefined && embeddingDim === undefined) {
    addIssue(issues, ["embeddingDim"], "must be >= 1");
  }

  const backendValue = backend ?? DEFAULTS.backend;
  const apiUrl = parseString(cfg.apiUrl) ?? (backendValue === "http" ? DEFAULTS.apiUrl : undefined);

  if (backendValue === "http" && !apiUrl) {
    addIssue(issues, ["apiUrl"], "is required when backend=http");
  }

  const dbUrl = parseString(cfg.dbUrl) ?? DEFAULTS.dbUrl;

  if (issues.length > 0) {
    return {
      success: false,
      error: { issues },
    };
  }

  return {
    success: true,
    data: {
      backend: backendValue,
      dbUrl,
      apiUrl,
      apiKey: parseString(cfg.apiKey),
      pythonExecutable: parseString(cfg.pythonExecutable) ?? DEFAULTS.pythonExecutable,
      memoriaRoot: parseString(cfg.memoriaRoot),
      defaultUserId: parseString(cfg.defaultUserId) ?? DEFAULTS.defaultUserId,
      userIdStrategy: userIdStrategy ?? DEFAULTS.userIdStrategy,
      timeoutMs: timeoutMs ?? DEFAULTS.timeoutMs,
      maxListPages: maxListPages ?? DEFAULTS.maxListPages,
      autoRecall: parseBoolean(cfg.autoRecall) ?? DEFAULTS.autoRecall,
      autoObserve: parseBoolean(cfg.autoObserve) ?? DEFAULTS.autoObserve,
      retrieveTopK: retrieveTopK ?? DEFAULTS.retrieveTopK,
      recallMinPromptLength: recallMinPromptLength ?? DEFAULTS.recallMinPromptLength,
      includeCrossSession: parseBoolean(cfg.includeCrossSession) ?? DEFAULTS.includeCrossSession,
      retrieveMemoryTypes,
      observeTailMessages: observeTailMessages ?? DEFAULTS.observeTailMessages,
      observeMaxChars: observeMaxChars ?? DEFAULTS.observeMaxChars,
      embeddingProvider: parseString(cfg.embeddingProvider) ?? DEFAULTS.embeddingProvider,
      embeddingModel: parseString(cfg.embeddingModel) ?? DEFAULTS.embeddingModel,
      embeddingBaseUrl: parseString(cfg.embeddingBaseUrl),
      embeddingApiKey: parseString(cfg.embeddingApiKey),
      embeddingDim,
      llmApiKey: parseString(cfg.llmApiKey),
      llmBaseUrl: parseString(cfg.llmBaseUrl),
      llmModel: parseString(cfg.llmModel) ?? DEFAULTS.llmModel,
    },
  };
}

export const memoriaPluginConfigSchema = {
  parse: parseMemoriaPluginConfig,
  safeParse: safeParseMemoriaPluginConfig,
  uiHints: UI_HINTS,
  jsonSchema: memoriaPluginJsonSchema,
};
