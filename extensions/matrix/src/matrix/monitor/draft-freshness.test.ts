import { describe, expect, it } from "vitest";
import type { CoreConfig } from "../../types.js";
import {
  chooseMatrixFinalFreshnessAction,
  type MatrixDraftFreshnessState,
} from "./draft-freshness.js";

const cfg = {} as CoreConfig;

const staleState: MatrixDraftFreshnessState = {
  roomChangedSinceDraftStart: true,
  invalidatingEventIds: ["$new"],
  recheckEventIds: [],
  latestVisibleEventIds: ["$new"],
  reason: "latest-visible-event",
};

describe("chooseMatrixFinalFreshnessAction", () => {
  it("honors explicit modes even when the AI allowlist excludes that action", async () => {
    await expect(
      chooseMatrixFinalFreshnessAction({
        allowedActions: ["send-as-is"],
        cfg,
        config: { allowedFinalActions: ["send-as-is"] },
        ctxPayload: {},
        mode: "suppress",
        state: staleState,
        agentId: "ops",
      }),
    ).resolves.toBe("suppress");
  });

  it("honors deterministic finalAction even when the AI allowlist excludes it", async () => {
    await expect(
      chooseMatrixFinalFreshnessAction({
        allowedActions: ["send-as-is"],
        cfg,
        config: {
          allowedFinalActions: ["send-as-is"],
          finalAction: "revise",
        },
        ctxPayload: {},
        mode: "auto",
        state: staleState,
        agentId: "ops",
      }),
    ).resolves.toBe("revise");
  });
});
