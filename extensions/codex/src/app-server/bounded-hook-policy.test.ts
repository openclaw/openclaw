import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertCodexPrivateHookIsolation } from "./bounded-hook-policy.js";
import type { CodexAppServerClient } from "./client.js";
import type { JsonObject, JsonValue } from "./protocol.js";

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
const userLayer = (home: string) =>
  layer({ type: "user", file: path.join(home, "profiles/selected.toml") });

async function fixture() {
  const root = await fs.realpath(tempDirs.make("codex-private-hook-policy-"));
  const workspace = { codexHome: path.join(root, "home"), cwd: path.join(root, "workspace") };
  await Promise.all(Object.values(workspace).map((directory) => fs.mkdir(directory)));
  const config: JsonObject = {
    config: discoveryConfig(true),
    layers: [
      layer({ type: "packagedDefaults" }, { hooks: { Stop: [] } }),
      ...["mdm", "system", "enterpriseManaged"].map((type) => layer({ type })),
      userLayer(workspace.codexHome),
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
  const responses: Record<string, JsonObject> = {
    "config/read": config,
    "configRequirements/read": requirements,
    "hooks/list": inventory,
  };
  const request = vi.fn(async (method: string) => {
    if (!Object.hasOwn(responses, method)) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return responses[method];
  });
  const client = { request } as unknown as Pick<CodexAppServerClient, "request">;
  return { root, workspace, config, inventory, requirements, request, client };
}

let state: Awaited<ReturnType<typeof fixture>>;
const assertIsolation = () => assertCodexPrivateHookIsolation(state.client, state.workspace);
const rejectsIsolation = (reason: string | RegExp) =>
  expect(assertIsolation()).rejects.toThrow(reason);
beforeEach(async () => {
  state = await fixture();
});
it.each(["user", "project"])("rejects ambient %s config before inventory", async (type) => {
  state.config.layers = [
    layer(
      type === "user"
        ? { type, file: path.join(state.root, "ambient/config.toml") }
        : { type, dotCodexFolder: path.join(state.root, "ambient/.codex") },
    ),
  ];
  await rejectsIsolation("external user or project config layer");
  expect(state.request.mock.calls.map(([method]) => method)).not.toContain("hooks/list");
});

it("rejects a private-looking user profile that escapes through a symlink", async () => {
  const outside = path.join(state.root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(state.workspace.codexHome, "profiles"), "junction");
  state.config.layers = [userLayer(state.workspace.codexHome)];
  await rejectsIsolation("external user or project config layer");
});

it.each<[string, JsonValue, string]>([
  ["layers", [], "could not verify its private Codex home"],
  ["layers", [layer({ type: "legacyManagedConfigTomlFromFile" })], "unsupported config layer"],
  ...["packagedDefaults", "sessionFlags"].map((type): [string, JsonValue, string] => [
    "layers",
    [layer({ type }, { hooks: { SessionStart: [{ hooks: [{ command: "unexpected" }] }] } })],
    "unmanaged hook declarations",
  ]),
  ...Array.of<JsonObject>(
    { features: { hooks: true, plugins: true }, project_root_markers: [] },
    { features: { hooks: true, plugins: false }, project_root_markers: [".git"] },
    { features: { plugins: false }, project_root_markers: [] },
  ).map((config): [string, JsonValue, string] => [
    "config",
    config,
    "isolated hook discovery settings",
  ]),
  ["config", discoveryConfig(false), "cannot disable hooks without a managed requirement"],
])("rejects unsafe %s: %j", async (key, value, reason) => {
  state.config[key] = value;
  await rejectsIsolation(reason);
});

it("accepts an explicit managed hooks disable without relying on an empty inventory", async () => {
  state.config.config = discoveryConfig(false);
  state.requirements.requirements = { featureRequirements: { hooks: false } };
  await expect(assertIsolation()).resolves.toEqual({ activeManagedHooks: false });
  expect(state.request.mock.calls.map(([method]) => method)).toEqual([
    "config/read",
    "configRequirements/read",
  ]);
});

it.each<JsonObject>([
  { hooks: [{ key: "user:stop:0:0", enabled: true, isManaged: false }] },
  { hooks: [{ key: "unknown:stop:0:0", enabled: true }] },
  { warnings: ["Hook file could not be parsed"] },
  { errors: [{ message: "Config could not be loaded" }] },
  { cwd: "/other-workspace" },
])("rejects unsafe or incomplete hook inventory", async (entry) => {
  state.inventory.data = [inventoryEntry(state.workspace.cwd, entry)];
  await rejectsIsolation(/hook/);
});
