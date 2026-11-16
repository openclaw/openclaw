import { describe, expect, it, vi } from "vitest";
import { MATRIX_QA_SYNC_STATE_AFTER_FAULT_RULE_ID } from "./scenario-runtime-e2ee-shared.js";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

const mocks = vi.hoisted(() => ({
  runMatrixQaE2eeTopLevelScenario: vi.fn(),
}));

vi.mock("./scenario-runtime-e2ee-room.js", () => ({
  buildMatrixE2eeReplyArtifact: vi.fn(),
  buildSyncStateAfterMissingEncryptionFaultRule: (accessToken: string) => ({
    id: "sync-state-after-missing-encryption",
    match: (request: { bearerToken?: string }) => request.bearerToken === accessToken,
  }),
  runMatrixQaE2eeTopLevelScenario: mocks.runMatrixQaE2eeTopLevelScenario,
  runMatrixQaE2eeTopLevelWithClient: vi.fn(),
  withMatrixQaE2eeDriver: vi.fn(),
  withMatrixQaIsolatedE2eeDriverRoom: vi.fn(),
}));

import { runMatrixQaE2eeStateAfterMissingEncryptionScenario } from "./scenario-runtime-e2ee-messages.js";

function setup() {
  vi.clearAllMocks();
  const order: string[] = [];
  const remove = vi.fn(() => order.push("remove"));
  const context = createMatrixQaE2eeTestContext({
    baseUrl: "http://127.0.0.1:28123",
    installFaultRule: vi.fn(() => {
      order.push("install");
      return { hits: () => [], remove };
    }),
    restartGatewayAfterStateMutation: vi.fn<
      MatrixQaScenarioContext["restartGatewayAfterStateMutation"]
    >(async (mutateState) => {
      order.push("restart");
      await mutateState({ stateDir: "/tmp/matrix-qa-state" });
    }),
    sutAccessToken: "sut-token",
    sutAccountId: "sut",
    timeoutMs: 30_000,
  });
  mocks.runMatrixQaE2eeTopLevelScenario.mockImplementation(async () => {
    order.push("run");
    return {
      driverEventId: "$driver",
      reply: { eventId: "$reply", sender: "@sut:matrix-qa.test", tokenMatched: true },
      roomId: "!room:matrix-qa.test",
      roomKey: "state-after",
    };
  });
  return { context, order, remove };
}

describe("runMatrixQaE2eeStateAfterMissingEncryptionScenario", () => {
  it("restarts through an in-place rule without changing the canonical homeserver", async () => {
    const { context, order } = setup();

    const result = await runMatrixQaE2eeStateAfterMissingEncryptionScenario(context);

    expect(order).toEqual(["install", "restart", "run", "remove"]);
    expect(context.restartGatewayAfterStateMutation).toHaveBeenCalledOnce();
    expect(context.installFaultRule).toHaveBeenCalledWith(
      expect.objectContaining({ id: MATRIX_QA_SYNC_STATE_AFTER_FAULT_RULE_ID }),
    );
    expect(result.details).toContain(`fault proxy: ${context.baseUrl}`);
    expect(result.details).toContain("state_after sync opt-in hits: 0");
  });

  it("removes the in-place rule when the encrypted turn fails", async () => {
    const { context, remove } = setup();
    mocks.runMatrixQaE2eeTopLevelScenario.mockRejectedValueOnce(new Error("turn failed"));

    await expect(runMatrixQaE2eeStateAfterMissingEncryptionScenario(context)).rejects.toThrow(
      "turn failed",
    );
    expect(remove).toHaveBeenCalledOnce();
  });
});
