import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertCodexPrivateHookIsolation } from "./bounded-hook-policy.js";
import type { CodexAppServerClient } from "./client.js";
import type { JsonObject } from "./protocol.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const layer = (name: JsonObject, config: JsonObject = {}) => ({ name, config });
const discoveryConfig = (hooks: boolean) => ({
  features: { hooks, plugins: false },
  project_root_markers: [],
});
const inventoryEntry = (cwd: string, overrides: JsonObject = {}) => ({
  cwd,
  hooks: [],
  warnings: [],
  errors: [],
  ...overrides,
});
const assertIsolation = (state: Awaited<ReturnType<typeof fixture>>) =>
  assertCodexPrivateHookIsolation(state.client, state.workspace);
const rejectsIsolation = (state: Awaited<ReturnType<typeof fixture>>, reason: string | RegExp) =>
  expect(assertIsolation(state)).rejects.toThrow(reason);

async function fixture() {
  const root = await fs.realpath(tempDirs.make("codex-private-hook-policy-"));
  const workspace = { codexHome: path.join(root, "home"), cwd: path.join(root, "workspace") };
  await Promise.all(Object.values(workspace).map((directory) => fs.mkdir(directory)));
  const config: JsonObject = {
    config: discoveryConfig(true),
    layers: [
      layer({ type: "packagedDefaults" }, { hooks: { Stop: [] } }),
      ...["mdm", "system", "enterpriseManaged"].map((type) => layer({ type })),
      layer({
        type: "user",
        file: path.join(workspace.codexHome, "profiles/selected.toml"),
      }),
      layer({ type: "project", dotCodexFolder: path.join(workspace.cwd, ".codex") }),
      layer({ type: "sessionFlags" }),
    ],
  };
  const inventory: JsonObject = {
    data: [
      inventoryEntry(workspace.cwd, {
        hooks: [{ key: "managed:pre_tool_use:0:0", enabled: true, isManaged: true }],
      }),
    ],
  };
  const requirements: JsonObject = { requirements: { featureRequirements: {} } };
  const request = vi.fn(async (method: string) => {
    if (method === "config/read") {
      return config;
    }
    if (method === "configRequirements/read") {
      return requirements;
    }
    if (method === "hooks/list") {
      return inventory;
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = { request } as unknown as Pick<CodexAppServerClient, "request">;
  return { root, workspace, config, inventory, requirements, request, client };
}

describe("private Codex hook isolation", () => {
  let state: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    state = await fixture();
  });
  it.each(["user", "project"])(
    "rejects an ambient %s config even with no active hooks",
    async (type) => {
      state.config.layers = [
        layer(
          type === "user"
            ? { type, file: path.join(state.root, "ambient/config.toml") }
            : { type, dotCodexFolder: path.join(state.root, "ambient/.codex") },
        ),
      ];
      await rejectsIsolation(state, "external user or project config layer");
      expect(state.request).not.toHaveBeenCalledWith(
        "hooks/list",
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it("rejects a private-looking user profile that escapes through a symlink", async () => {
    const outside = path.join(state.root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(state.workspace.codexHome, "profiles"), "junction");
    state.config.layers = [
      layer({ type: "user", file: path.join(state.workspace.codexHome, "profiles/selected.toml") }),
    ];
    await rejectsIsolation(state, "external user or project config layer");
  });

  it.each([
    [[], "could not verify its private Codex home"],
    [[layer({ type: "legacyManagedConfigTomlFromFile" })], "unsupported config layer"],
  ] as const)("rejects unverified layers %j", async (layers, reason) => {
    state.config.layers = [...layers];
    state.inventory.data = [inventoryEntry(state.workspace.cwd)];
    await rejectsIsolation(state, reason);
  });

  it.each(["packagedDefaults", "sessionFlags"])(
    "rejects unmanaged hook declarations in %s",
    async (type) => {
      state.config.layers = [
        layer({ type }, { hooks: { SessionStart: [{ hooks: [{ command: "unexpected" }] }] } }),
      ];
      await rejectsIsolation(state, "unmanaged hook declarations");
    },
  );

  it.each<JsonObject>([
    { features: { hooks: true, plugins: true }, project_root_markers: [] },
    { features: { hooks: true, plugins: false }, project_root_markers: [".git"] },
    { features: { plugins: false }, project_root_markers: [] },
  ])("rejects settings that cannot prove hook inventory isolation", async (config) => {
    state.config.config = config;
    await rejectsIsolation(state, "isolated hook discovery settings");
  });

  it("accepts an explicit managed hooks disable without relying on an empty inventory", async () => {
    state.config.config = discoveryConfig(false);
    state.requirements.requirements = { featureRequirements: { hooks: false } };
    await expect(assertIsolation(state)).resolves.toEqual({
      activeManagedHooks: false,
    });
    expect(state.request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
    ]);
  });

  it("rejects disabled hooks without a managed disable requirement", async () => {
    state.config.config = discoveryConfig(false);
    await rejectsIsolation(state, "cannot disable hooks without a managed requirement");
  });

  it.each([
    { hooks: [{ key: "user:stop:0:0", enabled: true, isManaged: false }] },
    { hooks: [{ key: "unknown:stop:0:0", enabled: true }] },
    { warnings: ["Hook file could not be parsed"] },
    { errors: [{ message: "Config could not be loaded" }] },
    { cwd: "/other-workspace" },
  ])("rejects unsafe or incomplete hook inventory", async (entry) => {
    state.inventory.data = [inventoryEntry(state.workspace.cwd, entry)];
    await rejectsIsolation(state, /hook/);
  });
});
