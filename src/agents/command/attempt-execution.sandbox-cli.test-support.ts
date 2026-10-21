import { expect, it, type Mock } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { AgentHarnessPreflightError } from "../harness/errors.js";
import {
  makeCliResult,
  makeSessionEntry,
  type RunAgentAttemptOverrides,
} from "./attempt-execution.cli.test-support.js";
import type { runAgentAttempt } from "./attempt-execution.js";

type SandboxedCliHarness = {
  runStoredAttempt: (
    overrides: Omit<RunAgentAttemptOverrides, "agentDir" | "storePath" | "workspaceDir">,
  ) => ReturnType<typeof runAgentAttempt>;
  seedSessionStore: (key: string, entry: SessionEntry) => Promise<Record<string, SessionEntry>>;
  runCliAgentMock: Mock;
  runEmbeddedAgentMock: Mock;
  executePreparedCliRunMock: Mock;
};

const CLI_MODEL_REF = "anthropic/claude-opus-4-7";

function sandboxedCliConfig(params: { sandboxMode?: "all"; cliModel?: boolean }): OpenClawConfig {
  const models: Record<string, { agentRuntime: { id: string } }> = {};
  if (params.cliModel) {
    models[CLI_MODEL_REF] = { agentRuntime: { id: "claude-cli" } };
  }
  const sandbox = params.sandboxMode ? { sandbox: { mode: params.sandboxMode } } : {};
  return { agents: { defaults: { models, ...sandbox } } };
}

/**
 * Drives the real command attempt owner: classification, the sandbox guard,
 * and dispatch selection all run unmocked; only the CLI runner (the host
 * process launch) and the embedded runner are observed.
 */
export function registerSandboxedDelegatedCliTests(harness: SandboxedCliHarness) {
  const { runStoredAttempt, seedSessionStore } = harness;

  async function attempt(params: {
    sessionKey: string;
    entry: Partial<SessionEntry>;
    cfg: OpenClawConfig;
    overrides?: Partial<Omit<RunAgentAttemptOverrides, "agentDir" | "storePath" | "workspaceDir">>;
  }) {
    const sessionEntry = makeSessionEntry(`sandbox-cli-${params.sessionKey.split(":").at(-1)}`, {
      ...params.entry,
    });
    const sessionStore = await seedSessionStore(params.sessionKey, sessionEntry);
    return runStoredAttempt({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-7",
      cfg: params.cfg,
      sessionEntry,
      sessionKey: params.sessionKey,
      sessionStore,
      body: "delegated work",
      ...params.overrides,
    });
  }

  function expectNoDispatch() {
    expect(harness.runCliAgentMock).not.toHaveBeenCalled();
    expect(harness.executePreparedCliRunMock).not.toHaveBeenCalled();
    expect(harness.runEmbeddedAgentMock).not.toHaveBeenCalled();
  }

  it.each([
    {
      name: "hidden subagent child",
      sessionKey: "agent:main:subagent:sandbox-cli-hidden",
      entry: { spawnedBy: "agent:main:main" },
      cfg: sandboxedCliConfig({ sandboxMode: "all", cliModel: true }),
      overrides: {},
    },
    {
      name: "subagent-keyed child without a spawnedBy stamp",
      sessionKey: "agent:main:subagent:sandbox-cli-keyonly",
      entry: {},
      cfg: sandboxedCliConfig({ sandboxMode: "all", cliModel: true }),
      overrides: {},
    },
    {
      name: "visible spawned child",
      sessionKey: "agent:main:dashboard:sandbox-cli-visible",
      entry: { parentSessionKey: "agent:main:main", spawnedBy: "agent:main:main" },
      cfg: sandboxedCliConfig({ sandboxMode: "all", cliModel: true }),
      overrides: {},
    },
    {
      name: "fallback candidate after an API primary",
      sessionKey: "agent:main:subagent:sandbox-cli-fallback",
      entry: { spawnedBy: "agent:main:main" },
      cfg: sandboxedCliConfig({ sandboxMode: "all", cliModel: true }),
      overrides: { isFallbackRetry: true, originalProvider: "openai" },
    },
    {
      name: "post-spawn runtime override",
      sessionKey: "agent:main:subagent:sandbox-cli-override",
      entry: { spawnedBy: "agent:main:main", agentRuntimeOverride: "claude-cli" },
      cfg: sandboxedCliConfig({ sandboxMode: "all" }),
      overrides: { agentHarnessRuntimeOverride: "claude-cli" },
    },
    {
      name: "creation-stamped sandbox requirement",
      sessionKey: "agent:main:subagent:sandbox-cli-required",
      entry: { spawnedBy: "agent:main:main", sandbox: "required" as const },
      cfg: sandboxedCliConfig({ cliModel: true }),
      overrides: {},
    },
  ])("refuses host CLI launch for a sandboxed $name", async (testCase) => {
    const run = attempt(testCase);
    await expect(run).rejects.toBeInstanceOf(AgentHarnessPreflightError);
    await expect(run).rejects.toThrow(/claude-cli runs on the host and cannot honor the sandbox/);
    expectNoDispatch();
  });

  it("keeps CLI launch for an operator dashboard session parented to main", async () => {
    harness.runCliAgentMock.mockResolvedValueOnce(makeCliResult("operator cli"));
    await attempt({
      sessionKey: "agent:main:dashboard:sandbox-cli-operator",
      entry: { parentSessionKey: "agent:main:main" },
      cfg: sandboxedCliConfig({ sandboxMode: "all", cliModel: true }),
    });
    expect(harness.runCliAgentMock).toHaveBeenCalledOnce();
    expect(harness.runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("keeps CLI launch for an unsandboxed spawned child", async () => {
    harness.runCliAgentMock.mockResolvedValueOnce(makeCliResult("unsandboxed cli"));
    await attempt({
      sessionKey: "agent:main:subagent:sandbox-cli-unsandboxed",
      entry: { spawnedBy: "agent:main:main" },
      cfg: sandboxedCliConfig({ cliModel: true }),
    });
    expect(harness.runCliAgentMock).toHaveBeenCalledOnce();
  });

  it("keeps embedded execution for a sandboxed spawned child on an API model", async () => {
    harness.runEmbeddedAgentMock.mockResolvedValueOnce({ meta: { durationMs: 1 } });
    await attempt({
      sessionKey: "agent:main:subagent:sandbox-cli-embedded",
      entry: { spawnedBy: "agent:main:main" },
      cfg: sandboxedCliConfig({ sandboxMode: "all" }),
      overrides: { providerOverride: "openai", modelOverride: "gpt-5.4" },
    });
    expect(harness.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(harness.runCliAgentMock).not.toHaveBeenCalled();
  });
}
