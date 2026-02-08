import { beforeEach, describe, expect, it, vi } from "vitest";

const createMatrixClientMock = vi.fn();
const isBunRuntimeMock = vi.fn(() => false);

vi.mock("./client.js", () => ({
  createMatrixClient: (...args: unknown[]) => createMatrixClientMock(...args),
  isBunRuntime: () => isBunRuntimeMock(),
}));

import { probeMatrix } from "./probe.js";

describe("probeMatrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isBunRuntimeMock.mockReturnValue(false);
    createMatrixClientMock.mockResolvedValue({
      getUserId: vi.fn(async () => "@bot:example.org"),
    });
  });

  it("passes undefined userId when not provided", async () => {
    const result = await probeMatrix({
      homeserver: "https://matrix.example.org",
      accessToken: "tok",
      timeoutMs: 1234,
    });

    expect(result.ok).toBe(true);
    expect(createMatrixClientMock).toHaveBeenCalledWith({
      homeserver: "https://matrix.example.org",
      userId: undefined,
      accessToken: "tok",
      localTimeoutMs: 1234,
    });
  });

  it("trims provided userId before client creation", async () => {
    await probeMatrix({
      homeserver: "https://matrix.example.org",
      accessToken: "tok",
      userId: "  @bot:example.org  ",
      timeoutMs: 500,
    });

    expect(createMatrixClientMock).toHaveBeenCalledWith({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok",
      localTimeoutMs: 500,
    });
  });
});
