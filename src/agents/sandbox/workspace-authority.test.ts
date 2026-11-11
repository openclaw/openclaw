import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { AgentSandboxConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { withPreparedSessionCapabilityRead } from "../subagents/spawn/subagent-session-store.js";
import { resolveSandboxRuntimeStatusAsync } from "./runtime-status.js";
import { resolveSandboxWorkspaceAuthority } from "./workspace-authority.js";

type Overrides = Partial<
  Omit<Parameters<typeof resolveSandboxWorkspaceAuthority>[0], "config" | "preparedRuntimeStatus">
>;
const safeTools = ["exec", "process", "read", "write", "edit", "apply_patch"];
const completionTool = "workboard_complete";
const lifecycle = { confinedToolNames: [completionTool], requiredToolNames: [completionTool] };

function config(
  sandbox: AgentSandboxConfig = {},
  tools: OpenClawConfig["tools"] = {},
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: "/workspace",
        sandbox: {
          mode: "all",
          workspaceAccess: "rw",
          scope: "session",
          ...sandbox,
        },
      },
      entries: { main: { workspace: "/workspace" } },
    },
    tools: { sandbox: { tools: { allow: safeTools } }, ...tools },
  };
}
function lifecycleConfig(tools: OpenClawConfig["tools"] = {}, allow = [completionTool]) {
  return config({}, { sandbox: { tools: { allow: [...safeTools, ...allow] } }, ...tools });
}
async function authority(cfg: OpenClawConfig, overrides: Overrides = {}) {
  const params = {
    config: cfg,
    agentId: "main",
    sessionKey: "agent:main:subagent:workboard-card",
    ...overrides,
  };
  const preparedRuntimeStatus = await resolveSandboxRuntimeStatusAsync({
    cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  return withPreparedSessionCapabilityRead(() =>
    resolveSandboxWorkspaceAuthority({ ...params, preparedRuntimeStatus }),
  );
}
async function confinement(cfg: OpenClawConfig, overrides?: Overrides) {
  return (await authority(cfg, overrides)).confinementError;
}

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "sandbox-workspace-authority",
    layout: "state-only",
  });
});
afterEach(async () => {
  await state.cleanup();
});
function storePath() {
  return path.join(
    fs.mkdtempSync(path.join(state.root, "authority-")),
    "agents/main/sessions/sessions.json",
  );
}

it.each([
  ["docker", "rw"],
  ["Podman", "rw"],
  ["docker", "ro"],
] as const)("attests %s workspace with %s access", async (backend, workspaceAccess) => {
  expect(await authority(config({ backend, workspaceAccess }))).toEqual({
    sandboxed: true,
    workspaceAccess,
  });
});

it("caps role-required access and rejects principal-shared worker authority", async () => {
  const sessionKey = "agent:main:guest-worker";
  const store = storePath();
  await replaceSessionEntry(
    { sessionKey, storePath: store },
    {
      sessionId: "guest-worker",
      updatedAt: Date.now(),
      sandbox: "required",
      createdActor: { type: "human", source: "unknown", id: "guest-principal" },
    },
  );
  const cfg = config({ mode: "off" });
  cfg.session = { store };
  expect(await authority(cfg, { sessionKey })).toMatchObject({
    sandboxed: true,
    workspaceAccess: "ro",
    confinementError: expect.stringContaining("not exclusive"),
  });
});

it.each<[AgentSandboxConfig, NonNullable<OpenClawConfig["tools"]>, string]>([
  [{ docker: { dangerouslyAllowExternalBindSources: true } }, {}, "dangerous Docker"],
  [{}, { exec: { host: "gateway" } }, "outside the sandbox"],
  [{ scope: "agent" }, {}, "not exclusive"],
  [{ scope: "shared" }, {}, "not exclusive"],
  [{}, { elevated: { enabled: true } }, "elevated execution"],
  [
    {},
    {
      sandbox: { tools: { allow: [...safeTools, "sessions_spawn"] } },
      subagents: { tools: { alsoAllow: ["sessions_spawn"] } },
    },
    "sessions_spawn",
  ],
])("rejects unconfined configuration: %j %j (%s)", async (sandbox, tools, error) => {
  expect(await authority(config(sandbox, tools))).toMatchObject({
    sandboxed: true,
    confinementError: expect.stringContaining(error),
  });
});

it("uses the runtime session visibility clamp", async () => {
  const cfg = config({ sessionToolsVisibility: "all" }, { sessions: { visibility: "all" } });
  cfg.agents!.entries!.main!.sandbox = { sessionToolsVisibility: "spawned" };
  expect(await confinement(cfg)).toContain("host-wide sessions");
});

it("ignores unconfined tools denied by the effective policy stack", async () => {
  expect(
    await confinement(
      config(
        {},
        {
          sandbox: { tools: { allow: [...safeTools, "sessions_spawn"] } },
          subagents: { tools: { deny: ["sessions_spawn"] } },
        },
      ),
    ),
  ).toBeUndefined();
});

it.each([{ execHost: "gateway" }, { execHost: "auto", execNode: "build-node" }])(
  "rejects persisted session host override %j",
  async (sessionEntry) => {
    expect(await confinement(config(), { sessionEntry })).toContain("outside the sandbox");
  },
);
it.each([[], ["group:plugins"], ["bundle-mcp"], ["custom_tool"]].map((allow) => ({ allow })))(
  "rejects unclassified tool surface $allow",
  async ({ allow }) => {
    expect(await confinement(config({}, { sandbox: { tools: { allow } } }))).toContain(
      "unclassified tool surface",
    );
  },
);

it("trusts only caller-enumerated plugin tools", async () => {
  expect(
    await confinement(lifecycleConfig({}, [completionTool, "workboard_shell"]), {
      confinedToolNames: [completionTool],
    }),
  ).toContain("workboard_shell");
});
it("requires lifecycle tools across the complete effective policy", async () => {
  expect(await confinement(lifecycleConfig({}, []), lifecycle)).toContain(
    "required tool workboard_complete",
  );
  const denied = lifecycleConfig({ deny: [completionTool] });
  expect(await confinement(denied, lifecycle)).toContain("required tool workboard_complete");
  denied.tools!.deny = [];
  expect(await confinement(denied, lifecycle)).toBeUndefined();
});
it("applies profile alsoAllow to required lifecycle tools", async () => {
  expect(
    await confinement(
      lifecycleConfig({ profile: "minimal", alsoAllow: [completionTool] }),
      lifecycle,
    ),
  ).toBeUndefined();
});
it("applies the configured target model's provider policy", async () => {
  const cfg = lifecycleConfig({ byProvider: { anthropic: { deny: [completionTool] } } });
  cfg.agents!.defaults!.model = "anthropic/claude-sonnet-4-6";
  expect(await confinement(cfg, lifecycle)).toContain("required tool workboard_complete");
});
it("applies inherited session denies to required lifecycle tools", async () => {
  const sessionKey = "agent:main:subagent:workboard-card";
  const store = storePath();
  await replaceSessionEntry(
    { sessionKey, storePath: store },
    {
      sessionId: "workboard-card",
      updatedAt: Date.now(),
      inheritedToolDeny: [completionTool],
    },
  );
  const cfg = lifecycleConfig();
  cfg.session = { store };
  expect(await confinement(cfg, { sessionKey, ...lifecycle })).toContain(
    "required tool workboard_complete",
  );
});
