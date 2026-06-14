/**
 * Regression test for #87213: `exec host=node` rejected requests when the
 * bound node and the requested node referred to the same physical node
 * via different supported selector forms (e.g. canonical id vs. display
 * name). The pre-fix guard compared raw selector text before resolving
 * either side through the node resolver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listNodesMock = vi.hoisted(() => vi.fn());
const resolveNodeIdFromListMock = vi.hoisted(() => vi.fn());

vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: listNodesMock,
  resolveNodeIdFromList: resolveNodeIdFromListMock,
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

let resolveNodeExecutionTarget: typeof import("./bash-tools.exec-host-node-phases.js").resolveNodeExecutionTarget;

const NODES = [
  {
    nodeId: "node-canonical-abc123",
    nodeName: "home-wsl-debian",
    platform: "linux",
    connected: true,
    commands: ["system.run"],
  },
  {
    nodeId: "node-other-xyz",
    nodeName: "other-host",
    platform: "linux",
    connected: true,
    commands: ["system.run"],
  },
];

function makeParams(overrides: Record<string, unknown>) {
  return {
    command: "echo hi",
    workdir: undefined,
    env: {},
    security: "full" as const,
    ask: "off" as const,
    defaultTimeoutSec: 30,
    approvalRunningNoticeMs: 0,
    warnings: [],
    ...overrides,
  } as never;
}

beforeEach(async () => {
  listNodesMock.mockReset();
  resolveNodeIdFromListMock.mockReset();
  listNodesMock.mockResolvedValue(NODES);
  ({ resolveNodeExecutionTarget } = await import("./bash-tools.exec-host-node-phases.js"));
});

afterEach(() => {
  vi.resetModules();
});

describe("resolveNodeExecutionTarget bound vs requested selector canonicalization", () => {
  it("allows the request when bound id and requested display name resolve to the same node", async () => {
    resolveNodeIdFromListMock.mockImplementation((_nodes: unknown, query: string | undefined) => {
      if (query === "node-canonical-abc123" || query === "home-wsl-debian") {
        return "node-canonical-abc123";
      }
      throw new Error(`unknown node ${query}`);
    });

    const target = await resolveNodeExecutionTarget(
      makeParams({
        boundNode: "node-canonical-abc123",
        requestedNode: "home-wsl-debian",
      }),
    );
    expect(target.nodeId).toBe("node-canonical-abc123");
  });

  it("still rejects when bound and requested selectors resolve to different nodes", async () => {
    resolveNodeIdFromListMock.mockImplementation((_nodes: unknown, query: string | undefined) => {
      if (query === "node-canonical-abc123") return "node-canonical-abc123";
      if (query === "other-node") return "node-other-xyz";
      throw new Error(`unknown node ${query}`);
    });

    await expect(
      resolveNodeExecutionTarget(
        makeParams({
          boundNode: "node-canonical-abc123",
          requestedNode: "other-node",
        }),
      ),
    ).rejects.toThrow(/exec node not allowed/);
  });
});
