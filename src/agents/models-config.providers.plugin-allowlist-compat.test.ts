import { describe, expect, it } from "vitest";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "../plugins/bundled-compat.js";
import { resolveEnabledProviderPluginIds } from "../plugins/providers.js";

describe("implicit provider plugin allowlist compatibility", () => {
  it("keeps bundled implicit providers discoverable when plugins.allow is set", () => {
    const config = withBundledPluginEnablementCompat({
      config: withBundledPluginAllowlistCompat({
        config: {
          plugins: {
            allow: ["openrouter"],
          },
        },
        pluginIds: ["kilocode", "moonshot"],
      }),
      pluginIds: ["kilocode", "moonshot"],
    });

    expect(
      resolveEnabledProviderPluginIds({
        config,
        env: { VITEST: "1" } as NodeJS.ProcessEnv,
        onlyPluginIds: ["kilocode", "moonshot", "openrouter"],
      }),
    ).toEqual(["kilocode", "moonshot", "openrouter"]);
  });

  it("still honors explicit plugin denies over compat allowlist injection", () => {
    const config = withBundledPluginEnablementCompat({
      config: withBundledPluginAllowlistCompat({
        config: {
          plugins: {
            allow: ["openrouter"],
            deny: ["kilocode"],
          },
        },
        pluginIds: ["kilocode", "moonshot"],
      }),
      pluginIds: ["kilocode", "moonshot"],
    });

    expect(
      resolveEnabledProviderPluginIds({
        config,
        env: { VITEST: "1" } as NodeJS.ProcessEnv,
        onlyPluginIds: ["kilocode", "moonshot", "openrouter"],
      }),
    ).toEqual(["moonshot", "openrouter"]);
  });
});
