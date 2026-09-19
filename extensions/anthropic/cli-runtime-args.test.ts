import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { describe, expect, it } from "vitest";
import { prepareClaudeCliTransportArgs } from "./cli-runtime-args.js";

const BASE_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--setting-sources",
  "user",
  "--allowedTools",
  "mcp__openclaw__*",
  "--disallowedTools",
  "ScheduleWakeup,CronCreate",
] as const;

function createContext(
  overrides: Partial<CliBackendExecuteContext> = {},
): CliBackendExecuteContext {
  return {
    command: "claude",
    args: [...BASE_ARGS],
    cwd: process.cwd(),
    env: {},
    prompt: "hi",
    modelId: "claude-sonnet-4-5",
    systemPrompt: "system",
    useResume: false,
    timeoutMs: 1000,
    requestToolPermission: async () => ({ behavior: "deny", message: "nope" }),
    requestUserInput: async () => ({ status: "cancelled", message: "nope" }),
    ...overrides,
  };
}

function manyToolNames(count: number): string[] {
  // ~48 characters per name keeps the joined list well past the inline budget.
  return Array.from(
    { length: count },
    (_, index) => `server-with-a-long-name__tool_with_a_long_name_${index}`,
  );
}

function settingsArgValue(args: string[]): string | undefined {
  const index = args.indexOf("--settings");
  return index < 0 ? undefined : args[index + 1];
}

describe("prepareClaudeCliTransportArgs", () => {
  it("keeps a small allow list inline without a settings file", () => {
    const result = prepareClaudeCliTransportArgs(createContext());
    const allowedIndex = result.args.indexOf("--allowedTools");
    expect(allowedIndex).toBeGreaterThanOrEqual(0);
    expect(result.args[allowedIndex + 1]).toBe("mcp__openclaw__*");
    expect(result.args).not.toContain("--settings");
    expect(result.cleanup).toBeUndefined();
  });

  it("relocates an oversized allow list into a temporary settings file", () => {
    const toolNames = manyToolNames(400);
    const result = prepareClaudeCliTransportArgs(
      createContext({
        toolAvailability: { native: ["read", "bash"], openClaw: toolNames },
      }),
    );
    try {
      expect(result.args).not.toContain("--allowedTools");
      const settingsPath = settingsArgValue(result.args);
      expect(settingsPath).toBeDefined();
      expect(existsSync(settingsPath!)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath!, "utf8")) as {
        permissions?: { allow?: string[] };
      };
      expect(settings.permissions?.allow).toEqual(
        toolNames.map((name) => `mcp__openclaw__${name}`),
      );
      expect(result.cleanup).toBeDefined();
    } finally {
      result.cleanup?.();
    }
    const settingsPath = settingsArgValue(result.args)!;
    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(path.dirname(settingsPath))).toBe(false);
  });

  it("merges the relocated allow list into existing inline settings JSON", () => {
    const inlineSettings = JSON.stringify({
      disableAllHooks: true,
      enabledPlugins: {},
      permissions: { deny: ["mcp__*"] },
    });
    const toolNames = manyToolNames(400);
    const result = prepareClaudeCliTransportArgs(
      createContext({
        args: [...BASE_ARGS, "--settings", inlineSettings],
        toolAvailability: { native: ["read"], openClaw: toolNames },
      }),
    );
    try {
      // Exactly one --settings flag survives; the inline JSON moved into the file.
      expect(result.args.filter((arg) => arg === "--settings")).toHaveLength(1);
      expect(result.args).not.toContain(inlineSettings);
      expect(result.args).not.toContain("--allowedTools");
      const settings = JSON.parse(readFileSync(settingsArgValue(result.args)!, "utf8")) as {
        disableAllHooks?: boolean;
        enabledPlugins?: Record<string, unknown>;
        permissions?: { allow?: string[]; deny?: string[] };
      };
      expect(settings.disableAllHooks).toBe(true);
      expect(settings.enabledPlugins).toEqual({});
      expect(settings.permissions?.deny).toEqual(["mcp__*"]);
      expect(settings.permissions?.allow).toEqual(
        toolNames.map((name) => `mcp__openclaw__${name}`),
      );
    } finally {
      result.cleanup?.();
    }
  });

  it("merges the relocated allow list into --settings=<json> form", () => {
    const inlineSettings = JSON.stringify({ disableAllHooks: true });
    const toolNames = manyToolNames(400);
    const result = prepareClaudeCliTransportArgs(
      createContext({
        args: [...BASE_ARGS, `--settings=${inlineSettings}`],
        toolAvailability: { native: ["read"], openClaw: toolNames },
      }),
    );
    try {
      expect(result.args.some((arg) => arg.startsWith("--settings="))).toBe(false);
      const settings = JSON.parse(readFileSync(settingsArgValue(result.args)!, "utf8")) as {
        disableAllHooks?: boolean;
        permissions?: { allow?: string[] };
      };
      expect(settings.disableAllHooks).toBe(true);
      expect(settings.permissions?.allow).toHaveLength(toolNames.length);
    } finally {
      result.cleanup?.();
    }
  });

  it("keeps the allow list inline when existing --settings is a file path", () => {
    const toolNames = manyToolNames(400);
    const result = prepareClaudeCliTransportArgs(
      createContext({
        args: [...BASE_ARGS, "--settings", "C:\\claude\\team-settings.json"],
        toolAvailability: { native: ["read"], openClaw: toolNames },
      }),
    );
    const settingsIndex = result.args.indexOf("--settings");
    expect(result.args[settingsIndex + 1]).toBe("C:\\claude\\team-settings.json");
    const allowedIndex = result.args.indexOf("--allowedTools");
    expect(allowedIndex).toBeGreaterThanOrEqual(0);
    expect(result.args[allowedIndex + 1]).toBe(
      toolNames.map((name) => `mcp__openclaw__${name}`).join(","),
    );
    result.cleanup?.();
  });

  it("keeps --settings JSON inline when the allow list stays small", () => {
    const inlineSettings = JSON.stringify({ disableAllHooks: true });
    const result = prepareClaudeCliTransportArgs(
      createContext({ args: [...BASE_ARGS, "--settings", inlineSettings] }),
    );
    const settingsIndex = result.args.indexOf("--settings");
    expect(result.args[settingsIndex + 1]).toBe(inlineSettings);
    expect(result.args).toContain("--allowedTools");
    expect(result.cleanup).toBeUndefined();
  });
});
