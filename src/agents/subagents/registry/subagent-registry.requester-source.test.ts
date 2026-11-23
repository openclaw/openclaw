import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/config.js";
import { callGateway } from "../../../gateway/call.js";
import { captureQueuedOperatorRecoverySource } from "../../../gateway/operator-run-recovery-source.js";
import {
  createOperatorRecoveryFixture,
  pairedOperator,
  restoreFixture,
} from "../../../gateway/operator-run-recovery.test-support.js";
import { bindGatewayLifecycleRequest } from "../../../gateway/server-lifecycle-runtime-context.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { onAgentEvent } from "../../../infra/agent-events.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.test-helpers.js";

vi.mock("../../../gateway/call.js", { spy: true });
vi.mock("../../../gateway/server-lifecycle-runtime-context.js", { spy: true });
vi.mock("../../../infra/agent-events.js", { spy: true });

beforeEach(() => {
  vi.mocked(callGateway).mockResolvedValue({ status: "pending" });
  vi.mocked(bindGatewayLifecycleRequest).mockReturnValue(callGateway);
  vi.mocked(onAgentEvent).mockReturnValue(() => {});
});

afterEach(async () => {
  await resetSubagentRegistryForTests({ persist: false });
  vi.mocked(callGateway).mockReset();
  vi.mocked(bindGatewayLifecycleRequest).mockReset();
  vi.mocked(onAgentEvent).mockReset();
});

// Restart recovery re-admits this saved source for the woken parent turn.
it("saves the spawning requester's restart source on the registered run", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    setRuntimeConfigSnapshot({});
    const profile = ensureProfileForEmail("spawn-requester@example.test");
    const requester = await createOperatorRecoveryFixture({
      stateDir,
      profileId: profile.id,
      context: createContext(),
      config: {},
      scopes: ["operator.read", "operator.write"],
      device: pairedOperator(),
    });
    using live = await restoreFixture(requester);
    const resolveGatewayContext = () => requester.context;
    const client = createSyntheticPluginRuntimeClient({
      operatorRunAuthority: live.authority,
      scopes: ["operator.read", "operator.write"],
    });
    await withPluginRuntimeGatewayRequestScope(
      { client, context: requester.context, resolveGatewayContext, isWebchatConnect: () => false },
      () =>
        registerSubagentRun({
          runId: "saved-requester-source",
          childSessionKey: "agent:main:subagent:saved-requester-source",
          childAgentId: "main",
          sessionEntry: { sessionId: "original-saved-requester-source" },
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "result",
          cleanup: "keep",
          expectsCompletionMessage: true,
          gatewayContextResolver: resolveGatewayContext,
        }),
    );
    const saved = loadSubagentRegistryFromSqlite().get("saved-requester-source");
    expect(saved?.requesterOperatorSource?.kind).toBe("gateway");
    expect(saved?.requesterOperatorSource).toEqual(
      captureQueuedOperatorRecoverySource(live.authority),
    );
  }));
