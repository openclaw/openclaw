import { describe, expect, it } from "vitest";
import { resolveProviderDiscoveryFilterForTest } from "./models-config.providers.implicit.js";

describe("resolveProviderDiscoveryFilterForTest", () => {
  it("maps live provider backend ids to owning plugin ids", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: {
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_PROVIDERS: "claude-cli",
          VITEST: "1",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual(["anthropic"]);
  });

  it("honors gateway live provider filters too", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: {
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_GATEWAY_PROVIDERS: "claude-cli",
          VITEST: "1",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual(["anthropic"]);
  });

  it("keeps explicit plugin-id filters when no owning provider plugin exists", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: {
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_PROVIDERS: "openrouter",
          VITEST: "1",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual(["openrouter"]);
  });
});
