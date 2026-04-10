import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { listCodexAppServerModels, requestCodexAppServerJson } from "./app-server/client.js";
import { resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./app-server/protocol.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.js";

export function createCodexCommand(options: {
  pluginConfig?: unknown;
}): OpenClawPluginCommandDefinition {
  return {
    name: "codex",
    description: "Inspect and control the Codex app-server harness",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleCodexCommand(ctx, options),
  };
}

export async function handleCodexCommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown } = {},
): Promise<{ text: string }> {
  const [subcommand = "status", ...rest] = splitArgs(ctx.args);
  const normalized = subcommand.toLowerCase();
  if (normalized === "help") {
    return { text: buildHelp() };
  }
  if (normalized === "status") {
    return { text: await buildStatus(options.pluginConfig) };
  }
  if (normalized === "models") {
    return { text: await buildModels(options.pluginConfig) };
  }
  if (normalized === "threads") {
    return { text: await buildThreads(options.pluginConfig, rest.join(" ")) };
  }
  if (normalized === "resume") {
    return { text: await resumeThread(ctx, options.pluginConfig, rest[0]) };
  }
  if (normalized === "compact") {
    return {
      text: await startThreadAction(
        ctx,
        options.pluginConfig,
        "thread/compact/start",
        "compaction",
      ),
    };
  }
  if (normalized === "review") {
    return { text: await startThreadAction(ctx, options.pluginConfig, "review/start", "review") };
  }
  if (normalized === "mcp") {
    return { text: await buildList(options.pluginConfig, "mcpServerStatus/list", "MCP servers") };
  }
  if (normalized === "skills") {
    return { text: await buildList(options.pluginConfig, "skills/list", "Codex skills") };
  }
  if (normalized === "account") {
    return { text: await buildAccount(options.pluginConfig) };
  }
  return { text: `Unknown Codex command: ${subcommand}\n\n${buildHelp()}` };
}

async function buildStatus(pluginConfig: unknown): Promise<string> {
  const [models, account, limits, mcps, skills] = await Promise.all([
    safeValue(() => listCodexAppServerModels(requestOptions(pluginConfig, 20))),
    safeValue(() => codexRequest(pluginConfig, "account/read", {})),
    safeValue(() => codexRequest(pluginConfig, "account/rateLimits/read", {})),
    safeValue(() => codexRequest(pluginConfig, "mcpServerStatus/list", { limit: 100 })),
    safeValue(() => codexRequest(pluginConfig, "skills/list", {})),
  ]);

  const connected = models.ok || account.ok || limits.ok || mcps.ok || skills.ok;
  const lines = [`Codex app-server: ${connected ? "connected" : "unavailable"}`];
  if (models.ok) {
    lines.push(
      `Models: ${
        models.value.models
          .map((model) => model.id)
          .slice(0, 8)
          .join(", ") || "none"
      }`,
    );
  } else {
    lines.push(`Models: ${models.error}`);
  }
  lines.push(`Account: ${account.ok ? summarizeAccount(account.value) : account.error}`);
  lines.push(`Rate limits: ${limits.ok ? summarizeArrayLike(limits.value) : limits.error}`);
  lines.push(`MCP servers: ${mcps.ok ? summarizeArrayLike(mcps.value) : mcps.error}`);
  lines.push(`Skills: ${skills.ok ? summarizeArrayLike(skills.value) : skills.error}`);
  return lines.join("\n");
}

async function buildModels(pluginConfig: unknown): Promise<string> {
  const result = await listCodexAppServerModels(requestOptions(pluginConfig, 100));
  if (result.models.length === 0) {
    return "No Codex app-server models returned.";
  }
  return [
    "Codex models:",
    ...result.models.map((model) => `- ${model.id}${model.isDefault ? " (default)" : ""}`),
  ].join("\n");
}

async function buildThreads(pluginConfig: unknown, filter: string): Promise<string> {
  const response = await codexRequest(pluginConfig, "thread/list", {
    limit: 10,
    ...(filter.trim() ? { filter: filter.trim() } : {}),
  });
  const threads = extractArray(response);
  if (threads.length === 0) {
    return "No Codex threads returned.";
  }
  return [
    "Codex threads:",
    ...threads.slice(0, 10).map((thread) => {
      const record = isJsonObject(thread) ? thread : {};
      const id = readString(record, "threadId") ?? readString(record, "id") ?? "<unknown>";
      const title =
        readString(record, "title") ?? readString(record, "name") ?? readString(record, "summary");
      return `- ${id}${title ? ` - ${title}` : ""}`;
    }),
  ].join("\n");
}

