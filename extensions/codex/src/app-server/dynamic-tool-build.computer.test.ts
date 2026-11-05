import "./dynamic-tool-build.test-support.js";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAdmittedHostCapabilityTestFixture } from "../../../../src/agents/harness/host-capability.test-support.js";
import { withSessionPlacementComputer } from "../../../../src/agents/session-placement-computer.js";
import { createBridge } from "./dynamic-tools.test-support.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";
import { createCodexTestModel } from "./test-support.js";

const computerInventory = vi.hoisted(() => ({ nodes: vi.fn() }));
vi.mock("../../../../src/agents/tools/nodes-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/agents/tools/nodes-utils.js")>()),
  listNodes: computerInventory.nodes,
}));
vi.mock("../../../../src/agents/tools/computer-tool-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../src/agents/tools/computer-tool-gateway.js")
  >()),
  loadGatewayComputerStatus: async () => ({ configured: false, available: false }),
}));

const {
  setupDynamicToolBuildFixture,
  cleanupDynamicToolBuildFixture,
  buildDynamicToolsForTest,
  createParams,
} = await import("./dynamic-tool-build.test-support.js");
let tempDir: string;
let workspaceDir: string;
let params: ReturnType<typeof createParams>;
const hostCapabilityClosers: Array<() => void> = [];
beforeEach(async () => {
  computerInventory.nodes.mockReset().mockResolvedValue([]);
  tempDir = await setupDynamicToolBuildFixture();
  workspaceDir = path.join(tempDir, "workspace");
  params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
});
afterEach(async () => {
  await cleanupDynamicToolBuildFixture(tempDir, hostCapabilityClosers);
});
function buildTools(options: Parameters<typeof buildDynamicToolsForTest>[2]) {
  return buildDynamicToolsForTest(params, workspaceDir, options);
}

it.each(["v2", "v1", "missing", "denied", "scoped", "text", "session"])(
  "serializes the initial paired computer schema through the Codex host: %s",
  async (kind) => {
    const v2Actions = [
      "list_windows",
      "get_window_state",
      "bring_to_front",
      "set_value",
      "get_accessibility_tree",
    ];
    computerInventory.nodes.mockResolvedValue(
      kind === "missing"
        ? []
        : [
            {
              nodeId: "synthetic-windows-node",
              connected: true,
              commands: ["computer.act", "screen.snapshot"],
              ...(kind === "v2"
                ? {
                    computerUse: {
                      contractVersion: 2,
                      provider: { id: "fixture", label: "Fixture", generation: "1" },
                      actions: ["screenshot", ...v2Actions],
                      targets: ["screen", "window"],
                      deliveryModes: ["foreground"],
                      observations: ["image", "accessibility"],
                      features: { recording: false, agentCursor: false, multiDisplay: false },
                    },
                  }
                : {}),
            },
          ],
    );
    params.model = createCodexTestModel("codex", kind === "text" ? ["text"] : ["text", "image"]);
    if (kind === "scoped") {
      params.toolsAllow = ["message"];
    }
    params.config = {
      tools: {
        codeMode: false,
        toolSearch: false,
        ...(kind === "denied" ? { deny: ["computer"] } : {}),
      },
    };
    const host = await createAdmittedHostCapabilityTestFixture(params);
    params.hostCapabilities = host.hostCapabilities;
    hostCapabilityClosers.push(() => {
      host.closeHost();
      host.closeAdmission();
    });
    const build = () => buildTools({ sandbox: null });
    const tools =
      kind === "session"
        ? await withSessionPlacementComputer(
            {
              runId: params.runId,
              agentId: "main",
              isActive: () => true,
              bind: () => ({
                computerUse: {
                  contractVersion: 2,
                  provider: { id: "session", label: "Session", generation: "1" },
                  actions: ["screenshot"],
                  targets: ["screen"],
                  deliveryModes: ["foreground"],
                  observations: ["image"],
                  features: { recording: false, agentCursor: false, multiDisplay: false },
                },
                resolveNode: async () => ({ nodeId: "session-node" }),
                invoke: async () => undefined,
              }),
            },
            build,
          )
        : await build();
    const specs = createBridge(tools, { loading: "direct" }).specs;
    const first = JSON.stringify(
      flattenCodexDynamicToolFunctions(specs).filter((tool) => tool.name === "computer"),
    );
    if (["denied", "scoped", "text"].includes(kind)) {
      expect(tools.some((tool) => tool.name === "computer")).toBe(false);
      expect(computerInventory.nodes).not.toHaveBeenCalled();
      return;
    }
    if (kind === "session") {
      expect(computerInventory.nodes).not.toHaveBeenCalled();
    }
    expect(first).toContain('"computer"');
    for (const action of v2Actions) {
      if (kind === "v2") {
        expect(first).toContain(`"${action}"`);
      } else {
        expect(first).not.toContain(`"${action}"`);
      }
    }
  },
);
