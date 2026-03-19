import path from "node:path";
import { createJiti } from "jiti";
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

  it("loads the matrix runtime api through Jiti", () => {
    const jiti = createJiti(import.meta.url, {
      interopDefault: true,
      tryNative: false,
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"],
    });
    const runtimeApiPath = path.join(process.cwd(), "extensions", "matrix", "runtime-api.ts");

    expect(jiti(runtimeApiPath)).toMatchObject({
      requiresExplicitMatrixDefaultAccount: expect.any(Function),
      resolveMatrixDefaultOrOnlyAccountId: expect.any(Function),
    });
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
