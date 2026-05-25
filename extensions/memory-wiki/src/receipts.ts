import fs from "node:fs/promises";
import path from "node:path";
import { appendRegularFile } from "openclaw/plugin-sdk/security-runtime";
import type { ResolvedMemoryWikiConfig } from "./config.js";

export const MEMORY_RECEIPTS_LOG_RELATIVE_PATH = ".openclaw-wiki/telemetry/memory-receipts.jsonl";

export type MemoryUtilizationReceipt = {
  run_id: string;
  task: string;
  memory_preflight: {
    performed: boolean;
    wiki_injectable: boolean;
    reason_if_not: string | null;
    files_read: string[];
    claims_used: string[];
  };
  decisions_influenced_by_memory: string[];
  writeback: {
    performed: boolean;
    paths: string[];
  };
};

export type MemoryUtilizationReceiptValidationError = {
  path: string;
  message: string;
};

export type MemoryUtilizationReceiptValidationResult =
  | { ok: true; receipt: MemoryUtilizationReceipt }
  | { ok: false; errors: MemoryUtilizationReceiptValidationError[] };

type ValidationErrors = MemoryUtilizationReceiptValidationError[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function addError(errors: ValidationErrors, pathName: string, message: string): void {
  errors.push({ path: pathName, message });
}

function validateAllowedKeys(
  value: Record<string, unknown>,
  pathName: string,
  allowedKeys: readonly string[],
  errors: ValidationErrors,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      addError(errors, `${pathName}.${key}`, "additional property is not allowed");
    }
  }
}

function readRecord(
  value: unknown,
  pathName: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  errors: ValidationErrors,
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    addError(errors, pathName, "must be an object");
    return null;
  }
  validateAllowedKeys(value, pathName, allowedKeys, errors);
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      addError(errors, `${pathName}.${key}`, "is required");
    }
  }
  return value;
}

function readString(
  value: unknown,
  pathName: string,
  errors: ValidationErrors,
  options?: { maxLength?: number },
): string | null {
  if (typeof value !== "string") {
    addError(errors, pathName, "must be a string");
    return null;
  }
  if (value.length === 0) {
    addError(errors, pathName, "must not be empty");
    return null;
  }
  if (options?.maxLength !== undefined && value.length > options.maxLength) {
    addError(errors, pathName, `must be ${options.maxLength} characters or fewer`);
    return null;
  }
  return value;
}

function readNullableString(
  value: unknown,
  pathName: string,
  errors: ValidationErrors,
  options?: { maxLength?: number },
): string | null {
  if (value === null) {
    return null;
  }
  return readString(value, pathName, errors, options);
}

function readBoolean(value: unknown, pathName: string, errors: ValidationErrors): boolean | null {
  if (typeof value !== "boolean") {
    addError(errors, pathName, "must be a boolean");
    return null;
  }
  return value;
}

function readStringArray(
  value: unknown,
  pathName: string,
  errors: ValidationErrors,
  options?: { maxItems?: number; maxItemLength?: number },
): string[] | null {
  if (!Array.isArray(value)) {
    addError(errors, pathName, "must be an array");
    return null;
  }
  if (options?.maxItems !== undefined && value.length > options.maxItems) {
    addError(errors, pathName, `must contain ${options.maxItems} items or fewer`);
    return null;
  }
  const strings: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const stringValue = readString(item, `${pathName}.${index}`, errors, {
      maxLength: options?.maxItemLength,
    });
    if (stringValue === null) {
      return;
    }
    if (seen.has(stringValue)) {
      addError(errors, `${pathName}.${index}`, "must be unique");
      return;
    }
    seen.add(stringValue);
    strings.push(stringValue);
  });
  return strings;
}

export function validateMemoryUtilizationReceipt(
  value: unknown,
): MemoryUtilizationReceiptValidationResult {
  const errors: ValidationErrors = [];
  const root = readRecord(
    value,
    "<root>",
    ["run_id", "task", "memory_preflight", "decisions_influenced_by_memory", "writeback"],
    ["run_id", "task", "memory_preflight", "decisions_influenced_by_memory", "writeback"],
    errors,
  );
  if (!root) {
    return { ok: false, errors };
  }

  const memoryPreflight = readRecord(
    root.memory_preflight,
    "memory_preflight",
    ["performed", "wiki_injectable", "reason_if_not", "files_read", "claims_used"],
    ["performed", "wiki_injectable", "reason_if_not", "files_read", "claims_used"],
    errors,
  );
  const writeback = readRecord(
    root.writeback,
    "writeback",
    ["performed", "paths"],
    ["performed", "paths"],
    errors,
  );

  const receipt: MemoryUtilizationReceipt = {
    run_id: readString(root.run_id, "run_id", errors, { maxLength: 200 }) ?? "",
    task: readString(root.task, "task", errors, { maxLength: 4000 }) ?? "",
    memory_preflight: {
      performed: memoryPreflight
        ? (readBoolean(memoryPreflight.performed, "memory_preflight.performed", errors) ?? false)
        : false,
      wiki_injectable: memoryPreflight
        ? (readBoolean(
            memoryPreflight.wiki_injectable,
            "memory_preflight.wiki_injectable",
            errors,
          ) ?? false)
        : false,
      reason_if_not: memoryPreflight
        ? readNullableString(
            memoryPreflight.reason_if_not,
            "memory_preflight.reason_if_not",
            errors,
            {
              maxLength: 1000,
            },
          )
        : null,
      files_read: memoryPreflight
        ? (readStringArray(memoryPreflight.files_read, "memory_preflight.files_read", errors, {
            maxItems: 500,
            maxItemLength: 2000,
          }) ?? [])
        : [],
      claims_used: memoryPreflight
        ? (readStringArray(memoryPreflight.claims_used, "memory_preflight.claims_used", errors, {
            maxItems: 1000,
            maxItemLength: 500,
          }) ?? [])
        : [],
    },
    decisions_influenced_by_memory:
      readStringArray(
        root.decisions_influenced_by_memory,
        "decisions_influenced_by_memory",
        errors,
        { maxItems: 500, maxItemLength: 4000 },
      ) ?? [],
    writeback: {
      performed: writeback
        ? (readBoolean(writeback.performed, "writeback.performed", errors) ?? false)
        : false,
      paths: writeback
        ? (readStringArray(writeback.paths, "writeback.paths", errors, {
            maxItems: 500,
            maxItemLength: 2000,
          }) ?? [])
        : [],
    },
  };

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, receipt };
}

export function assertMemoryUtilizationReceipt(value: unknown): MemoryUtilizationReceipt {
  const result = validateMemoryUtilizationReceipt(value);
  if (result.ok) {
    return result.receipt;
  }
  const details = result.errors.map((error) => `${error.path}: ${error.message}`).join("; ");
  throw new Error(`memory utilization receipt failed schema validation: ${details}`);
}

export function resolveMemoryReceiptLogPath(config: ResolvedMemoryWikiConfig): string {
  return path.join(config.vault.path, MEMORY_RECEIPTS_LOG_RELATIVE_PATH);
}

export async function recordMemoryUtilizationReceipt(params: {
  config: ResolvedMemoryWikiConfig;
  receipt: unknown;
  logPath?: string;
}): Promise<{ recorded: true; runId: string; logPath: string }> {
  const receipt = assertMemoryUtilizationReceipt(params.receipt);
  const logPath = params.logPath ?? resolveMemoryReceiptLogPath(params.config);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await appendRegularFile({
    filePath: logPath,
    content: `${JSON.stringify(receipt)}\n`,
    rejectSymlinkParents: true,
  });
  return { recorded: true, runId: receipt.run_id, logPath };
}
