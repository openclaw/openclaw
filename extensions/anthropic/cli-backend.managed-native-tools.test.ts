import fs from "node:fs";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: JsonSchemaObject };

function resolve(managedNativeTools: unknown, agentId = "main") {
  return buildAnthropicCliBackend().resolveManagedNativeTools?.({
    config: { plugins: { entries: { anthropic: { config: { managedNativeTools } } } } },
    agentId,
  });
}

describe("Claude CLI managed native tools", () => {
  it("keeps native WebSearch unless an explicit list replaces it", () => {
    expect(buildAnthropicCliBackend().resolveManagedNativeTools?.({ agentId: "main" })).toEqual([
      "WebSearch",
    ]);
    expect(resolve(undefined)).toEqual(["WebSearch"]);
    expect(resolve({ agents: { ops: [] } })).toEqual(["WebSearch"]);
    expect(resolve({ agents: { ops: [] } }, "ops")).toEqual([]);
    expect(resolve({ default: [] })).toEqual([]);
    expect(resolve({ default: ["Agent"] })).toEqual(["Agent"]);
  });

  it("applies the default, replaced by an agent's own list", () => {
    const selection = { default: ["Workflow", "Agent"], agents: { research: ["Agent"], ops: [] } };
    // Canonical order keeps equivalent configs on one launch argv and cached prefix.
    expect(resolve(selection, "main")).toEqual(["Agent", "Workflow"]);
    expect(resolve(selection, "research")).toEqual(["Agent"]);
    expect(resolve(selection, "ops")).toEqual([]);
  });

  it("keeps only orchestration tools and policy-gated native web search", () => {
    const backend = buildAnthropicCliBackend();
    const selected = resolve({
      default: ["WebSearch", "Agent", "Bash", "Read", "WebFetch", "Monitor", "CronCreate"],
    });
    expect(selected).toEqual(["Agent", "WebSearch"]);
    expect(backend.projectNativeToolAuthority?.(["Agent", "Workflow"])).toEqual([]);
    // Core keeps WebSearch only while the turn's OpenClaw policy offers this capability.
    expect(backend.projectNativeToolAuthority?.(["WebSearch"])).toEqual(["web_search"]);
  });

  it.each<[unknown, boolean]>([
    [{ default: ["Agent", "Workflow"], agents: { ops: [] } }, true],
    [{ default: ["Skill"] }, false],
    [{ default: ["WebFetch"] }, false],
    [{ agents: { ops: ["Bash"] } }, false],
    [{ default: ["Agent", "Agent"] }, false],
    [{ allow: ["Agent"] }, false],
  ])("validates managedNativeTools config %j", (managedNativeTools, expected) => {
    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      value: { managedNativeTools },
    });
    expect(result.ok).toBe(expected);
  });
});
