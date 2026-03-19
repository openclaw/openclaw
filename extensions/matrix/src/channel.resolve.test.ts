import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveMatrixTargetsMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock("./resolve-targets.js", () => ({
  resolveMatrixTargets: resolveMatrixTargetsMock,
}));

import { matrixPlugin } from "./channel.js";

describe("matrix resolver adapter", () => {
  beforeEach(() => {
    resolveMatrixTargetsMock.mockClear();
  });

  it("forwards accountId into Matrix target resolution", async () => {
    await matrixPlugin.resolver?.resolveTargets({
      cfg: { channels: { matrix: {} } },
      accountId: "ops",
      inputs: ["Alice"],
      kind: "user",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    expect(resolveMatrixTargetsMock).toHaveBeenCalledWith({
      cfg: { channels: { matrix: {} } },
      accountId: "ops",
      inputs: ["Alice"],
      kind: "user",
      runtime: expect.objectContaining({
        log: expect.any(Function),
        error: expect.any(Function),
        exit: expect.any(Function),
      }),
    });
  });
});
