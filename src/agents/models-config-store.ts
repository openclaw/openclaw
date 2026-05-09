import { createHash } from "node:crypto";
import path from "node:path";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  readOpenClawStateKvJsonResult,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../state/openclaw-state-kv.js";

const MODELS_CONFIG_SCOPE = "agent-model-catalog";
const MODELS_CONFIG_VALUE_VERSION = 1;

type StoredModelsConfigValue = {
  version: 1;
  agentDir: string;
  raw: string;
};

function modelsConfigKey(agentDir: string): string {
  return createHash("sha256").update(path.resolve(agentDir)).digest("hex");
}

function parseStoredModelsConfigValue(
  value: OpenClawStateJsonValue | undefined,
): StoredModelsConfigValue | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== MODELS_CONFIG_VALUE_VERSION ||
    typeof record.agentDir !== "string" ||
    typeof record.raw !== "string"
  ) {
    return undefined;
  }
  return {
    version: MODELS_CONFIG_VALUE_VERSION,
    agentDir: record.agentDir,
    raw: record.raw,
  };
}

export function readStoredModelsConfigRaw(
  agentDir: string,
  options: OpenClawStateDatabaseOptions = {},
): { raw: string; updatedAt: number } | undefined {
  const result = readOpenClawStateKvJsonResult(
    MODELS_CONFIG_SCOPE,
    modelsConfigKey(agentDir),
    options,
  );
  if (!result.exists) {
    return undefined;
  }
  const value = parseStoredModelsConfigValue(result.value);
  return value ? { raw: value.raw, updatedAt: result.updatedAt } : undefined;
}

export function writeStoredModelsConfigRaw(
  agentDir: string,
  raw: string,
  options: OpenClawStateDatabaseOptions & { now?: () => number } = {},
): void {
  writeOpenClawStateKvJson<StoredModelsConfigValue>(
    MODELS_CONFIG_SCOPE,
    modelsConfigKey(agentDir),
    {
      version: MODELS_CONFIG_VALUE_VERSION,
      agentDir: path.resolve(agentDir),
      raw,
    },
    options,
  );
}
