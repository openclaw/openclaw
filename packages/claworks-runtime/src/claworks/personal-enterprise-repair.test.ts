import { describe, expect, it } from "vitest";
import {
  PERSONAL_WORK_PLUGIN_ALLOW,
  repairPersonalEnterpriseProfile,
  resolveSelfHostedQwenFromEnv,
} from "./personal-enterprise-repair.js";

describe("personal-enterprise-repair", () => {
  it("resolveSelfHostedQwenFromEnv uses CLAWORKS_QWEN_BASE_URL", () => {
    const prev = process.env.CLAWORKS_QWEN_BASE_URL;
    process.env.CLAWORKS_QWEN_BASE_URL = "http://10.0.0.5:8080/v1/";
    const q = resolveSelfHostedQwenFromEnv();
    expect(q.baseUrl).toBe("http://10.0.0.5:8080/v1");
    if (prev === undefined) {
      delete process.env.CLAWORKS_QWEN_BASE_URL;
    } else {
      process.env.CLAWORKS_QWEN_BASE_URL = prev;
    }
  });

  it("repairPersonalEnterpriseProfile excludes qwen plugin and sets qwen-local provider", () => {
    const config: Record<string, unknown> = {
      plugins: { allow: ["claworks-robot", "feishu", "qwen"], entries: {} },
    };
    const result = repairPersonalEnterpriseProfile(config);
    const allow = (config.plugins as { allow: string[] }).allow;
    expect(allow).not.toContain("qwen");
    expect(allow).toContain("memory-lancedb");
    const providers = (config.models as { providers: Record<string, { baseUrl: string }> })
      .providers;
    expect(providers["qwen-local"]?.baseUrl).toBeTruthy();
    expect(result.changed).toBe(true);
  });

  it("PERSONAL_WORK_PLUGIN_ALLOW has no qwen or web-fetch", () => {
    expect(PERSONAL_WORK_PLUGIN_ALLOW.includes("qwen" as never)).toBe(false);
    expect(PERSONAL_WORK_PLUGIN_ALLOW.includes("web-fetch" as never)).toBe(false);
    expect(PERSONAL_WORK_PLUGIN_ALLOW.includes("openai")).toBe(true);
  });

  it("replaces plugins.allow with personal_work list exactly", () => {
    const config: Record<string, unknown> = {
      plugins: { allow: ["qwen", "web-fetch", "discord"], entries: {} },
    };
    repairPersonalEnterpriseProfile(config);
    expect((config.plugins as { allow: string[] }).allow).toEqual([...PERSONAL_WORK_PLUGIN_ALLOW]);
  });
});
