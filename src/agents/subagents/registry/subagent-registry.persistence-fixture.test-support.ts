import { vi } from "vitest";
import type { callGateway } from "../../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { isPathInside } from "../../../infra/path-guards.js";
import type { listOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.test-support.js";

const { announceSpy } = vi.hoisted(() => ({
  announceSpy: vi.fn(async (): Promise<"delivered" | "retryable"> => "delivered"),
}));

vi.mock("../announce/subagent-announce.js", async (importOriginal) => {
  const { hasUsableSessionEntry } =
    await importOriginal<typeof import("../announce/subagent-announce.js")>();
  return {
    hasUsableSessionEntry,
    runSubagentAnnounceFlow: announceSpy,
    captureSubagentCompletionReply: vi.fn(async () => undefined),
  };
});

export { announceSpy };

export function createSubagentPersistenceRuntime(call: typeof callGateway): GatewayRecoveryRuntime {
  return {
    dispatchSessionMethod: (method, params, options) =>
      call({
        method,
        params,
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
        assertDispatchCurrent: options?.assertCurrent,
      }),
    dispatchAgent: (params, timeoutMs) => call({ method: "agent", params, timeoutMs }),
    waitForAgent: (params, timeoutMs) => call({ method: "agent.wait", params, timeoutMs }),
    sendRecoveryNotice: vi.fn(),
  };
}

export function listFixtureAgentDatabases(
  listDatabases: typeof listOpenClawAgentDatabasesForTest,
  stateDir: string,
) {
  return listDatabases().filter((database) => isPathInside(stateDir, database.path));
}
