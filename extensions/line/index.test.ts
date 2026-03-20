import path from "node:path";
import { createJiti } from "jiti";
import { describe, expect, it } from "vitest";
import {
  buildPluginLoaderJitiOptions,
  resolvePluginSdkScopedAliasMap,
} from "../../src/plugins/sdk-alias.ts";

describe("line runtime api", () => {
  it("loads the line runtime api through Jiti", () => {
    const runtimeApiPath = path.join(process.cwd(), "extensions", "line", "runtime-api.ts");
    const jiti = createJiti(import.meta.url, {
      ...buildPluginLoaderJitiOptions(
        resolvePluginSdkScopedAliasMap({ modulePath: runtimeApiPath }),
      ),
      tryNative: false,
    });

    expect(jiti(runtimeApiPath)).toMatchObject({
      resolveLineAccount: expect.any(Function),
      formatDocsLink: expect.any(Function),
    });
  });
});
