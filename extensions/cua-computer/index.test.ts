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

const artifactMocks = vi.hoisted(() => ({ verify: vi.fn(), registerDoctor: vi.fn() }));

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
const resourceHandle = "openclaw:computer-resource:v1:123e4567-e89b-42d3-a456-426614174000";

function registerPlugin(overrides: TestPluginApiInput = {}) {
  const commands: OpenClawPluginNodeHostCommand[] = [];
  const policies: OpenClawPluginNodeInvokePolicy[] = [];
  const api = createTestPluginApi({
    id: "cua-computer",
    config: enabledConfig,
    registerNodeHostCommand: (command) => commands.push(command),
    registerNodeInvokePolicy: (policy) => policies.push(policy),
    ...overrides,
  });
  plugin.register(api);
  return { commands, policies };
}

function validateManifestConfig(value: unknown) {
  return validateJsonSchemaValue({
    cacheKey: "cua-computer.manifest.config.test",
    schema: manifest.configSchema as JsonSchemaObject,
    value,
  });
}

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
  const state = resolveEffectiveEnableState({
    id: "cua-computer",
    origin: "bundled",
    enabledByDefault: manifest.enabledByDefault,
    config: normalizePluginsConfig({ entries: { "cua-computer": { enabled: false } } }),
  });
  expect(state.enabled).toBe(false);
});

it.each([
  { platform: "linux", nativeCalls: 0, commandNames: [] },
  { platform: "darwin", nativeCalls: 1, commandNames: ["screen.snapshot", "computer.act"] },
])(
  "registers platform-appropriate defaults on $platform",
  ({ platform, nativeCalls, commandNames }) => {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    const { commands, policies } = registerPlugin({ config: {} });
    expect(policies).toMatchObject([{ commands: ["computer.act"], dangerous: true }]);
    expect(commands.map((command) => command.command)).toEqual(commandNames);
    expect(artifactMocks.verify).toHaveBeenCalledTimes(nativeCalls);
    expect(artifactMocks.registerDoctor).toHaveBeenCalledTimes(nativeCalls);
  },
);

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
  artifactMocks.verify.mockReturnValue({ ok: false, diagnostic });

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

  const context = {
    invokeNode,
    risk: { level: "ordinary", family: "input" },
  } as unknown as OpenClawPluginNodeInvokePolicyContext;
  await expect(policies[0]!.handle(context)).resolves.toEqual(refusal);
  expect(invokeNode).toHaveBeenCalledOnce();
  delete context.risk;
  await expect(policies[0]!.handle(context)).resolves.toMatchObject({
    ok: false,
    code: "COMPUTER_RISK_UNCLASSIFIED",
  });
  expect(invokeNode).toHaveBeenCalledOnce();
});

describe("registered CUA Computer risk policy", () => {
  const classifyRisk = (params: unknown) => {
    const classify = registerPlugin().policies[0]?.classifyRisk;
    if (!classify) {
      throw new Error("missing CUA Computer risk classifier");
    }
    return classify({ command: "computer.act", params });
  };

  it.each([
    [{ action: "kill_app", app: "app-ref" }, "process_termination"],
    [
      { action: "browser_navigate", browserRef: "browser", pageRef: "page", url: "about:blank" },
      "browser_navigation",
    ],
    [
      {
        action: "browser_download",
        browserRef: "browser",
        pageRef: "page",
        observationId: "observation",
        elementRef: "element",
      },
      "browser_download",
    ],
    [
      {
        action: "browser_set_input_files",
        browserRef: "browser",
        pageRef: "page",
        observationId: "observation",
        elementRef: "element",
        resourceHandles: [resourceHandle],
      },
      "browser_file_input",
    ],
    [{ action: "start_recording" }, "recording_start"],
    [{ action: "replay_trajectory", resourceHandle }, "recording_replay"],
    [{ action: "escalate_scope", reason: "other" }, "desktop_scope_escalation"],
  ])("classifies $family as high risk", (params, family) => {
    expect(classifyRisk(params)).toEqual({ level: "high", family });
  });

  it("distinguishes ordinary observation, input, and lifecycle arguments", () => {
    expect(classifyRisk({ action: "list_windows" })).toEqual({
      level: "ordinary",
      family: "observation",
    });
    expect(
      classifyRisk({
        action: "zoom",
        windowRef: "window",
        observationId: "observation",
        x1: 0,
        y1: 0,
        x2: 100,
        y2: 100,
      }),
    ).toEqual({ level: "ordinary", family: "observation" });
    expect(classifyRisk({ action: "type", text: "hello", windowRef: "window" })).toEqual({
      level: "ordinary",
      family: "input",
    });
    expect(
      classifyRisk({
        action: "__close_execution",
        executionId: "123e4567-e89b-42d3-a456-426614174000",
        reason: "completion",
      }),
    ).toEqual({ level: "ordinary", family: "execution_lifecycle" });
  });

  it("rejects raw provider calls and native process controls before dispatch", () => {
    for (const params of [
      { providerTool: "click", arguments: { x: 1, y: 2 } },
      { action: "left_click", binaryPath: "/tmp/cua-driver" },
      { action: "left_click", socketPath: "/tmp/cua.sock" },
      { action: "left_click", session: "native-session" },
      { action: "left_click", driverArgs: ["--dangerously-bypass-approvals"] },
    ]) {
      expect(() => classifyRisk(params)).toThrow("COMPUTER_INVALID_REQUEST");
    }
  });
});
