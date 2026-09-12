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
        dependencies: expect.objectContaining({ "@trycua/cua-driver": "0.23.2" }),
        cuaDriverArtifacts: expect.objectContaining({
          "win32-arm64-msvc": {
            files: {
              "cua_driver_node_runtime.node":
                "b1489b9bc49903aef60c829641a985b8508fc7df4739b282217fab3cfc1e0fa4",
              "cua_driver_sdk.dll":
                "1752431065fd81daae23dce717cd2281b344cda4cad6b75fe5bf6031ab374f5c",
            },
          },
        }),
      }),
    }),
  );
});
