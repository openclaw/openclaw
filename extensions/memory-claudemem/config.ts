export type ClaudeMemConfig = {
  workerUrl: string;
  workerTimeout: number;
};

const DEFAULT_WORKER_URL = "http://localhost:37777";
const DEFAULT_TIMEOUT = 10000;

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

export const claudeMemConfigSchema = {
  parse(value: unknown): ClaudeMemConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      // Return defaults if no config provided
      return {
        workerUrl: DEFAULT_WORKER_URL,
        workerTimeout: DEFAULT_TIMEOUT,
      };
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(cfg, ["workerUrl", "workerTimeout"], "claude-mem config");

    return {
      workerUrl: typeof cfg.workerUrl === "string" ? cfg.workerUrl : DEFAULT_WORKER_URL,
      workerTimeout: typeof cfg.workerTimeout === "number" ? cfg.workerTimeout : DEFAULT_TIMEOUT,
    };
  },
  uiHints: {
    workerUrl: {
      label: "Worker URL",
      placeholder: DEFAULT_WORKER_URL,
      help: "URL of the claude-mem worker",
    },
    workerTimeout: {
      label: "Timeout (ms)",
      placeholder: String(DEFAULT_TIMEOUT),
      advanced: true,
      help: "Request timeout in milliseconds",
    },
  },
};
