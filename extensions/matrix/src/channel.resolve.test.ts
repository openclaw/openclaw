// Matrix tests cover channel.resolve plugin behavior.
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveMatrixTargetsMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock("./resolve-targets.js", () => ({
  resolveMatrixTargets: resolveMatrixTargetsMock,
}));

import { matrixResolverAdapter } from "./resolver.js";

describe("matrix resolver adapter", () => {
  beforeEach(() => {
    resolveMatrixTargetsMock.mockClear();
  });

  it("forwards accountId into Matrix target resolution", async () => {
    const runtime = createNonExitingRuntimeEnv();
    await matrixResolverAdapter.resolveTargets({
      cfg: { channels: { matrix: {} } },
      accountId: "ops",
      inputs: ["Alice"],
      kind: "user",
      runtime,
    });

    expect(resolveMatrixTargetsMock).toHaveBeenCalledTimes(1);
    expect(resolveMatrixTargetsMock).toHaveBeenCalledWith({
      cfg: { channels: { matrix: {} } },
      accountId: "ops",
      inputs: ["Alice"],
      kind: "user",
      runtime,
    });
  });
});
