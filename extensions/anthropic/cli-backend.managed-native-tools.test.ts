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
  it("keeps nothing unless the operator selects tools", () => {
    expect(buildAnthropicCliBackend().resolveManagedNativeTools?.({ agentId: "main" })).toEqual([]);
    expect(resolve(undefined)).toEqual([]);
    expect(resolve({})).toEqual([]);
  });

  it("applies the default, replaced by an agent's own list", () => {
    const selection = { default: ["Workflow", "Agent"], agents: { research: ["Agent"], ops: [] } };
    // Canonical order keeps equivalent configs on one launch argv and cached prefix.
    expect(resolve(selection, "main")).toEqual(["Agent", "Workflow"]);
    expect(resolve(selection, "research")).toEqual(["Agent"]);
    expect(resolve(selection, "ops")).toEqual([]);
  });

  it("never returns tools outside the orchestration set or with their own capability", () => {
    const backend = buildAnthropicCliBackend();
    const selected = resolve({ default: ["Agent", "Bash", "Read", "Monitor", "CronCreate"] });
    expect(selected).toEqual(["Agent"]);
    expect(backend.projectNativeToolAuthority?.(["Agent", "Workflow"])).toEqual([]);
  });

  it.each<[unknown, boolean]>([
    [{ default: ["Agent", "Workflow"], agents: { ops: [] } }, true],
    [{ default: ["Skill"] }, false],
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
