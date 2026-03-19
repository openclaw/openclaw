import { beforeEach, describe, expect, it, vi } from "vitest";

const withStartedActionClientMock = vi.fn();
const loadConfigMock = vi.fn(() => ({
  channels: {
    matrix: {},
  },
}));

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => ({
    config: {
      loadConfig: loadConfigMock,
    },
  }),
}));

vi.mock("./client.js", () => ({
  withStartedActionClient: (...args: unknown[]) => withStartedActionClientMock(...args),
}));

const { listMatrixVerifications } = await import("./verification.js");

describe("matrix verification actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({
      channels: {
        matrix: {},
      },
    });
  });

  it("points encryption guidance at the selected Matrix account", async () => {
    loadConfigMock.mockReturnValue({
      channels: {
        matrix: {
          accounts: {
            ops: {
              encryption: false,
            },
          },
        },
      },
    });
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto: null });
    });

    await expect(listMatrixVerifications({ accountId: "ops" })).rejects.toThrow(
      "Matrix encryption is not available (enable channels.matrix.accounts.ops.encryption=true)",
    );
  });

  it("uses the resolved default Matrix account when accountId is omitted", async () => {
    loadConfigMock.mockReturnValue({
      channels: {
        matrix: {
          defaultAccount: "ops",
          accounts: {
            ops: {
              encryption: false,
            },
          },
        },
      },
    });
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto: null });
    });

    await expect(listMatrixVerifications()).rejects.toThrow(
      "Matrix encryption is not available (enable channels.matrix.accounts.ops.encryption=true)",
    );
  });

  it("uses explicit cfg instead of runtime config when crypto is unavailable", async () => {
    const explicitCfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              encryption: false,
            },
          },
        },
      },
    };
    loadConfigMock.mockImplementation(() => {
      throw new Error("verification actions should not reload runtime config when cfg is provided");
    });
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto: null });
    });

    await expect(listMatrixVerifications({ cfg: explicitCfg, accountId: "ops" })).rejects.toThrow(
      "Matrix encryption is not available (enable channels.matrix.accounts.ops.encryption=true)",
    );
    expect(loadConfigMock).not.toHaveBeenCalled();
  });
});
