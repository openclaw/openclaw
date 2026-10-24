import { afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

const mocks = vi.hoisted(() => ({
  gatewayCalls: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(),
  targets: new WeakMap<object, { boardSessionKey: string; assertCurrent: () => void }>(),
}));

vi.mock("../tools/in-process-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/in-process-gateway.js")>()),
  callInProcessGatewayTool: (method: string, params: Record<string, unknown>) =>
    mocks.gatewayCalls(method, params),
}));
// Stands in for the cron admission owner, which binds a child run's targets to its admitted run.
vi.mock("../../cron/execution-context-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cron/execution-context-registry.js")>()),
  readScheduledToolTargets: (owner?: { operationalRunInstance?: object }) =>
    owner?.operationalRunInstance ? mocks.targets.get(owner.operationalRunInstance) : undefined,
}));

const RUN_KEY = "agent:main:cron:job-1:run:run-session";
const PARENT_KEY = "agent:main:dashboard:parent";
const hosts: Array<Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>> = [];

afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.closeHost();
    host.closeAdmission();
  }
  resetAgentRunRegistryForTest();
  clearRuntimeConfigSnapshot();
});

async function readBoardThroughHost(targets?: {
  boardSessionKey: string;
  assertCurrent: () => void;
}) {
  setRuntimeConfigSnapshot({});
  mocks.gatewayCalls.mockReset();
  mocks.gatewayCalls.mockResolvedValue({ session: null, tabs: [], widgets: [] });
  const host = await createAdmittedHostCapabilityTestFixture({
    runId: `run-${targets ? "child" : "plain"}`,
    agentId: "main",
    sessionId: "run-session",
    sessionKey: RUN_KEY,
    cwd: "/attempt/worktree",
    workspaceDir: "/workspace",
  });
  hosts.push(host);
  if (targets) {
    mocks.targets.set(host.admittedRunContext.operationalRunInstance, targets);
  }
  // Codex builds every dynamic tool through this host capability (createCodexHostToolSurface).
  const tools =
    (await host.hostCapabilities.createToolSurfaceAsync?.({
      sessionKey: RUN_KEY,
      runSessionKey: RUN_KEY,
      runtimeToolAllowlist: ["dashboard"],
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    })) ?? [];
  const dashboard = tools.find((tool) => tool.name === "dashboard");
  expect(dashboard).toBeDefined();
  await dashboard?.execute("read-board", { action: "read" });
  return mocks.gatewayCalls.mock.calls.find(([method]) => method === "board.get")?.[1];
}

it("points a Codex scheduled child's dashboard at its parent's board", async () => {
  const params = await readBoardThroughHost({
    boardSessionKey: PARENT_KEY,
    assertCurrent: () => {},
  });
  expect(params).toMatchObject({ sessionKey: PARENT_KEY });
});

it("keeps the run session's board for Codex runs without a scheduled context", async () => {
  expect(await readBoardThroughHost()).toMatchObject({ sessionKey: RUN_KEY });
});
