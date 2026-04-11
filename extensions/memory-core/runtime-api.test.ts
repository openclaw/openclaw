import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuntimeApiExportTypesViaJiti } from "../../test/helpers/plugins/jiti-runtime-api.js";

describe("memory-core runtime api", () => {
  it("exposes gateway request scope through the local runtime api seam", () => {
    const runtimeApiPath = path.join(process.cwd(), "extensions", "memory-core", "runtime-api.ts");

    expect(
      loadRuntimeApiExportTypesViaJiti({
        modulePath: runtimeApiPath,
        exportNames: ["getPluginRuntimeGatewayRequestScope"],
        realPluginSdkSpecifiers: ["openclaw/plugin-sdk/memory-core"],
      }),
    ).toEqual({
      getPluginRuntimeGatewayRequestScope: "function",
    });
  });
});
