import path from "node:path";
import { createJiti } from "jiti";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPluginLoaderJitiOptions,
  resolvePluginSdkScopedAliasMap,
} from "../../src/plugins/sdk-alias.ts";

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
    const jiti = createJiti(import.meta.url, {
      ...buildPluginLoaderJitiOptions(
        resolvePluginSdkScopedAliasMap({ modulePath: runtimeApiPath }),
      ),
      tryNative: false,
    });

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
