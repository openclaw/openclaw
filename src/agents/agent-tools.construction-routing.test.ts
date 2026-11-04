import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "./cron-creator-authority-context.js";
import { createOpenClawOnlyToolConstructionPlan } from "./test-helpers/tool-construction-plan.js";
import type { AnyAgentTool } from "./tools/common.js";

const mocks = vi.hoisted(() => {
  const onToolExecute = vi.fn(async () => ({ content: [], details: {} }));
  const onToolPrepare = vi.fn(async (params: unknown) => params);
  const stubTool = (name: string) =>
    ({
      name,
      label: name,
      displaySummary: name,
      description: name,
      parameters: { type: "object", properties: {} },
      prepareBeforeToolCallParams: onToolPrepare,
      execute: onToolExecute,
    }) satisfies AnyAgentTool;

  return {
    createOpenClawToolsOptions: vi.fn(),
    stubTool,
    onToolExecute,
    onToolPrepare,
  };
});

vi.mock("./openclaw-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-tools.js")>();
  return {
    createOpenClawTools: (options: unknown) => {
      mocks.createOpenClawToolsOptions(options);
      return [AUTOMATIONS_TOOL_NAME, "gateway"].map(mocks.stubTool);
    },
    filterToolsByClientCaps: actual.filterToolsByClientCaps,
  };
});

import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import { createOpenClawCodingTools, createOpenClawCodingToolsInternal } from "./agent-tools.js";
import { expectOwnerGated } from "./agent-tools.turn-authority.test-support.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

const openClawPlan = createOpenClawOnlyToolConstructionPlan();
const shellPlan = { ...openClawPlan, includeShellTools: true, includeOpenClawTools: false };
const scheduledContext = { trigger: "cron" as const, jobId: "job-current", senderIsOwner: false };

function expectToolCalls(count: number) {
  expect(mocks.onToolPrepare).toHaveBeenCalledTimes(count);
  expect(mocks.onToolExecute).toHaveBeenCalledTimes(count);
}

describe("createOpenClawCodingTools cron scope", () => {
  beforeEach(() => {
    mocks.createOpenClawToolsOptions.mockClear();
    mocks.onToolExecute.mockClear();
    mocks.onToolPrepare.mockClear();
  });

  it.each(["settled", "failed", "aborted"] as const)(
    "gates constructed tool effects on initial workspace attribution (%s)",
    async (outcome) => {
      const entered = createDeferred();
      const baseline = createDeferred();
      const controller = new AbortController();
      const tools = createOpenClawCodingToolsInternal({
        awaitSessionDiffBaseline: async () => {
          entered.resolve();
          await baseline.promise;
        },
      });
      const gateway = tools.find((tool) => tool.name === "gateway");
      expect(gateway).toBeDefined();
      const pending = gateway!.execute("attribution-call", {}, controller.signal);
      try {
        await awaitGateBeforeSettlement(entered.promise, pending, "Tool bypassed attribution");
        expectToolCalls(0);
        if (outcome === "failed") {
          baseline.reject(new Error("attribution failed"));
          await expect(pending).rejects.toThrow("attribution failed");
        } else if (outcome === "aborted") {
          controller.abort(new Error("tool generation expired"));
          baseline.resolve();
          await expect(pending).rejects.toThrow("tool generation expired");
        } else {
          baseline.resolve();
          await pending;
        }
        expectToolCalls(outcome === "settled" ? 1 : 0);
      } finally {
        baseline.resolve();
        await pending.catch(() => undefined);
      }
    },
  );

  it("lets the owner reach a retained owner-only tool and stops a non-owner before preparation", async () => {
    for (const senderIsOwner of [true, false]) {
      mocks.onToolExecute.mockClear();
      mocks.onToolPrepare.mockClear();
      const tools = createOpenClawCodingTools({ senderIsOwner });
      const gateway = tools.find((tool) => tool.name === "gateway")!;
      const result = await gateway.execute(`dispatch-${senderIsOwner}`, { action: "config.get" });
      if (!senderIsOwner) {
        expect(result.details).toMatchObject({ gated: true });
      }
      expectToolCalls(senderIsOwner ? 1 : 0);
    }
  });

  it("preserves explicit automation denial for a scheduled run", () => {
    const tools = createOpenClawCodingTools({
      ...scheduledContext,
      config: { tools: { deny: [AUTOMATIONS_TOOL_NAME] } },
    });
    expect(tools.map((tool) => tool.name)).not.toContain(AUTOMATIONS_TOOL_NAME);
  });

  it.each([{ trigger: "cron" as const }, { jobId: "job-current" }])(
    "does not expose automation controls for an incomplete scheduled context: %j",
    async (context) => {
      const tools = createOpenClawCodingTools({ ...context, senderIsOwner: false });
      await expectOwnerGated(tools, AUTOMATIONS_TOOL_NAME);
    },
  );

  it("admits only the automation tool for channel-owner management authority", async () => {
    const runId = "remote-management-tools";
    const { operationalRunInstance } = createTestAdmittedRunContext(runId);
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    onTestFinished(() => {
      releaseAgentRunDelegatedAuthority(authority);
    });
    const capability = createCronCreatorAuthorityCapability(
      runId,
      { kind: "unknown" },
      { source: "channel-owner", isCurrent: () => true },
    )!;
    const tools = await runWithCronCreatorAuthorityCapability(capability, () =>
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:control-ui",
          operationalRunInstance,
          approvalAuthority: authority,
        },
        () =>
          createOpenClawCodingTools({
            runId,
            senderIsOwner: false,
            wrapBeforeToolCallHook: false,
            toolConstructionPlan: openClawPlan,
          }),
      ),
    );
    expect(tools.map((tool) => tool.name)).toContain(AUTOMATIONS_TOOL_NAME);
    await expectOwnerGated(tools, "gateway");
  });
});

