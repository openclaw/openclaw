import { beforeAll, describe, expect, it, vi } from "vitest";

vi.unmock("../secrets/provider-env-vars.js");

let collectProviderApiKeys: typeof import("./live-auth-keys.js").collectProviderApiKeys;

async function loadModulesForTest(): Promise<void> {
  ({ collectProviderApiKeys } = await import("./live-auth-keys.js"));
}

describe("collectProviderApiKeys", () => {
  beforeAll(async () => {
    await loadModulesForTest();
  });

  it("honors provider auth env vars with nonstandard names", async () => {
    const env = { MODELSTUDIO_API_KEY: "modelstudio-live-key" };

    expect(
      collectProviderApiKeys("alibaba", {
        env,
        providerEnvVars: ["MODELSTUDIO_API_KEY", "DASHSCOPE_API_KEY"],
      }),
    ).toEqual(["modelstudio-live-key"]);
  });

  it("dedupes manifest env vars against direct provider env naming", async () => {
    const env = { XAI_API_KEY: "xai-live-key" };

    expect(
      collectProviderApiKeys("xai", {
        env,
        providerEnvVars: ["XAI_API_KEY"],
      }),
    ).toEqual(["xai-live-key"]);
  });
});
