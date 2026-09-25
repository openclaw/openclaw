// Preparation-path regression: the process scope key resolved exactly once per
// attempt must be the authoritative run identity, never the sandbox/policy
// identity, and real exec registration must assign that identical stored scope.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSession, getSession } from "../../bash-process-registry.js";
import { createExecTool } from "../../bash-tools.exec-run.js";
import { createProcessTool } from "../../bash-tools.process.js";
import type { AnyAgentTool } from "../../tools/common.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

// Observed on the real prepared attempt object; never hand-set on a fixture.
const { preparedAttempts } = vi.hoisted(() => ({
  preparedAttempts: [] as Array<Record<string, unknown>>,
}));

vi.mock("./attempt-prompt-build.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./attempt-prompt-build.js")>();
  return {
    ...original,
    prepareEmbeddedAttemptPromptContext: ((
      input: Parameters<typeof original.prepareEmbeddedAttemptPromptContext>[0],
    ) => {
      preparedAttempts.push(input.attempt as unknown as Record<string, unknown>);
      return original.prepareEmbeddedAttemptPromptContext(input);
    }) as typeof original.prepareEmbeddedAttemptPromptContext,
  };
});

function stubTool(name: string) {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: undefined }),
  } satisfies AnyAgentTool;
}

describe("runEmbeddedAttempt process scope key preparation", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    preparedAttempts.length = 0;
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it("stores the run identity as the once-resolved process scope key across split identities", async () => {
    const runSessionKey = "agent:main:subagent:split-run";
    const policySessionKey = "agent:main:dashboard:split-identity";
    let capturedOptions: Record<string, unknown> | undefined;
    hoisted.createOpenClawCodingToolsMock.mockImplementationOnce((options: unknown) => {
      capturedOptions = options as Record<string, unknown>;
      return ["exec", "process"].map(stubTool);
    });

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: runSessionKey,
      tempPaths,
      attemptOverrides: {
        sandboxSessionKey: policySessionKey,
        requireWorkspaceOnly: true,
        toolsAllow: ["exec", "process"],
        disableTools: false,
      },
    });

    // The real preparation path stored the run identity exactly once.
    const prepared = preparedAttempts.find(
      (attempt) => (attempt as { sessionKey?: string }).sessionKey === runSessionKey,
    ) as { processScopeKey?: string; sessionKey?: string } | undefined;
    expect(prepared).toBeDefined();
    expect(prepared!.processScopeKey).toBe(runSessionKey);
    expect(prepared!.processScopeKey).not.toBe(policySessionKey);

    // The registration seam consumes the stored key while the policy identity
    // keeps its existing separate role (sandbox/tool-policy owner).
    expect(capturedOptions).toBeDefined();
    const toolsOptions = capturedOptions as {
      sessionKey?: string;
      runSessionKey?: string;
      exec?: { scopeKey?: string };
    };
    expect(toolsOptions.exec?.scopeKey).toBe(prepared!.processScopeKey);
    expect(toolsOptions.runSessionKey).toBe(runSessionKey);
    expect(toolsOptions.sessionKey).toBe(policySessionKey);

    // Real registration: the production exec tool factory (the same function
    // agent-tools constructs in production) fed the captured seam inputs.
    const execTool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      allowBackground: true,
      backgroundMs: 0,
      timeoutSec: 30,
      scopeKey: toolsOptions.exec?.scopeKey,
      sessionKey: toolsOptions.runSessionKey,
    });
    const processTool = createProcessTool({ scopeKey: toolsOptions.exec?.scopeKey });

    const script = "setTimeout(() => process.exit(0), 5000)";
    const started = await execTool.execute("process-scope-prep-start", {
      command: `${process.execPath} -e ${JSON.stringify(script)}`,
      background: true,
    });
    const startDetails = started.details as { status?: string; sessionId?: string };
    expect(startDetails.status).toBe("running");
    expect(
      started.content.some(
        (part) => part.type === "text" && part.text?.includes("Command still running"),
      ),
    ).toBe(true);
    const sessionId = startDetails.sessionId;
    if (!sessionId) {
      throw new Error("exec did not return a background session id");
    }

    try {
      expect(prepared!.processScopeKey).toBe(getSession(sessionId)?.scopeKey);
      expect(getSession(sessionId)?.scopeKey).toBe(runSessionKey);
    } finally {
      await processTool.execute("process-scope-prep-kill", {
        action: "kill",
        sessionId,
      });
      deleteSession(sessionId);
    }
  });
});