const createLazyExecToolMock = vi.hoisted(() => vi.fn());

vi.mock("./lazy-exec-tool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lazy-exec-tool.js")>();
  return {
    ...actual,
    createLazyExecTool: (defaults: unknown) => {
      createLazyExecToolMock(defaults);
      return {
        name: "exec",
        description: "exec stub",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      };
    },
  };
});

describe("createOpenClawCodingTools exec notification routing", () => {
  it("binds native tool approval requests to the constructed permission generation", async () => {
    const generation = new AbortController();
    let approvalScope: AbortSignal | undefined;
    mocks.onToolExecute.mockImplementationOnce(async () => {
      approvalScope = AbortSignal.any([...(getGatewayToolCallerIdentity()?.approvalSignals ?? [])]);
      return { content: [], details: {} };
    });
    const tools = createOpenClawCodingTools({
      agentId: "main",
      sessionKey: "agent:main:scope",
      abortSignal: generation.signal,
      wrapBeforeToolCallHook: false,
      toolConstructionPlan: openClawPlan,
    });
    await tools.find((candidate) => candidate.name === AUTOMATIONS_TOOL_NAME)!.execute("call", {});
    generation.abort();
    expect(approvalScope?.aborted).toBe(true);
  });

  it("keeps live process ownership separate from the policy session", () => {
    const liveSessionKey = "agent:main:channel:group:example:thread:25";
    const policySessionKey = "agent:main:runtime-policy";

    createOpenClawCodingTools({
      sessionKey: policySessionKey,
      runSessionKey: liveSessionKey,
      toolConstructionPlan: shellPlan,
    });

    expect(createLazyExecToolMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scopeKey: liveSessionKey,
        sessionKey: policySessionKey,
        runSessionKey: liveSessionKey,
      }),
    );
  });
});

describe("createOpenClawCodingTools sandbox filesystem ownership", () => {
  const sandbox = createAgentToolsSandboxContext({ workspaceDir: "/managed/workspace" });

  it("keeps host-owned tools available when no sandbox filesystem family is requested", () => {
    const tools = createOpenClawCodingTools({
      sandbox: { ...sandbox, agentId: "main" },
      config: { agents: { entries: { main: {}, work: {} } } },
      policyAgentId: "main",
      agentId: "work",
      sessionKey: "agent:main:policy",
      runSessionKey: "agent:work:run",
      toolConstructionPlan: { ...openClawPlan, includePluginTools: true },
    });

    expect(tools.map((tool) => tool.name)).toContain(AUTOMATIONS_TOOL_NAME);
    expect(mocks.createOpenClawToolsOptions).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxAgentId: "main", requesterAgentIdOverride: "work" }),
    );
  });

  it("rejects sandbox shell tools without their filesystem bridge", () => {
    expect(() =>
      createOpenClawCodingTools({
        sandbox,
        toolConstructionPlan: shellPlan,
      }),
    ).toThrow("Sandbox filesystem bridge is unavailable.");
  });
});
