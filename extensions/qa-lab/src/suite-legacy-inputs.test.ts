import { beforeEach, describe, expect, it, vi } from "vitest";

const runQaFlowSuiteFromRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("./suite-run.runtime.js", () => ({
  runQaFlowSuiteFromRuntime: runQaFlowSuiteFromRuntimeMock,
}));

import { runQaFlowSuite } from "./suite.js";

describe("deprecated QA suite selection inputs", () => {
  beforeEach(() => {
    runQaFlowSuiteFromRuntimeMock.mockReset();
  });

  it("normalizes the deprecated Crabline selection at the exported suite boundary", async () => {
    runQaFlowSuiteFromRuntimeMock.mockResolvedValueOnce({});

    await runQaFlowSuite({
      channelDriverSelection: {
        capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
        channel: "telegram",
        channelDriver: "crabline",
        providerReadinessArtifactPath: "crabline-provider-readiness.json",
      },
    });

    expect(runQaFlowSuiteFromRuntimeMock).toHaveBeenCalledWith({
      channelDriver: "crabline",
      channelId: "telegram",
    });
  });

  it("rejects conflicts between deprecated and canonical channel selection", async () => {
    await expect(
      runQaFlowSuite({
        channelDriver: "live",
        channelDriverSelection: {
          capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
          channel: "telegram",
          channelDriver: "crabline",
          providerReadinessArtifactPath: "crabline-provider-readiness.json",
        },
      }),
    ).rejects.toThrow("channelDriver=live conflicts with adapter setup driver=crabline");

    expect(runQaFlowSuiteFromRuntimeMock).not.toHaveBeenCalled();
  });
});
