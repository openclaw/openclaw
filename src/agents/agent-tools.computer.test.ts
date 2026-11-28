import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { computerCapabilities } from "../gateway/desktop/computer.test-support.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { createOperationalRunInstanceRef } from "./admitted-run-context.js";
import { createOpenClawCodingToolsInternalAsync } from "./agent-tools.js";
import { withSessionPlacementComputer } from "./session-placement-computer.js";
import { loadGatewayComputerStatus } from "./tools/computer-tool-gateway.js";
import { listNodes } from "./tools/nodes-utils.js";

vi.mock("./tools/nodes-utils.js", async (original) => ({
  ...(await original<typeof import("./tools/nodes-utils.js")>()),
  listNodes: vi.fn(),
}));
vi.mock("./tools/computer-tool-gateway.js", async (original) => ({
  ...(await original<typeof import("./tools/computer-tool-gateway.js")>()),
  loadGatewayComputerStatus: vi.fn(),
}));

const directories = useSessionStoreTempDirs(afterAll, "computer-assembly-");
let workspaceDir: string;
beforeEach(() => {
  workspaceDir = directories.make();
  vi.stubEnv("OPENCLAW_STATE_DIR", workspaceDir);
  vi.mocked(listNodes).mockReset();
  vi.mocked(loadGatewayComputerStatus).mockReset();
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

it.each([true, false])(
  "preserves a session-owned desktop's availability before serialization: %s",
  async (available) => {
    const config = { tools: { allow: ["computer"], codeMode: false, toolSearch: false } };
    setRuntimeConfigSnapshot(config);
    const run = createOperationalRunInstanceRef("computer-session");
    const tools = await withSessionPlacementComputer(
      {
        runId: run.runId,
        agentId: "main",
        isActive: () => true,
        bind: () =>
          available
            ? {
                computerUse: computerCapabilities(
                  { id: "session", label: "Session", generation: "1" },
                  ["screenshot"],
                ),
                resolveNode: async () => ({ nodeId: "session-desktop" }),
                invoke: async () => undefined,
              }
            : null,
      },
      () =>
        createOpenClawCodingToolsInternalAsync({
          config,
          agentId: "main",
          workspaceDir,
          sessionKey: "agent:main:computer-session",
          operationalRunInstance: run,
          modelHasVision: true,
          toolConstructionPlan: {
            includeBaseCodingTools: false,
            includeShellTools: false,
            includeChannelTools: false,
            includeOpenClawTools: true,
            includePluginTools: false,
          },
        }),
    );
    const computer = tools.find((tool) => tool.name === "computer");
    if (available) {
      expect(computer?.parameters).toMatchObject({
        properties: { action: { enum: ["screenshot", "wait", "take_control"] } },
      });
      expect(computer?.parameters).not.toHaveProperty("properties.target");
    } else {
      expect(computer).toBeUndefined();
    }
    expect(listNodes).not.toHaveBeenCalled();
    expect(loadGatewayComputerStatus).not.toHaveBeenCalled();
  },
);
