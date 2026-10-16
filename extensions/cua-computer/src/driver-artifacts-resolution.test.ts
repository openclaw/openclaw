import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(() => ({ ok: true, applicable: false }) as const),
}));

vi.mock("./driver-artifact-verification.js", () => ({
  inspectCuaDriverArtifacts: mocks.inspect,
  readPackageIdentity: vi.fn(),
}));

import { verifyInstalledCuaDriverArtifacts } from "./driver-artifacts.js";

it("supplies the accepted artifact record without depending on the bundled module path", () => {
  verifyInstalledCuaDriverArtifacts();

  expect(mocks.inspect).toHaveBeenCalledWith(
    expect.objectContaining({
      pluginManifest: expect.objectContaining({
        dependencies: expect.objectContaining({ "@trycua/cua-driver": "0.34.0" }),
        cuaDriverArtifacts: expect.objectContaining({
          "win32-arm64-msvc": {
            files: {
              "cua_driver_node_runtime.node":
                "b264b75eb898a6035b0b2ddb8f9dc0e5d5a8da7bd240aeae3b2087249d6b9ed1",
              "cua_driver_sdk.dll":
                "a05a0477f05854acd86ad879d24b7fe5670761c49d11035f77aa185f3ed3738a",
            },
          },
        }),
      }),
    }),
  );
});
