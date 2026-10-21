import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
} from "openclaw/plugin-sdk/plugin-config-runtime";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi, type TestPluginApiInput } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const artifactMocks = vi.hoisted(() => ({
  verify: vi.fn(),
  registerDoctor: vi.fn(),
}));

vi.mock("./api.js", () => ({
  registerCuaDriverDoctorChecks: artifactMocks.registerDoctor,
}));

vi.mock("./src/driver-artifacts.js", () => ({
  verifyInstalledCuaDriverArtifacts: artifactMocks.verify,
}));

import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const originalPlatform = process.platform;
const enabledConfig = { plugins: { entries: { "cua-computer": { enabled: true } } } };

function registerPlugin(overrides: TestPluginApiInput = {}) {
  const commands: OpenClawPluginNodeHostCommand[] = [];
  const policies: OpenClawPluginNodeInvokePolicy[] = [];
  plugin.register(
    createTestPluginApi({
      id: "cua-computer",
      config: enabledConfig,
      registerNodeHostCommand: (command) => commands.push(command),
      registerNodeInvokePolicy: (policy) => policies.push(policy),
      ...overrides,
    }),
  );
  return { commands, policies };
}

function validateManifestConfig(value: unknown) {
  return validateJsonSchemaValue({
    cacheKey: "cua-computer.manifest.config.test",
    schema: manifest.configSchema as JsonSchemaObject,
    value,
  });
}

describe("cua-computer plugin registration", () => {
  beforeEach(() => {
    artifactMocks.verify.mockReset().mockReturnValue({ ok: true, applicable: false });
    artifactMocks.registerDoctor.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  });

  it("enables Gateway policy by default while keeping explicit plugin disable authoritative", () => {
    expect(manifest.enabledByDefault).toBe(true);
    expect(manifest).not.toHaveProperty("enabledByDefaultOnPlatforms");
    expect(
      resolveEffectiveEnableState({
        id: "cua-computer",
        origin: "bundled",
        enabledByDefault: manifest.enabledByDefault,
        config: normalizePluginsConfig({ entries: { "cua-computer": { enabled: false } } }),
      }).enabled,
    ).toBe(false);
  });

  it("loads only remote policy by default on Linux", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    const { commands, policies } = registerPlugin({ config: {} });
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ commands: ["computer.act"], dangerous: true });
    expect(commands).toEqual([]);
    expect(artifactMocks.verify).not.toHaveBeenCalled();
    expect(artifactMocks.registerDoctor).not.toHaveBeenCalled();
  });

  it("preserves native provider activation on darwin", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    const { commands } = registerPlugin({ config: {} });
    expect(commands.map((command) => command.command)).toEqual(["screen.snapshot", "computer.act"]);
    expect(artifactMocks.verify).toHaveBeenCalledOnce();
    expect(artifactMocks.registerDoctor).toHaveBeenCalledOnce();
  });

  it("accepts the retired driver path as a no-op while keeping both schemas strict", () => {
    const config = { driverPath: "/usr/local/bin/cua-driver" };
    expect(plugin.configSchema.safeParse?.(config)).toEqual({ success: true, data: config });
    expect(validateManifestConfig(config).ok).toBe(true);
    expect(plugin.configSchema.safeParse?.({ unexpected: true }).success).toBe(false);
    expect(validateManifestConfig({ unexpected: true }).ok).toBe(false);
    expect(plugin.configSchema).not.toHaveProperty("uiHints");

    const { commands } = registerPlugin({ pluginConfig: config });
    expect(commands.map(({ command, cap, dangerous }) => ({ command, cap, dangerous }))).toEqual([
      { command: "screen.snapshot", cap: "screen", dangerous: false },
      { command: "computer.act", cap: "computer", dangerous: true },
    ]);
  });

  it("logs the typed artifact diagnostic during plugin startup", () => {
    const error = vi.fn();
    const diagnostic =
      "COMPUTER_DRIVER_PACKAGE_MISSING: native package absent. Fix: reinstall OpenClaw.";
    artifactMocks.verify.mockReturnValue({
      ok: false,
      code: "COMPUTER_DRIVER_PACKAGE_MISSING",
      diagnostic,
      fixHint: "Reinstall OpenClaw.",
    });

    registerPlugin({ logger: { info() {}, warn() {}, error } });
    expect(error).toHaveBeenCalledWith(diagnostic);
  });

  it("forwards an explicitly armed computer action and preserves node refusals", async () => {
    const { policies } = registerPlugin();
    const refusal = {
      ok: false as const,
      code: "INVALID_REQUEST",
      message: "COMPUTER_STALE_FRAME: take a new screenshot",
    };
    const invokeNode = vi.fn(async () => refusal);

    await expect(
      policies[0]!.handle({
        invokeNode,
        risk: { level: "ordinary", family: "input" },
      } as unknown as OpenClawPluginNodeInvokePolicyContext),
    ).resolves.toEqual(refusal);
    expect(invokeNode).toHaveBeenCalledOnce();
  });
});
