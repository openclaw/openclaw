import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

type AuthorityParams = Omit<
  Parameters<typeof resolveSandboxWorkspaceAuthority>[0],
  "preparedRuntimeStatus"
>;

async function prepareWorkspaceAuthority(
  config: OpenClawConfig,
  overrides: Partial<Omit<AuthorityParams, "config">> = {},
) {
  const params = {
    config,
    agentId: "main",
    sessionKey: "agent:main:subagent:workboard-card",
    ...overrides,
  };
  const preparedRuntimeStatus = await resolveSandboxRuntimeStatusAsync({
    cfg: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  return withPreparedSessionCapabilityRead(() =>
    resolveSandboxWorkspaceAuthority({ ...params, preparedRuntimeStatus }),
  );
}

const SAFE_WORKBOARD_TOOLS = ["exec", "process", "read", "write", "edit", "apply_patch"];
const completionTool = "workboard_complete";
const lifecycleTools = { confinedToolNames: [completionTool], requiredToolNames: [completionTool] };

function configWithSandbox(
  sandbox: AgentSandboxConfig = {},
  tools: OpenClawConfig["tools"] = {},
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: "/workspace",
        sandbox: { mode: "all", workspaceAccess: "rw", scope: "session", ...sandbox },
      },
      entries: { main: { workspace: "/workspace" } },
    },
    tools: {
      sandbox: { tools: { allow: SAFE_WORKBOARD_TOOLS } },
      ...tools,
    },
  };
}

function lifecycleConfig(tools: OpenClawConfig["tools"] = {}, allow = [completionTool]) {
  return configWithSandbox(
    {},
    {
      sandbox: { tools: { allow: [...SAFE_WORKBOARD_TOOLS, ...allow] } },
      ...tools,
    },
  );
}

describe("resolveSandboxWorkspaceAuthority", () => {
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

  function createSessionStorePath(prefix: string): string {
    const root = fs.mkdtempSync(path.join(state.root, prefix));
    return path.join(root, "agents", "main", "sessions", "sessions.json");
  }

  it.each(["docker", "Podman"])("attests a writable %s workspace", async (backend) => {
    const result = await prepareWorkspaceAuthority(configWithSandbox({ backend }));
    expect(result).toEqual({ sandboxed: true, workspaceAccess: "rw" });
  });

  it("preserves read-only authority", async () => {
    expect(await prepareWorkspaceAuthority(configWithSandbox({ workspaceAccess: "ro" }))).toEqual({
      sandboxed: true,
      workspaceAccess: "ro",
    });
  });

  it("caps role-required access and rejects principal-shared worker authority", async () => {
    const sessionKey = "agent:main:guest-worker";
    const storePath = createSessionStorePath("openclaw-required-workspace-authority-");
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "guest-worker",
        updatedAt: Date.now(),
        sandbox: "required",
        createdActor: { type: "human", source: "unknown", id: "guest-principal" },
      },
    );
    const config = configWithSandbox({ mode: "off", scope: "session", workspaceAccess: "rw" });
    config.session = { store: storePath };

    expect(await prepareWorkspaceAuthority(config, { sessionKey })).toMatchObject({
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
        sandbox: { tools: { allow: [...SAFE_WORKBOARD_TOOLS, "sessions_spawn"] } },
        subagents: { tools: { alsoAllow: ["sessions_spawn"] } },
      },
      "sessions_spawn",
    ],
  ])("rejects unconfined configuration: %j %j (%s)", async (sandbox, tools, error) => {
    expect(await prepareWorkspaceAuthority(configWithSandbox(sandbox, tools))).toMatchObject({
      sandboxed: true,
      confinementError: expect.stringContaining(error),
    });
  });

  it("uses the runtime session visibility clamp", async () => {
    const config = configWithSandbox({ sessionToolsVisibility: "all" });
    config.agents!.entries!.main!.sandbox = { sessionToolsVisibility: "spawned" };
    config.tools!.sessions = { visibility: "all" };

    const result = await prepareWorkspaceAuthority(config);
    expect(result.confinementError).toContain("host-wide sessions");
  });

  it("ignores unconfined tools denied by the effective policy stack", async () => {
    const config = configWithSandbox();
    config.tools!.sandbox!.tools!.allow = [...SAFE_WORKBOARD_TOOLS, "sessions_spawn"];
    config.tools!.subagents = { tools: { deny: ["sessions_spawn"] } };

    const result = await prepareWorkspaceAuthority(config);
    expect(result.confinementError).toBeUndefined();
  });

  it.each([{ execHost: "gateway" }, { execHost: "auto", execNode: "build-node" }])(
    "rejects persisted session host override %j",
    async (sessionEntry) => {
      const result = await prepareWorkspaceAuthority(configWithSandbox(), { sessionEntry });
      expect(result.confinementError).toContain("outside the sandbox");
    },
  );

  it.each([[], ["group:plugins"], ["bundle-mcp"], ["custom_tool"]].map((allow) => ({ allow })))(
    "rejects unclassified tool surface $allow",
    async ({ allow }) => {
      const config = configWithSandbox({}, { sandbox: { tools: { allow } } });
      expect((await prepareWorkspaceAuthority(config)).confinementError).toContain(
        "unclassified tool surface",
      );
    },
  );

  it("trusts only caller-enumerated plugin tools", async () => {
    const config = lifecycleConfig({}, [completionTool, "workboard_shell"]);
    const result = await prepareWorkspaceAuthority(config, {
      confinedToolNames: [completionTool],
    });

    expect(result.confinementError).toContain("workboard_shell");
  });

  it("requires lifecycle tools across the complete effective policy", async () => {
    const missingResult = await prepareWorkspaceAuthority(lifecycleConfig({}, []), lifecycleTools);
    expect(missingResult.confinementError).toContain("required tool workboard_complete");
    const denied = lifecycleConfig({ deny: [completionTool] });
    const deniedResult = await prepareWorkspaceAuthority(denied, lifecycleTools);
    expect(deniedResult.confinementError).toContain("required tool workboard_complete");

    denied.tools!.deny = [];
    expect(
      (await prepareWorkspaceAuthority(denied, lifecycleTools)).confinementError,
    ).toBeUndefined();
  });

  it("applies profile alsoAllow to required lifecycle tools", async () => {
    const config = lifecycleConfig({ profile: "minimal", alsoAllow: [completionTool] });
    const result = await prepareWorkspaceAuthority(config, lifecycleTools);
    expect(result.confinementError).toBeUndefined();
  });

  it("applies the configured target model's provider policy", async () => {
    const config = lifecycleConfig({ byProvider: { anthropic: { deny: [completionTool] } } });
    config.agents!.defaults!.model = "anthropic/claude-sonnet-4-6";

    const result = await prepareWorkspaceAuthority(config, lifecycleTools);
    expect(result.confinementError).toContain("required tool workboard_complete");
  });

  it("applies inherited session denies to required lifecycle tools", async () => {
    const sessionKey = "agent:main:subagent:workboard-card";
    const storePath = createSessionStorePath("openclaw-workspace-authority-");
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "workboard-card",
        updatedAt: Date.now(),
        inheritedToolDeny: [completionTool],
      },
    );
    const config = lifecycleConfig();
    config.session = { store: storePath };

    const result = await prepareWorkspaceAuthority(config, { sessionKey, ...lifecycleTools });
    expect(result.confinementError).toContain("required tool workboard_complete");
  });
});