async function buildAccount(pluginConfig: unknown): Promise<string> {
  const [account, limits] = await Promise.all([
    safeValue(() => codexRequest(pluginConfig, "account/read", {})),
    safeValue(() => codexRequest(pluginConfig, "account/rateLimits/read", {})),
  ]);
  return [
    `Account: ${account.ok ? summarizeAccount(account.value) : account.error}`,
    `Rate limits: ${limits.ok ? summarizeArrayLike(limits.value) : limits.error}`,
  ].join("\n");
}

async function buildList(pluginConfig: unknown, method: string, label: string): Promise<string> {
  const response = await codexRequest(pluginConfig, method, { limit: 100 });
  const entries = extractArray(response);
  if (entries.length === 0) {
    return `${label}: none returned.`;
  }
  return [
    `${label}:`,
    ...entries.slice(0, 25).map((entry) => {
      const record = isJsonObject(entry) ? entry : {};
      return `- ${readString(record, "name") ?? readString(record, "id") ?? JSON.stringify(entry)}`;
    }),
  ].join("\n");
}

async function resumeThread(
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  threadId: string | undefined,
): Promise<string> {
  const normalizedThreadId = threadId?.trim();
  if (!normalizedThreadId) {
    return "Usage: /codex resume <thread-id>";
  }
  if (!ctx.sessionFile) {
    return "Cannot attach a Codex thread because this command did not include an OpenClaw session file.";
  }
  const response = await codexRequest(pluginConfig, "thread/resume", {
    threadId: normalizedThreadId,
    persistExtendedHistory: true,
  });
  const thread = isJsonObject(response) && isJsonObject(response.thread) ? response.thread : {};
  const effectiveThreadId = readString(thread, "id") ?? normalizedThreadId;
  await writeCodexAppServerBinding(ctx.sessionFile, {
    threadId: effectiveThreadId,
    cwd: readString(thread, "cwd") ?? "",
    model: isJsonObject(response) ? readString(response, "model") : undefined,
    modelProvider: isJsonObject(response) ? readString(response, "modelProvider") : undefined,
  });
  return `Attached this OpenClaw session to Codex thread ${effectiveThreadId}.`;
}

async function startThreadAction(
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  method: string,
  label: string,
): Promise<string> {
  if (!ctx.sessionFile) {
    return `Cannot start Codex ${label} because this command did not include an OpenClaw session file.`;
  }
  const binding = await readCodexAppServerBinding(ctx.sessionFile);
  if (!binding?.threadId) {
    return `No Codex thread is attached to this OpenClaw session yet.`;
  }
  await codexRequest(pluginConfig, method, { threadId: binding.threadId });
  return `Started Codex ${label} for thread ${binding.threadId}.`;
}

async function codexRequest(
  pluginConfig: unknown,
  method: string,
  requestParams?: JsonValue,
): Promise<JsonValue | undefined> {
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig });
  return await requestCodexAppServerJson({
    method,
    requestParams,
    timeoutMs: runtime.requestTimeoutMs,
    startOptions: runtime.start,
  });
}

function requestOptions(pluginConfig: unknown, limit: number) {
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig });
  return {
    limit,
    timeoutMs: runtime.requestTimeoutMs,
    startOptions: runtime.start,
  };
}

async function safeValue<T>(
  read: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

function summarizeAccount(value: JsonValue | undefined): string {
  if (!isJsonObject(value)) {
    return "unavailable";
  }
  return (
    readString(value, "email") ??
    readString(value, "accountEmail") ??
    readString(value, "planType") ??
    readString(value, "id") ??
    "available"
  );
}

function summarizeArrayLike(value: JsonValue | undefined): string {
  const entries = extractArray(value);
  if (entries.length === 0) {
    return "none returned";
  }
  return `${entries.length}`;
}

function extractArray(value: JsonValue | undefined): JsonValue[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isJsonObject(value)) {
    return [];
  }
  for (const key of ["data", "items", "threads", "models", "skills", "servers", "rateLimits"]) {
    const child = value[key];
    if (Array.isArray(child)) {
      return child;
    }
  }
  return [];
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function splitArgs(value: string | undefined): string[] {
  return (value ?? "").trim().split(/\s+/).filter(Boolean);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildHelp(): string {
  return [
    "Codex commands:",
    "- /codex status",
    "- /codex models",
    "- /codex threads [filter]",
    "- /codex resume <thread-id>",
    "- /codex compact",
    "- /codex review",
    "- /codex account",
    "- /codex mcp",
    "- /codex skills",
  ].join("\n");
}
