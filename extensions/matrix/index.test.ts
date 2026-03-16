import { beforeEach, describe, expect, it, vi } from "vitest";

const setMatrixRuntimeMock = vi.hoisted(() => vi.fn());
const registerChannelMock = vi.hoisted(() => vi.fn());

vi.mock("./src/runtime.js", () => ({
  setMatrixRuntime: setMatrixRuntimeMock,
}));

const { default: matrixPlugin } = await import("./index.js");

describe("matrix plugin registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the channel without bootstrapping crypto runtime", () => {
    const runtime = {} as never;
    matrixPlugin.register({
      runtime,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      registerChannel: registerChannelMock,
    } as never);

    expect(setMatrixRuntimeMock).toHaveBeenCalledWith(runtime);
    expect(registerChannelMock).toHaveBeenCalledWith({ plugin: expect.any(Object) });
  });
});
