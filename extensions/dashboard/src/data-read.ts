import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  DashboardBindingResolutionError,
  normalizeDashboardDataLogicalPath,
} from "./binding-contract.js";
import type { DashboardBinding, JsonValue } from "./schema.js";

export {
  DATA_READ_RPC_ALLOWLIST,
  DashboardBindingResolutionError,
  normalizeDashboardDataLogicalPath,
  type DashboardBindingErrorCode,
} from "./binding-contract.js";

export type ResolveBindingOptions = {
  stateDir?: string;
};

const MAX_FILE_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveDashboardDataPath(bindingPath: string, stateDir = resolveStateDir()): string {
  const normalized = normalizeDashboardDataLogicalPath(bindingPath);
  const dataRoot = path.resolve(stateDir, "dashboard", "data");
  const candidate = path.resolve(dataRoot, normalized);
  if (!(candidate === dataRoot || candidate.startsWith(`${dataRoot}${path.sep}`))) {
    throw new DashboardBindingResolutionError("binding_invalid", "file binding path is invalid");
  }
  return candidate;
}

function readBinding(value: unknown): DashboardBinding {
  if (!isRecord(value) || typeof value.source !== "string") {
    throw new DashboardBindingResolutionError("binding_invalid", "binding source is required");
  }
  if (value.source === "static") {
    return { source: "static", value: value.value as JsonValue };
  }
  if (value.source === "rpc") {
    if (typeof value.method !== "string" || !value.method.trim()) {
      throw new DashboardBindingResolutionError(
        "binding_invalid",
        "rpc binding method is required",
      );
    }
    return { source: "rpc", method: value.method };
  }
  if (value.source === "file") {
    if (typeof value.path !== "string") {
      throw new DashboardBindingResolutionError("binding_invalid", "file binding path is required");
    }
    if (value.pointer !== undefined && typeof value.pointer !== "string") {
      throw new DashboardBindingResolutionError(
        "binding_invalid",
        "file binding pointer is invalid",
      );
    }
    return {
      source: "file",
      path: value.path,
      ...(value.pointer !== undefined ? { pointer: value.pointer } : {}),
    };
  }
  throw new DashboardBindingResolutionError("binding_invalid", "binding source is invalid");
}

function decodePointerSegment(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function applyJsonPointer(value: unknown, pointer: string | undefined): unknown {
  if (pointer === undefined || pointer === "") {
    return value;
  }
  if (!pointer.startsWith("/")) {
    throw new DashboardBindingResolutionError("binding_invalid", "JSON pointer is invalid");
  }
  let current = value;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = decodePointerSegment(rawSegment);
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new DashboardBindingResolutionError("binding_not_found", "JSON pointer not found");
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      throw new DashboardBindingResolutionError("binding_not_found", "JSON pointer not found");
    }
    current = current[segment];
  }
  return current;
}

async function resolveFileBinding(
  binding: Extract<DashboardBinding, { source: "file" }>,
  options: ResolveBindingOptions,
): Promise<unknown> {
  const filePath = resolveDashboardDataPath(binding.path, options.stateDir);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DashboardBindingResolutionError("binding_not_found", "file binding not found");
    }
    throw error;
  }
  if (!stat.isFile()) {
    throw new DashboardBindingResolutionError("binding_not_found", "file binding not found");
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new DashboardBindingResolutionError("binding_too_large", "file binding is too large");
  }
  const content = await fs.readFile(filePath, "utf8");
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".md" || extension === ".csv") {
    return content;
  }
  try {
    return applyJsonPointer(JSON.parse(content), binding.pointer);
  } catch (error) {
    if (error instanceof DashboardBindingResolutionError) {
      throw error;
    }
    throw new DashboardBindingResolutionError("binding_invalid", "file binding JSON is invalid");
  }
}

export async function resolveBinding(
  bindingInput: unknown,
  options: ResolveBindingOptions = {},
): Promise<unknown> {
  const binding = readBinding(bindingInput);
  if (binding.source === "static") {
    return binding.value;
  }
  if (binding.source === "rpc") {
    throw new DashboardBindingResolutionError(
      "binding_client_resolved",
      "rpc dashboard bindings are resolved by the Control UI gateway client",
    );
  }
  return await resolveFileBinding(binding, options);
}
