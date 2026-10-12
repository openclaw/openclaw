import { vi } from "vitest";
import type { countPendingDescendantRuns } from "../registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import type { createRequesterDescendantReader } from "./subagent-announce.requester-settle-descendants.js";

const readDescendantFacts = vi.hoisted(() =>
  vi.fn<
    (
      params: Parameters<typeof createRequesterDescendantReader>[0],
    ) => ReturnType<ReturnType<typeof createRequesterDescendantReader>>
  >(async () => ({ unsettled: false, active: 0 })),
);

vi.mock("./subagent-announce.requester-settle-descendants.js", () => ({
  createRequesterDescendantReader:
    (params: Parameters<typeof createRequesterDescendantReader>[0]) => () =>
      readDescendantFacts(params),
}));

const startTurn = vi.hoisted(() => vi.fn());
const deliver = vi.hoisted(() => vi.fn());
const loadRequester = vi.hoisted(() =>
  vi.fn<
    (
      ...args: Parameters<
        typeof import("./subagent-announce-delivery.runtime.js").loadRequesterSessionEntry
      >
    ) => Awaited<
      ReturnType<typeof import("./subagent-announce-delivery.runtime.js").loadRequesterSessionEntry>
    >
  >(),
);
const registryRead = vi.hoisted(() => ({
  countPendingDescendantRuns: vi.fn<typeof countPendingDescendantRuns>(
    async (_key, assertCurrent) => {
      assertCurrent();
      return 0;
    },
  ),
  getLatestLiveSubagentRunByChildSessionKey: vi.fn<
    (
      sessionKey: string,
      matches?: (entry: SubagentRunRecord) => boolean,
    ) => SubagentRunRecord | undefined
  >(() => undefined),
  listSubagentRunsForRequester: vi.fn<() => SubagentRunRecord[]>(() => []),
  getLatestSubagentRunByChildSessionKey: vi.fn(() => undefined),
}));

vi.mock("../../../gateway/server-methods.js", () => ({
  createRequestGatewayMethodRegistry: () => ({ isControlPlaneWrite: () => false }),
  runWithGatewayRequestEnvelope: async (
    _method: string,
    _client: unknown,
    run: () => Promise<unknown>,
  ) => await run(),
}));

vi.mock("../../../gateway/server-methods/request-authorization.js", () => ({
  authorizeGatewayRequestPreDispatch: async () => ({ error: null }),
}));

vi.mock("../../../gateway/agent-turn/agent-request-preflight.js", () => ({
  prepareAgentRequestPreflight: ({ request }: { request: unknown }) => ({ request }),
}));

vi.mock("../../../gateway/agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn, waitForTurn: vi.fn() }),
}));

vi.mock("../registry/subagent-registry-read.js", () => registryRead);
vi.mock("../spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: (sessionKey: string) =>
    sessionKey.split(":subagent:").length - 1,
}));
// mock-isolation: Dispatch fixtures select the delivery boundary and requester store explicitly.
vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: (...args: unknown[]) => deliver(...args),
  loadRequesterSessionEntry: (...args: Parameters<typeof loadRequester>) => loadRequester(...args),
}));

export { readDescendantFacts, startTurn, deliver, registryRead, loadRequester };
