import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderPlugin } from "../plugins/types.js";

const { buildAuthDoctorHint, withProviderRuntimePlugin } = vi.hoisted(() => ({
  buildAuthDoctorHint: vi.fn(),
  withProviderRuntimePlugin: vi.fn(),
}));

// mock-isolation: Exercise hint selection without discovering the host's installed providers.
vi.mock("../plugins/provider-hook-runtime.js", () => ({
  withProviderRuntimePlugin,
}));

import { formatAuthDoctorHint } from "./auth-profiles/doctor.js";

describe("formatAuthDoctorHint", () => {
  beforeEach(() => {
    buildAuthDoctorHint.mockReset().mockResolvedValue(undefined);
    withProviderRuntimePlugin
      .mockReset()
      .mockImplementation(
        async <T>(_params: unknown, run: (provider: ProviderPlugin) => Promise<T>) =>
          run({ id: "demo", label: "Demo", auth: [], buildAuthDoctorHint }),
      );
  });

  it("guides legacy qwen portal oauth profiles to re-authenticate", async () => {
    const hint = await formatAuthDoctorHint({
      store: {
        version: 1,
        profiles: {
          "qwen-portal-auth": {
            type: "oauth",
            provider: "qwen-portal",
            access: "old-access",
            refresh: "old-refresh",
            expires: 0,
          },
        },
      },
      provider: "qwen-portal",
      profileId: "qwen-portal-auth",
    });

    expect(hint).toBe(
      "Legacy Qwen Portal OAuth profiles are not refreshable. Re-authenticate with a current Qwen API key: openclaw onboard --auth-choice qwen-api-key.",
    );
    expect(withProviderRuntimePlugin).not.toHaveBeenCalled();
  });

  it("delegates other provider hints to the provider plugin", async () => {
    buildAuthDoctorHint.mockResolvedValueOnce("Provider-owned repair");

    await expect(
      formatAuthDoctorHint({
        store: { version: 1, profiles: {} },
        provider: "demo",
      }),
    ).resolves.toBe("Provider-owned repair");
    expect(buildAuthDoctorHint).toHaveBeenCalledOnce();
  });
});
