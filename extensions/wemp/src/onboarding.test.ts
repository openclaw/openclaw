import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  buildOnboardingPlan,
  createWempOnboarding,
  executeWempOnboarding,
  wempOnboardingStages,
} from "./onboarding.js";

describe("wemp onboarding", () => {
  it("buildOnboardingPlan applies patches and defaults", () => {
    const plan = buildOnboardingPlan({
      supportAgentId: "wemp-kf-custom",
      brandName: "Acme",
      template: "content",
    });
    expect(plan.supportAgentId).toBe("wemp-kf-custom");
    expect(plan.unpairedAgentId).toBe("wemp-kf-custom");
    expect(plan.answers.brandName).toBe("Acme");
    expect(plan.answers.template).toBe("content");
  });

  it("executeWempOnboarding scaffolds agent files and knowledge files", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "wemp-onboarding-"));
    const result = executeWempOnboarding(workspace, {
      supportAgentId: "wemp-kf",
      brandName: "Test Brand",
      audience: "SMB",
      services: "AI Support",
      contact: "test@example.com",
      escalationRules: "报价与投诉转人工",
      tone: "专业",
      template: "enterprise",
    });
    expect(result.created.length).toBeGreaterThan(0);
    expect(result.agentRoot).toBeTruthy();
    expect(result.summary.length).toBeGreaterThan(0);

    const identityPath = path.join(result.agentRoot || "", "IDENTITY.md");
    const identity = readFileSync(identityPath, "utf8");
    expect(identity).toMatch(/Test Brand/);

    const casesPath = path.join(result.agentRoot || "", "knowledge", "cases.md");
    const cases = readFileSync(casesPath, "utf8");
    expect(cases).toMatch(/案例与场景/);
  });

  it("wempOnboardingStages contains required 4-stage wizard definitions", () => {
    expect(wempOnboardingStages.length).toBe(4);
    const ids = wempOnboardingStages.map((item) => item.id);
    expect(ids).toEqual(["channel-access", "routing", "scaffold", "persona"]);
    const persona = wempOnboardingStages.find((item) => item.id === "persona");
    expect(persona).toBeTruthy();
    expect(persona?.questions.some((q) => q.id === "brandName" && q.required)).toBe(true);
    expect(persona?.questions.some((q) => q.id === "recommendedLinks" && !q.required)).toBe(true);
  });

  it("createWempOnboarding returns official adapter contract and configure works", async () => {
    const adapter = createWempOnboarding();
    expect(adapter.channel).toBe("wemp");
    expect(typeof adapter.getStatus).toBe("function");
    expect(typeof adapter.configure).toBe("function");
    expect(adapter.dmPolicy?.policyKey).toBe("channels.wemp.dm.policy");

    const inputs = ["wx_app_123", "secret_123", "token_123", "/wemp-test", ""];
    const prompter = {
      text: async () => inputs.shift() ?? "",
      note: async () => undefined,
    };
    const configured = await adapter.configure({
      cfg: {} as OpenClawConfig,
      runtime: {} as any,
      prompter: prompter as any,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });
    const wemp = (configured.cfg.channels as Record<string, any>).wemp;
    expect(wemp.enabled).toBe(true);
    expect(wemp.appId).toBe("wx_app_123");
    expect(wemp.appSecret).toBe("secret_123");
    expect(wemp.token).toBe("token_123");
    expect(wemp.webhookPath).toBe("/wemp-test");
  });
});
