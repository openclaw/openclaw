import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawTools } from "./openclaw-tools.js";

type CreateOpenClawToolsOptions = NonNullable<Parameters<typeof createOpenClawTools>[0]>;

function buildToolNames(options: CreateOpenClawToolsOptions): string[] {
  return createOpenClawTools({
    disableMessageTool: true,
    disablePluginTools: true,
    wrapBeforeToolCallHook: false,
    ...options,
  }).map((tool) => tool.name);
}

function autoUpdateConfig(enabled: boolean): OpenClawConfig {
  return enabled
    ? { agents: { defaults: { soul: { autoUpdate: true } } } }
    : { agents: { defaults: {} } };
}

describe("createOpenClawTools soul_update gating", () => {
  it("registers soul_update only when autoUpdate=true AND enableSoulUpdateTool=true", () => {
    expect(
      buildToolNames({ config: autoUpdateConfig(true), enableSoulUpdateTool: true }),
    ).toContain("soul_update");
  });

  it("omits soul_update when autoUpdate=true but enableSoulUpdateTool is omitted (main turn)", () => {
    expect(buildToolNames({ config: autoUpdateConfig(true) })).not.toContain("soul_update");
  });

  it("omits soul_update when autoUpdate=true but enableSoulUpdateTool=false", () => {
    expect(
      buildToolNames({ config: autoUpdateConfig(true), enableSoulUpdateTool: false }),
    ).not.toContain("soul_update");
  });

  it("omits soul_update when enableSoulUpdateTool=true but autoUpdate is off", () => {
    expect(
      buildToolNames({ config: autoUpdateConfig(false), enableSoulUpdateTool: true }),
    ).not.toContain("soul_update");
  });
});
