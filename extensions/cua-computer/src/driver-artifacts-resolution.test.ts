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
        dependencies: expect.objectContaining({ "@trycua/cua-driver": "0.33.1" }),
        cuaDriverArtifacts: expect.objectContaining({
          "win32-arm64-msvc": {
            files: {
              "cua_driver_node_runtime.node":
                "c15baf1cfab5eb4f108f9d2d6dcded76cdfd5fffcda4af9041843e06db7b6740",
              "cua_driver_sdk.dll":
                "250db2a39a4834ffecaca6d7ae60a2b3f581a619e47f9b7767cb5f1ff42f3d96",
            },
          },
        }),
      }),
    }),
  );
});
