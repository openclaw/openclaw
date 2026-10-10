/** Tests plugin-owned CLI backend resolution and runtime bindings. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type {
  CliBackendConfig,
  CliBackendPlugin,
  CliBackendRuntimeArtifactPolicy,
} from "../plugins/cli-backend.types.js";
import {
  isCliRuntimeModelBackendForProvider,
  listCliRuntimeModelBackendBindings,
  listCliRuntimeProviderIds,
  resolveCliBackendConfig,
  resolveCliBackendLiveTest,
  resolveCliRuntimeCanonicalProvider,
  resolveCliRuntimeModelBackendBinding,
} from "./cli-backends.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";

type RuntimeBackendEntry = ReturnType<
  (typeof import("../plugins/cli-backends.runtime.js"))["resolveRuntimeCliBackends"]
>[number];
type SetupBackendEntry = NonNullable<
  ReturnType<(typeof import("../plugins/setup-registry.js"))["resolvePluginSetupCliBackend"]>
>;
type CliBackendOverrides = Partial<
  Omit<CliBackendPlugin, "ownsNativeCompaction" | "manualCompaction">
> &
  (
    | {
        ownsNativeCompaction: true;
        manualCompaction?: NonNullable<CliBackendPlugin["manualCompaction"]>;
      }
    | {
        ownsNativeCompaction?: false;
        manualCompaction?: never;
      }
  );

const runtimeArtifact: CliBackendRuntimeArtifactPolicy = {
  kind: "bundled-package-tree",
  packageName: "@fixture/acme-cli",
  entrypoint: "command",
};
function createBackend(overrides: CliBackendOverrides = {}): CliBackendPlugin {
  const base = {
    id: "acme-cli",
    modelProvider: "acme",
    config: {
      command: "acme",
      args: ["chat", "--json"],
      output: "json",
      input: "stdin",
      modelArg: "--model",
      sessionArgs: ["--session", "{sessionId}"],
      sessionMode: "existing",
    },
    ownsNativeCompaction: overrides.ownsNativeCompaction === true,
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    runtimeArtifact,
    liveTest: {
      defaultModelRef: "acme/acme-large",
      defaultImageProbe: true,
      defaultMcpProbe: false,
      docker: {
        npmPackage: "@fixture/acme-cli",
        binaryName: "acme",
      },
    },
  } satisfies CliBackendPlugin;
  return overrides.ownsNativeCompaction === true
    ? { ...base, ...overrides, ownsNativeCompaction: true }
    : { ...base, ...overrides, ownsNativeCompaction: false };
}

function runtimeEntry(
  overrides: CliBackendOverrides = {},
  pluginId = "acme-plugin",
): RuntimeBackendEntry {
  return { ...createBackend(overrides), pluginId } as RuntimeBackendEntry;
}

function setupEntry(
  overrides: CliBackendOverrides = {},
  pluginId = "acme-plugin",
): SetupBackendEntry {
  return {
    pluginId,
    source: "test",
    backend: createBackend(overrides),
  } as SetupBackendEntry;
}

function requireBackend(provider = "acme-cli", cfg?: OpenClawConfig) {
  const resolved = resolveCliBackendConfig(provider, cfg);
  if (!resolved) {
    throw new Error(`Expected CLI backend ${provider}`);
  }
  return resolved;
}

beforeEach(() => {
  const entries = [runtimeEntry()];
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => entries,
    resolvePluginSetupCliBackend: () => undefined,
    resolvePluginSetupRegistry: () => ({ cliBackends: [] }) as never,
  });
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
});

describe("resolveCliBackendConfig", () => {
  it("normalizes the registered adapter with agent and runtime config context", () => {
    const normalizeConfig = vi.fn((config: CliBackendConfig): CliBackendConfig => ({
      ...config,
      args: [...(config.args ?? []), "--normalized"],
    }));
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [runtimeEntry({ normalizeConfig })],
      resolvePluginSetupCliBackend: () => undefined,
    });
    const cfg: OpenClawConfig = { tools: { exec: { mode: "ask" } } };

    const resolved = resolveCliBackendConfig("acme-cli", cfg, { agentId: "reviewer" });

    expect(resolved?.config.args).toEqual(["chat", "--json", "--normalized"]);
    expect(normalizeConfig).toHaveBeenCalledWith(expect.objectContaining({ command: "acme" }), {
      backendId: "acme-cli",
      agentId: "reviewer",
      config: cfg,
    });
  });

  it("falls back to setup registration before runtime activation", () => {
    const parseJsonlEvent = vi.fn();
    const resolveModelId = vi.fn(
      ({ modelId, contextWindow }: { modelId: string; contextWindow?: string }) =>
        contextWindow === "1m" ? `${modelId}[1m]` : modelId,
    );
    const entry = setupEntry({
      config: { command: "setup-acme", args: ["run"] },
      parseJsonlEvent,
      resolveModelId,
    });
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: ({ backend }) => (backend === "acme-cli" ? entry : undefined),
    });

    const resolved = requireBackend();

    expect(resolved.pluginId).toBeUndefined();
    expect(resolved.config).toEqual({ command: "setup-acme", args: ["run"] });
    expect(resolved.runtimeArtifact).toEqual(runtimeArtifact);
    expect(resolved.parseJsonlEvent).toBe(parseJsonlEvent);
    expect(resolved.resolveModelId?.({ modelId: "acme-large", contextWindow: "1m" })).toBe(
      "acme-large[1m]",
    );
  });

  it("returns null when no plugin owns the backend", () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: () => undefined,
    });

    expect(resolveCliBackendConfig("missing-cli")).toBeNull();
  });
});

describe("CLI backend metadata and bindings", () => {
  it("returns plugin-owned live smoke metadata", () => {
    expect(resolveCliBackendLiveTest("acme-cli")).toEqual({
      defaultModelRef: "acme/acme-large",
      defaultImageProbe: true,
      defaultMcpProbe: false,
      dockerNpmPackage: "@fixture/acme-cli",
      dockerBinaryName: "acme",
    });
  });

  it("lists canonical provider to CLI runtime bindings", () => {
    expect(listCliRuntimeModelBackendBindings()).toEqual([
      { provider: "acme", runtime: "acme-cli" },
    ]);
    expect(listCliRuntimeProviderIds()).toEqual(["acme-cli"]);
    expect(resolveCliRuntimeCanonicalProvider({ runtime: "ACME-CLI" })).toBe("acme");
    expect(resolveCliRuntimeModelBackendBinding({ provider: "acme", runtime: "acme-cli" })).toEqual(
      { provider: "acme", runtime: "acme-cli" },
    );
    expect(isCliRuntimeModelBackendForProvider({ provider: "acme", runtime: "acme-cli" })).toBe(
      true,
    );
  });

  it("includes setup bindings only when requested", () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: ({ backend }) =>
        backend === "acme-cli" ? setupEntry() : undefined,
      resolvePluginSetupRegistry: () => ({ cliBackends: [setupEntry()] }) as never,
    });

    expect(listCliRuntimeModelBackendBindings()).toEqual([]);
    expect(listCliRuntimeModelBackendBindings({ includeSetupRegistry: true })).toEqual([
      { provider: "acme", runtime: "acme-cli" },
    ]);
  });
});
