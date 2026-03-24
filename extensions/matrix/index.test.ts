import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeApiExportTypesViaJiti } from "../../test/helpers/extensions/jiti-runtime-api.ts";

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
    const runtimeApiPath = path.join(process.cwd(), "extensions", "matrix", "runtime-api.ts");
    expect(
      loadRuntimeApiExportTypesViaJiti({
        modulePath: runtimeApiPath,
        exportNames: [
          "requiresExplicitMatrixDefaultAccount",
          "resolveMatrixDefaultOrOnlyAccountId",
        ],
      }),
    ).toEqual({
      requiresExplicitMatrixDefaultAccount: "function",
      resolveMatrixDefaultOrOnlyAccountId: "function",
    });
  }, 240_000);

  it("loads the matrix src runtime api through Jiti without duplicate export errors", () => {
    const runtimeApiPath = path.join(
      process.cwd(),
      "extensions",
      "matrix",
      "src",
      "runtime-api.ts",
    );
    expect(
      loadRuntimeApiExportTypesViaJiti({
        modulePath: runtimeApiPath,
        exportNames: ["resolveMatrixAccountStringValues"],
      }),
    ).toEqual({
      resolveMatrixAccountStringValues: "function",
    });
  }, 240_000);

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
