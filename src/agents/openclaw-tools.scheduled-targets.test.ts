import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { createOpenClawTools } from "./openclaw-tools.js";

const gatewayCalls = vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>();

vi.mock("./openclaw-plugin-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-plugin-tools.js")>()),
  resolveOpenClawPluginToolsForOptions: () => [],
}));
vi.mock("./tools/in-process-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tools/in-process-gateway.js")>()),
  callInProcessGatewayTool: (method: string, params: Record<string, unknown>) =>
    gatewayCalls(method, params),
}));
beforeEach(() => {
  setRuntimeConfigSnapshot({});
  gatewayCalls.mockReset();
  gatewayCalls.mockResolvedValue({ session: null, tabs: [], widgets: [] });
});
afterEach(() => clearRuntimeConfigSnapshot());

const RUN_KEY = "agent:main:cron:job-1:run:run-session";
const PARENT_KEY = "agent:main:dashboard:parent";

function scheduledChildTools(targets?: { boardSessionKey: string; mediaSessionKey: string }) {
  return createOpenClawTools({
    agentSessionKey: "agent:main:cron:job-1",
    runSessionKey: RUN_KEY,
    gatewayCallerScheduled: true,
    runtimeToolAllowlist: ["show_widget", "dashboard"],
    ...(targets ? { scheduledToolTargets: targets } : {}),
  });
}

it("offers pinned widget authoring to a scheduled child of a conversation", () => {
  // Without a context the run key blocks pinned authoring (the observed empty-board failure).
  expect(scheduledChildTools().find((tool) => tool.name === "show_widget")).toBeUndefined();
  const widget = scheduledChildTools({
    boardSessionKey: PARENT_KEY,
    mediaSessionKey: PARENT_KEY,
  }).find((tool) => tool.name === "show_widget");
  expect(widget?.parameters).toMatchObject({ properties: { pin: { const: true } } });
});

it("points a scheduled child's dashboard at its parent's board", async () => {
  const dashboard = scheduledChildTools({
    boardSessionKey: PARENT_KEY,
    mediaSessionKey: PARENT_KEY,
  }).find((tool) => tool.name === "dashboard");
  await dashboard?.execute("read-board", { action: "read" });
  expect(gatewayCalls).toHaveBeenCalledWith(
    "board.get",
    expect.objectContaining({ sessionKey: PARENT_KEY }),
  );
});

it("keeps the run session's board for runs without a context", async () => {
  const dashboard = scheduledChildTools().find((tool) => tool.name === "dashboard");
  await dashboard?.execute("read-board", { action: "read" });
  expect(gatewayCalls).toHaveBeenCalledWith(
    "board.get",
    expect.objectContaining({ sessionKey: RUN_KEY }),
  );
});
