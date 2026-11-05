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
const childKey = "agent:main:subagent:child";
const parent = "agent:main:main";

function sandboxedCliConfig(params: { sandboxMode?: "all"; cliModel?: boolean }): OpenClawConfig {
  const models: Record<string, { agentRuntime: { id: string } }> = {};
  if (params.cliModel) {
    models[CLI_MODEL_REF] = { agentRuntime: { id: "claude-cli" } };
  }
  const sandbox = params.sandboxMode ? { sandbox: { mode: params.sandboxMode } } : {};
  return { agents: { defaults: { models, ...sandbox } } };
}

// Keep classification, sandbox admission and dispatch real; stub only the runners.
export function registerSandboxedDelegatedCliTests(harness: SandboxedCliHarness) {
  const { runStoredAttempt, seedSessionStore } = harness;

  async function attempt(params: {
    sessionKey?: string;
    entry?: Partial<SessionEntry>;
    cfg?: OpenClawConfig;
    overrides?: Partial<Omit<RunAgentAttemptOverrides, "agentDir" | "storePath" | "workspaceDir">>;
  }) {
    const sessionKey = params.sessionKey ?? childKey;
    const sessionEntry = makeSessionEntry(
      `sandbox-cli-${sessionKey.split(":").at(-1)}`,
      params.entry,
    );
    return runStoredAttempt({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-7",
      cfg: params.cfg ?? sandboxedCliConfig({ sandboxMode: "all", cliModel: true }),
      sessionEntry,
      sessionKey,
      sessionStore: await seedSessionStore(sessionKey, sessionEntry),
      body: "delegated work",
      ...params.overrides,
    });
  }

  it.each([
    { name: "subagent-keyed child without a spawnedBy stamp" },
    {
      name: "visible spawned child",
      sessionKey: "agent:main:dashboard:visible",
      entry: { parentSessionKey: parent, spawnedBy: parent },
    },
    {
      name: "fallback candidate after an API primary",
      entry: { spawnedBy: parent },
      overrides: { isFallbackRetry: true, originalProvider: "openai" },
    },
    {
      name: "post-spawn runtime override",
      entry: { spawnedBy: parent, agentRuntimeOverride: "claude-cli" },
      cfg: sandboxedCliConfig({ sandboxMode: "all" }),
      overrides: { agentHarnessRuntimeOverride: "claude-cli" },
    },
    {
      name: "creation-stamped sandbox requirement",
      entry: { spawnedBy: parent, sandbox: "required" as const },
      cfg: sandboxedCliConfig({ cliModel: true }),
    },
  ])("refuses host CLI launch for a sandboxed $name", async (testCase) => {
    const run = attempt(testCase);
    await expect(run).rejects.toBeInstanceOf(AgentHarnessPreflightError);
    await expect(run).rejects.toThrow(/claude-cli runs on the host and cannot honor the sandbox/);
    expect(harness.runCliAgentMock).not.toHaveBeenCalled();
    expect(harness.executePreparedCliRunMock).not.toHaveBeenCalled();
    expect(harness.runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an operator dashboard session parented to main",
      sessionKey: "agent:main:dashboard:operator",
      entry: { parentSessionKey: parent },
    },
    {
      name: "an unsandboxed spawned child",
      entry: { spawnedBy: parent },
      cfg: sandboxedCliConfig({ cliModel: true }),
    },
  ])("keeps CLI launch for $name", async (testCase) => {
    harness.runCliAgentMock.mockResolvedValueOnce(makeCliResult("cli response"));
    await attempt(testCase);
    expect(harness.runCliAgentMock).toHaveBeenCalledOnce();
    expect(harness.runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("keeps embedded execution for a sandboxed spawned child on an API model", async () => {
    harness.runEmbeddedAgentMock.mockResolvedValueOnce({ meta: { durationMs: 1 } });
    await attempt({
      entry: { spawnedBy: parent },
      cfg: sandboxedCliConfig({ sandboxMode: "all" }),
      overrides: { providerOverride: "openai", modelOverride: "gpt-5.4" },
    });
    expect(harness.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(harness.runCliAgentMock).not.toHaveBeenCalled();
  });
}
