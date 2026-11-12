import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { runDoctorLintChecks, type HealthCheck } from "openclaw/plugin-sdk/health";
import { explainToolAvailability } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { registerSkillWorkshopDoctorChecks } from "./doctor-health-api.js";
import { workshopPluginConfig } from "./src/test-support.js";

const runtime = { log() {}, error() {}, exit() {} };

/** The check exactly as the core health-check bridge registers it. */
function registeredCheck(): HealthCheck {
  const registered: HealthCheck[] = [];
  registerSkillWorkshopDoctorChecks({
    getHealthCheck: () => undefined,
    registerHealthCheck: (check) => registered.push(check),
    explainToolAvailability,
  });
  return registered[0]!;
}

describe("skill-workshop/tool-policy", () => {
  const workshopCheck = registeredCheck();
  // Workshop defaults to auto, so an absent setting already enables learning.
  const context = (cfg: OpenClawConfig, mode: "doctor" | "lint" = "doctor") => ({
    mode,
    runtime,
    cfg,
  });
  const detect = (cfg: OpenClawConfig) => workshopCheck.detect(context(cfg));
  const warning = (prefix = "", target?: string) =>
    expect.objectContaining({
      severity: "warning",
      ...(target ? { target } : {}),
      message: `${prefix}tools.profile: "messaging" does not include "skill_workshop".`,
      path: `${prefix}tools.profile`,
      fixHint: `Add ${prefix}tools.alsoAllow: ["skill_workshop"].`,
    });

  it.each<[OpenClawConfig["plugins"], string]>([
    [{ allow: ["diffs"] }, "plugins.allow"],
    [{ enabled: false }, "plugins.enabled"],
  ])("warns when %o keeps the skill-workshop plugin off", async (plugins, path) => {
    expect(await detect({ plugins })).toEqual([
      expect.objectContaining({ severity: "warning", path }),
    ]);
    expect(await detect({ plugins: { allow: ["diffs", "skill-workshop"] } })).toEqual([]);
    expect(
      await detect(workshopPluginConfig({ autonomous: { mode: "off" } }, { plugins })),
    ).toEqual([]);
  });

  it("warns when autonomous capture is enabled but policy hides its tool", async () => {
    expect(await detect({ tools: { profile: "messaging" } })).toEqual([warning()]);
  });

  it("checks every explicit-roster agent without turning selection into a health error", async () => {
    const result = await runDoctorLintChecks(
      context(
        {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "main" } },
            entries: {
              main: { tools: { profile: "coding" } },
              helper: { tools: { profile: "messaging" } },
              reader: { tools: { profile: "minimal", deny: ["group:agents"] } },
              third: { tools: { profile: "coding" } },
            },
          },
        },
        "lint",
      ),
      { checks: [workshopCheck] },
    );
    expect(result.findings).toEqual([warning("agents.entries.helper.", "helper")]);
  });

  it("does not warn when autonomous capture is disabled", async () => {
    await expect(
      detect({
        ...workshopPluginConfig({ autonomous: { mode: "off" } }),
        tools: { profile: "messaging" },
      }),
    ).resolves.toEqual([]);
  });
});
