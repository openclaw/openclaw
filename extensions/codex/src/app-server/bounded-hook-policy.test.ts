import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCodexPrivateHookIsolation } from "./bounded-hook-policy.js";
import type { CodexAppServerClient } from "./client.js";
import type { JsonObject } from "./protocol.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture() {
  const root = await fs.realpath(tempDirs.make("codex-private-hook-policy-"));
  const workspace = { codexHome: path.join(root, "home"), cwd: path.join(root, "workspace") };
  await Promise.all(Object.values(workspace).map((directory) => fs.mkdir(directory)));
  const config: JsonObject = {
    config: { features: { hooks: true, plugins: false }, project_root_markers: [] },
    layers: [
      { name: { type: "system", file: "/etc/codex/config.toml" }, config: {} },
      { name: { type: "user", file: path.join(workspace.codexHome, "config.toml") }, config: {} },
      { name: { type: "sessionFlags" }, config: {} },
    ],
  };
  const inventory: JsonObject = {
    data: [
      {
        cwd: workspace.cwd,
        hooks: [{ key: "managed:pre_tool_use:0:0", enabled: true, isManaged: true }],
        warnings: [],
        errors: [],
      },
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
  it("preserves managed hooks and checks the private cwd before any thread starts", async () => {
    const state = await fixture();
    const signal = new AbortController().signal;
    await expect(
      assertCodexPrivateHookIsolation(state.client, state.workspace, signal),
    ).resolves.toEqual({ activeManagedHooks: true });
    expect(state.request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "hooks/list",
    ]);
    expect(state.request).toHaveBeenCalledWith(
      "config/read",
      { cwd: state.workspace.cwd, includeLayers: true },
      { signal },
    );
    expect(state.request).toHaveBeenCalledWith(
      "hooks/list",
      { cwds: [state.workspace.cwd] },
      { signal },
    );
  });

  it.each(["user", "project"])(
    "rejects an ambient %s config even with no active hooks",
    async (type) => {
      const state = await fixture();
      state.config.layers = [
        {
          name:
            type === "user"
              ? { type, file: path.join(state.root, "ambient/config.toml") }
              : { type, dotCodexFolder: path.join(state.root, "ambient/.codex") },
          config: {},
        },
      ];
      await expect(assertCodexPrivateHookIsolation(state.client, state.workspace)).rejects.toThrow(
        "external user or project config layer",
      );
      expect(state.request).not.toHaveBeenCalledWith(
        "hooks/list",
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it("rejects a private-looking user profile that escapes through a symlink", async () => {
    const state = await fixture();
    const outside = path.join(state.root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(state.workspace.codexHome, "profiles"), "junction");
    state.config.layers = [
      {
        name: {
          type: "user",
          file: path.join(state.workspace.codexHome, "profiles/selected.toml"),
        },
        config: {},
      },
    ];
    await expect(assertCodexPrivateHookIsolation(state.client, state.workspace)).rejects.toThrow(
      "external user or project config layer",
    );
  });

  it("admits private profile and project layers alongside managed sources", async () => {
    const state = await fixture();
    state.config.layers = [
      { name: { type: "packagedDefaults" }, config: { hooks: { Stop: [] } } },
      { name: { type: "mdm", domain: "example", key: "config" }, config: {} },
      { name: { type: "enterpriseManaged", id: "policy", name: "Policy" }, config: {} },
      {
        name: {
          type: "user",
          file: path.join(state.workspace.codexHome, "profiles/selected.toml"),
          profile: "selected",
        },
        config: {},
      },
      {
        name: { type: "project", dotCodexFolder: path.join(state.workspace.cwd, ".codex") },
        config: {},
      },
    ];
    await expect(assertCodexPrivateHookIsolation(state.client, state.workspace)).resolves.toEqual({
      activeManagedHooks: true,
    });
  });

  it("requires a reported private home even when the hook inventory is empty", async () => {
    const state = await fixture();
    state.config.layers = [];
    state.inventory.data = [{ cwd: state.workspace.cwd, hooks: [], warnings: [], errors: [] }];
    await expect(assertCodexPrivateHookIsolation(state.client, state.workspace)).rejects.toThrow(
      "could not verify its private Codex home",
    );
  });

  it.each(["legacyManagedConfigTomlFromFile", "futureLayer"])(
    "rejects %s discovery layers",
    async (type) => {
      const state = await fixture();
      state.config.layers = [{ name: { type }, config: {} }];
      await expect(assertCodexPrivateHookIsolation(state.client, state.workspace)).rejects.toThrow(
        "unsupported config layer",
      );
    },
  );

  it.each(["packagedDefaults", "sessionFlags"])(
    "rejects unmanaged hook declarations in %s",
    async (type) => {
      const state = await fixture();
      state.config.layers = [
        {
          name: { type },
          config: { hooks: { SessionStart: [{ hooks: [{ command: "unexpected" }] }] } },
        },
      ];
      await expect(assertCodexPrivateHookIsolation(state.client, state.workspace)).rejects.toThrow(
        "unmanaged hook declarations",
      );
    },
  );

  it.each<JsonObject>([
    { features: { hooks: true, plugins: true }, project_root_markers: [] },
    { features: { hooks: true, plugins: false }, project_root_markers: [".git"] },
    { features: { plugins: false }, project_root_markers: [] },
  ])("rejects settings that cannot prove hook inventory isolation", async (config) => {
    const state = await fixture();
    state.config.config = config;
    await expect(assertCodexPrivateHookIsolation(state.client, state.workspace)).rejects.toThrow(
      "isolated hook discovery settings",
    );
  });

  it("accepts an explicit managed hooks disable without relying on an empty inventory", async () => {
    const state = await fixture();
    state.config.config = { features: { hooks: false, plugins: false }, project_root_markers: [] };
    state.requirements.requirements = { featureRequirements: { hooks: false } };
    await expect(assertCodexPrivateHookIsolation(state.client, state.workspace)).resolves.toEqual({
      activeManagedHooks: false,
    });
    expect(state.request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
    ]);
  });

  it("rejects disabled hooks without a managed disable requirement", async () => {
    const state = await fixture();
    state.config.config = { features: { hooks: false, plugins: false }, project_root_markers: [] };
    await expect(assertCodexPrivateHookIsolation(state.client, state.workspace)).rejects.toThrow(
      "cannot disable hooks without a managed requirement",
    );
  });

  it.each([
    { hooks: [{ key: "user:stop:0:0", enabled: true, isManaged: false }] },
    { hooks: [{ key: "unknown:stop:0:0", enabled: true }] },
    { warnings: ["Hook file could not be parsed"] },
    { errors: [{ message: "Config could not be loaded" }] },
    { cwd: "/other-workspace" },
  ])("rejects unsafe or incomplete hook inventory", async (entry) => {
    const state = await fixture();
    state.inventory.data = [
      { cwd: state.workspace.cwd, hooks: [], warnings: [], errors: [], ...entry },
    ];
    await expect(assertCodexPrivateHookIsolation(state.client, state.workspace)).rejects.toThrow(
      /hook/,
    );
  });
});
