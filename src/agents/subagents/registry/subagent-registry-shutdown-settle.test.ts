import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { terminateLiveSubagentsForShutdown } from "./subagent-registry.js";
import {
  resetSubagentRegistryForTests,
  seedSubagentRunForReadTest,
} from "./subagent-registry.test-helpers.js";

const completeAttempt = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./subagent-registry-lifecycle-completion.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-registry-lifecycle-completion.js")>()),
  completeSubagentRunAttempt: completeAttempt,
}));
vi.mock("./subagent-run-liveness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-run-liveness.js")>()),
  isSubagentRunLive: (entry: { execution: { endedAt?: number } } | undefined) =>
    entry !== undefined && entry.execution.endedAt === undefined,
}));

beforeEach(async () => {
  setRuntimeConfigSnapshot({});
  await resetSubagentRegistryForTests({ persist: false });
  completeAttempt.mockClear();
});

afterEach(async () => {
  await resetSubagentRegistryForTests({ persist: false });
  clearRuntimeConfigSnapshot();
});

it("settles an unmarked child at shutdown and leaves a marked child unended", async () => {
  const gateway = {} as GatewayRequestContext;
  const resolver = () => gateway;
  for (const runId of ["marked", "unmarked"]) {
    seedSubagentRunForReadTest({
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
      requesterSessionKey: "agent:main:main",
      controllerSessionKey: "agent:main:main",
      execution: { status: "running", startedAt: 1 },
    });
    bindGatewayContextResolver(subagentRuns.get(runId)!, resolver);
  }

  await terminateLiveSubagentsForShutdown(resolver, new Set(["agent:main:subagent:marked"]));

  // The marked child resumes its own task after the restart; only the unmarked one settles.
  expect(completeAttempt).toHaveBeenCalledOnce();
  expect(completeAttempt).toHaveBeenCalledWith(expect.anything(), {
    runId: "unmarked",
    reason: "subagent-error",
    outcome: { status: "error", error: "Gateway stopped" },
    triggerCleanup: false,
    suppressSessionEffects: true,
  });
});
