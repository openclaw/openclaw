import type { CodexAppServerStartOptions } from "./config.js";
import type { v2 } from "./protocol-generated/typescript/index.js";
import { readCodexModelListResponse } from "./protocol-validators.js";
import {
  createIsolatedCodexAppServerClient,
  getSharedCodexAppServerClient,
} from "./shared-client.js";

export type CodexAppServerModel = {
  id: string;
  model: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  inputModalities: string[];
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
};

export type CodexAppServerModelListResult = {
  models: CodexAppServerModel[];
  nextCursor?: string;
};

export type CodexAppServerListModelsOptions = {
  limit?: number;
  cursor?: string;
  includeHidden?: boolean;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string;
  sharedClient?: boolean;
};

export async function listCodexAppServerModels(
  options: CodexAppServerListModelsOptions = {},
): Promise<CodexAppServerModelListResult> {
  const timeoutMs = options.timeoutMs ?? 2500;
  const useSharedClient = options.sharedClient !== false;
  const client = useSharedClient
    ? await getSharedCodexAppServerClient({
        startOptions: options.startOptions,
        timeoutMs,
        authProfileId: options.authProfileId,
      })
    : await createIsolatedCodexAppServerClient({
        startOptions: options.startOptions,
        timeoutMs,
        authProfileId: options.authProfileId,
      });
  try {
    const response = await client.request<unknown>(
      "model/list",
      {
        limit: options.limit ?? null,
        cursor: options.cursor ?? null,
        includeHidden: options.includeHidden ?? null,
      },
      { timeoutMs },
    );
    return readModelListResult(response);
  } finally {
    if (!useSharedClient) {
      client.close();
    }
  }
}

export function readModelListResult(value: unknown): CodexAppServerModelListResult {
  const response = readCodexModelListResponse(value);
  if (!response) {
    return { models: [] };
  }
  const models = response.data
    .map((entry) => readCodexModel(entry))
    .filter((entry): entry is CodexAppServerModel => entry !== undefined);
  const nextCursor = response.nextCursor ?? undefined;
  return { models, ...(nextCursor ? { nextCursor } : {}) };
}

function readCodexModel(value: v2.Model): CodexAppServerModel | undefined {
  const id = readNonEmptyString(value.id);
  const model = readNonEmptyString(value.model) ?? id;
  if (!id || !model) {
    return undefined;
  }
  return {
    id,
    model,
    ...(readNonEmptyString(value.displayName)
      ? { displayName: readNonEmptyString(value.displayName) }
      : {}),
    ...(readNonEmptyString(value.description)
      ? { description: readNonEmptyString(value.description) }
      : {}),
    hidden: value.hidden,
    isDefault: value.isDefault,
    inputModalities: value.inputModalities,
    supportedReasoningEfforts: readReasoningEfforts(value.supportedReasoningEfforts),
    ...(readNonEmptyString(value.defaultReasoningEffort)
      ? { defaultReasoningEffort: readNonEmptyString(value.defaultReasoningEffort) }
      : {}),
  };
}

function readReasoningEfforts(value: v2.ReasoningEffortOption[]): string[] {
  const efforts = value
    .map((entry) => readNonEmptyString(entry.reasoningEffort))
    .filter((entry): entry is string => entry !== undefined);
  return [...new Set(efforts)];
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}
