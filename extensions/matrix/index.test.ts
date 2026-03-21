import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePluginSdkScopedAliasMap } from "../../src/plugins/sdk-alias.ts";

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

  it("exposes the lightweight matrix runtime api without bootstrapping crypto runtime", async () => {
    const runtimeApiPath = path.join(process.cwd(), "extensions", "matrix", "runtime-api.ts");
    const aliasMap = resolvePluginSdkScopedAliasMap({ modulePath: runtimeApiPath });

    expect(aliasMap["openclaw/plugin-sdk/infra-runtime"]).toBeDefined();

    const runtimeApi = await import("./runtime-api.ts");
    expect(runtimeApi).toMatchObject({
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
