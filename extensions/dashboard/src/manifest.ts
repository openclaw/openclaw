// Custom-widget `widget.json` manifest load + validation (schema per 00 §2).
//
// The manifest is the sole source of truth for what a sandboxed widget is allowed
// to do: which binding ids it may request, which capabilities it holds, and its
// entrypoint. The parent bridge (UI side) re-checks every child request against
// the manifest the operator approved, so validation here is a security boundary,
// not a convenience. Hand-written guards mirror `schema.ts` (no zod).

import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { DATA_READ_RPC_ALLOWLIST, normalizeDashboardDataLogicalPath } from "./binding-contract.js";

export const CUSTOM_WIDGET_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const BINDING_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const WIDGET_CAPABILITIES = ["data:read", "prompt:send"] as const;

export type WidgetCapability = (typeof WIDGET_CAPABILITIES)[number];

export type WidgetManifestBinding =
  | { id: string; source: "rpc"; method: string }
  | { id: string; source: "file"; path: string; pointer?: string }
  | { id: string; source: "static"; value: unknown };

export type WidgetManifest = {
  schemaVersion: 1;
  name: string;
  title: string;
  entrypoint: string;
  bindings: WidgetManifestBinding[];
  capabilities: WidgetCapability[];
  preferredSize?: { w: number; h: number };
};

const MANIFEST_MAX_BYTES = 32 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${at} must be an object`);
  }
  return value;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`${at}.${key} is not allowed`);
    }
  }
}

function requireString(record: Record<string, unknown>, key: string, at: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${at}.${key} must be a string`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  at: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${at}.${key} must be a string`);
  }
  return value;
}

function assertIntegerRange(value: unknown, at: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${at} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function validateBinding(value: unknown, at: string): WidgetManifestBinding {
  const record = assertRecord(value, at);
  const id = requireString(record, "id", at);
  if (!BINDING_ID_PATTERN.test(id)) {
    throw new Error(`${at}.id is invalid`);
  }
  const source = requireString(record, "source", at);
  if (source === "rpc") {
    assertKnownKeys(record, ["id", "source", "method"], at);
    const method = requireString(record, "method", at);
    if (!DATA_READ_RPC_ALLOWLIST.includes(method as (typeof DATA_READ_RPC_ALLOWLIST)[number])) {
      throw new Error(`${at}.method is not allowlisted`);
    }
    return { id, source, method };
  }
  if (source === "file") {
    assertKnownKeys(record, ["id", "source", "path", "pointer"], at);
    const bindingPath = requireString(record, "path", at);
    // Reuse the data-jail normalizer: rejects traversal / absolute / control chars.
    normalizeDashboardDataLogicalPath(bindingPath);
    const pointer = optionalString(record, "pointer", at);
    return { id, source, path: bindingPath, ...(pointer !== undefined ? { pointer } : {}) };
  }
  if (source === "static") {
    assertKnownKeys(record, ["id", "source", "value"], at);
    return { id, source, value: record.value };
  }
  throw new Error(`${at}.source is invalid`);
}

function validateCapabilities(value: unknown): WidgetCapability[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("capabilities must be an array");
  }
  const seen = new Set<WidgetCapability>();
  for (const entry of value) {
    if (typeof entry !== "string" || !WIDGET_CAPABILITIES.includes(entry as WidgetCapability)) {
      throw new Error(`capability is invalid: ${String(entry)}`);
    }
    seen.add(entry as WidgetCapability);
  }
  return [...seen];
}

/** Validates a parsed `widget.json` object against the schema (00 §2). */
export function validateWidgetManifest(value: unknown, expectedName?: string): WidgetManifest {
  const record = assertRecord(value, "widget.json");
  assertKnownKeys(
    record,
    ["schemaVersion", "name", "title", "entrypoint", "bindings", "capabilities", "preferredSize"],
    "widget.json",
  );
  if (record.schemaVersion !== 1) {
    throw new Error("widget.json schemaVersion must be 1");
  }
  const name = requireString(record, "name", "widget.json");
  if (!CUSTOM_WIDGET_NAME_PATTERN.test(name)) {
    throw new Error("widget.json name is invalid");
  }
  if (expectedName !== undefined && name !== expectedName) {
    throw new Error("widget.json name does not match its directory");
  }
  const title = requireString(record, "title", "widget.json");
  if (title.length < 1 || title.length > 80) {
    throw new Error("widget.json title must be 1-80 characters");
  }
  const entrypoint = requireString(record, "entrypoint", "widget.json");
  // The entrypoint is a logical path served through the jail; normalize it the
  // same way the serving route does so a manifest cannot name an out-of-dir file.
  normalizeDashboardDataLogicalPath(entrypoint);
  const rawBindings = record.bindings;
  if (!Array.isArray(rawBindings)) {
    throw new Error("widget.json bindings must be an array");
  }
  if (rawBindings.length > 32) {
    throw new Error("widget.json bindings must contain at most 32 entries");
  }
  const bindings = rawBindings.map((binding, index) =>
    validateBinding(binding, `widget.json.bindings[${index}]`),
  );
  const ids = new Set<string>();
  for (const binding of bindings) {
    if (ids.has(binding.id)) {
      throw new Error(`widget.json duplicate binding id: ${binding.id}`);
    }
    ids.add(binding.id);
  }
  const capabilities = validateCapabilities(record.capabilities);
  const preferredSize =
    record.preferredSize === undefined
      ? undefined
      : (() => {
          const size = assertRecord(record.preferredSize, "widget.json.preferredSize");
          assertKnownKeys(size, ["w", "h"], "widget.json.preferredSize");
          return {
            w: assertIntegerRange(size.w, "widget.json.preferredSize.w", 1, 12),
            h: assertIntegerRange(size.h, "widget.json.preferredSize.h", 1, 20),
          };
        })();
  return {
    schemaVersion: 1,
    name,
    title,
    entrypoint,
    bindings,
    capabilities,
    ...(preferredSize !== undefined ? { preferredSize } : {}),
  };
}

/** Resolves the on-disk directory for one custom widget by name. */
export function resolveWidgetDir(name: string, stateDir = resolveStateDir()): string {
  if (!CUSTOM_WIDGET_NAME_PATTERN.test(name)) {
    throw new Error("widget name is invalid");
  }
  const widgetsRoot = path.resolve(stateDir, "dashboard", "widgets");
  const widgetDir = path.resolve(widgetsRoot, name);
  // Belt-and-braces: the charset check already forbids separators, but confirm
  // containment so the resolved directory can never escape the widgets root.
  if (widgetDir !== widgetsRoot && !widgetDir.startsWith(`${widgetsRoot}${path.sep}`)) {
    throw new Error("widget name is invalid");
  }
  return widgetDir;
}

/** Loads and validates the `widget.json` for a named custom widget, or null if absent. */
export async function loadWidgetManifest(
  name: string,
  options: { stateDir?: string } = {},
): Promise<WidgetManifest | null> {
  const widgetDir = resolveWidgetDir(name, options.stateDir);
  const manifestPath = path.join(widgetDir, "widget.json");
  let raw: string;
  try {
    const stat = await fs.stat(manifestPath);
    if (!stat.isFile() || stat.size > MANIFEST_MAX_BYTES) {
      return null;
    }
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("widget.json is not valid JSON", { cause: error });
  }
  return validateWidgetManifest(parsed, name);
}
