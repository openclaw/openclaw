import { describe, expect, it } from "vitest";
import { vmBridgeConfigSchema, pluginConfigSchema } from "./config.js";

const VALID_CONFIG = {
  database: { password: "secret123" },
  checkpoints: { selfEmail: "mike@xcellerateeq.ai" },
};

describe("vmBridgeConfigSchema", () => {
  it("parses minimal config with defaults", () => {
    const result = vmBridgeConfigSchema.parse(VALID_CONFIG);
    expect(result.database.host).toBe("localhost");
    expect(result.database.port).toBe(5433);
    expect(result.database.user).toBe("postgres");
    expect(result.database.password).toBe("secret123");
    expect(result.database.database).toBe("communications");
    expect(result.polling.intervalMs).toBe(60_000);
    expect(result.polling.accounts).toEqual(["xcellerate", "vvg"]);
    expect(result.polling.zoomEnabled).toBe(true);
    expect(result.bridge.url).toBe("http://127.0.0.1:8585");
    expect(result.bridge.healthCheckMs).toBe(30_000);
    expect(result.classifier.model).toBe("gpt-4o-mini");
    expect(result.checkpoints.replyPrefix).toBe("CONTRACT:");
    expect(result.checkpoints.selfEmail).toBe("mike@xcellerateeq.ai");
    expect(result.checkpoints.selfAccount).toBe("xcellerate");
    expect(result.agentLoop.hostname).toBeUndefined();
    expect(result.agentLoop.pollIntervalMs).toBe(15_000);
    expect(result.vms).toEqual({});
    expect(result.projects).toEqual({});
  });

  it("parses full config with overrides", () => {
    const result = vmBridgeConfigSchema.parse({
      ...VALID_CONFIG,
      polling: { intervalMs: 30_000, accounts: ["xcellerate", "vvg"], zoomEnabled: false },
      bridge: { url: "http://10.0.0.5:9090" },
      classifier: { model: "claude-3-5-haiku" },
      vms: {
        "claude-dev": { sshHost: "claude-dev", chromeProfile: "default" },
        "vvg-ec2": { sshHost: "vvg-gbp-ec2", chromeProfile: "vvg", defaultRepoPath: "/home/ubuntu/app" },
      },
      agentLoop: { hostname: "vvg-gbp-ec2", pollIntervalMs: 10_000 },
      projects: {
        "vvg-gbp": { vmOwner: "vvg-ec2", chromeProfile: "vvg", domain: "vvgtruck.com", intents: ["update listings"] },
      },
    });
    expect(result.agentLoop.hostname).toBe("vvg-gbp-ec2");
    expect(result.agentLoop.pollIntervalMs).toBe(10_000);
    expect(result.polling.intervalMs).toBe(30_000);
    expect(result.polling.accounts).toEqual(["xcellerate", "vvg"]);
    expect(result.polling.zoomEnabled).toBe(false);
    expect(result.bridge.url).toBe("http://10.0.0.5:9090");
    expect(result.classifier.model).toBe("claude-3-5-haiku");
    expect(result.vms["claude-dev"].sshHost).toBe("claude-dev");
    expect(result.vms["vvg-ec2"].defaultRepoPath).toBe("/home/ubuntu/app");
    expect(result.projects["vvg-gbp"].intents).toEqual(["update listings"]);
  });

  it("rejects config missing database.password", () => {
    expect(() =>
      vmBridgeConfigSchema.parse({ checkpoints: { selfEmail: "me@test.com" } }),
    ).toThrow();
  });

  it("rejects config missing checkpoints.selfEmail", () => {
    expect(() =>
      vmBridgeConfigSchema.parse({ database: { password: "p" } }),
    ).toThrow();
  });

  it("rejects non-object input", () => {
    expect(() => vmBridgeConfigSchema.parse("string")).toThrow();
    expect(() => vmBridgeConfigSchema.parse(null)).toThrow();
    expect(() => vmBridgeConfigSchema.parse(42)).toThrow();
  });
});

describe("pluginConfigSchema", () => {
  it("parse() returns typed config", () => {
    const result = pluginConfigSchema.parse(VALID_CONFIG);
    expect(result.database.password).toBe("secret123");
    expect(result.checkpoints.selfEmail).toBe("mike@xcellerateeq.ai");
  });

  it("parse() treats non-object as empty object (and throws for missing required)", () => {
    expect(() => pluginConfigSchema.parse(null)).toThrow();
    expect(() => pluginConfigSchema.parse("bad")).toThrow();
    expect(() => pluginConfigSchema.parse([])).toThrow();
  });

  it("safeParse() returns success for valid config", () => {
    const result = pluginConfigSchema.safeParse(VALID_CONFIG);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.database.password).toBe("secret123");
    }
  });

  it("safeParse() returns failure for invalid config", () => {
    const result = pluginConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("has uiHints for key fields", () => {
    expect(pluginConfigSchema.uiHints["database.password"].sensitive).toBe(true);
    expect(pluginConfigSchema.uiHints["checkpoints.selfEmail"].label).toBe("Checkpoint Email");
    expect(pluginConfigSchema.uiHints["bridge.url"]).toBeDefined();
  });
});
