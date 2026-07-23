import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../../types.js";
import {
  chooseMatrixFinalFreshnessAction,
  sanitizeMatrixFinalFreshnessActions,
  type MatrixDraftFreshnessState,
} from "./draft-freshness.js";

const prepareSimpleCompletionModelForAgentMock = vi.hoisted(() =>
  vi.fn(async () => ({ model: {}, auth: {} })),
);
const completeWithPreparedSimpleCompletionModelMock = vi.hoisted(() =>
  vi.fn(async () => ({ text: '{"finalAction":"send-as-is"}' })),
);

vi.mock("openclaw/plugin-sdk/simple-completion-runtime", () => ({
  completeWithPreparedSimpleCompletionModel: completeWithPreparedSimpleCompletionModelMock,
  prepareSimpleCompletionModelForAgent: prepareSimpleCompletionModelForAgentMock,
}));

const cfg = {} as CoreConfig;

const staleState: MatrixDraftFreshnessState = {
  roomChangedSinceDraftStart: true,
  invalidatingEventIds: ["$new"],
  recheckEventIds: [],
  latestVisibleEventIds: ["$new"],
  reason: "latest-visible-event",
};

beforeEach(() => {
  prepareSimpleCompletionModelForAgentMock.mockReset().mockResolvedValue({ model: {}, auth: {} });
  completeWithPreparedSimpleCompletionModelMock
    .mockReset()
    .mockResolvedValue({ text: '{"finalAction":"send-as-is"}' });
});

describe("sanitizeMatrixFinalFreshnessActions", () => {
  it("defaults omitted actions while preserving an explicitly empty AI allowlist", () => {
    expect(sanitizeMatrixFinalFreshnessActions()).toEqual(["revise", "send-as-is", "suppress"]);
    expect(sanitizeMatrixFinalFreshnessActions([])).toEqual([]);
  });
});

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

  it("fails open when model preparation fails even if the AI allowlist only allows suppress", async () => {
    prepareSimpleCompletionModelForAgentMock.mockResolvedValueOnce({
      error: "unavailable",
    } as never);

    await expect(
      chooseMatrixFinalFreshnessAction({
        allowedActions: ["suppress"],
        cfg,
        config: { aiDeterminesFinalAction: true },
        ctxPayload: {},
        mode: "auto",
        state: staleState,
        agentId: "ops",
      }),
    ).resolves.toBe("send-as-is");
  });

  it("fails open for a malformed AI decision when no AI action is allowed", async () => {
    completeWithPreparedSimpleCompletionModelMock.mockResolvedValueOnce({ text: "not json" });

    await expect(
      chooseMatrixFinalFreshnessAction({
        allowedActions: [],
        cfg,
        config: { aiDeterminesFinalAction: true },
        ctxPayload: {},
        mode: "auto",
        state: staleState,
        agentId: "ops",
      }),
    ).resolves.toBe("send-as-is");
  });
});
