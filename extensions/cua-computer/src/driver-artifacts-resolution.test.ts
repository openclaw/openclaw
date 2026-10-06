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
        dependencies: expect.objectContaining({ "@trycua/cua-driver": "0.30.2" }),
        cuaDriverArtifacts: expect.objectContaining({
          "win32-arm64-msvc": {
            files: {
              "cua_driver_node_runtime.node":
                "e47dbc8f1d986a5bb8968f715191c9f5e9c1710b70680fc2f11c3159817dcc5e",
              "cua_driver_sdk.dll":
                "bf00534fa8975517b849cb0a0c9c65d0f689583a10484fd7e8487755ce95968e",
            },
          },
        }),
      }),
    }),
  );
});
