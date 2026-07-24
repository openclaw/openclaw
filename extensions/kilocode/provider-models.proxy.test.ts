// Kilocode proxy tests cover the live model discovery transport policy.
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { discoverKilocodeModels, KILOCODE_MODELS_URL } from "./provider-models.js";

const ORIGINAL_VITEST = process.env.VITEST;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function restoreEnv(key: "VITEST" | "NODE_ENV", value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv("VITEST", ORIGINAL_VITEST);
  restoreEnv("NODE_ENV", ORIGINAL_NODE_ENV);
  fetchWithSsrFGuardMock.mockReset();
  vi.restoreAllMocks();
});

describe("Kilocode model discovery proxy policy", () => {
  it("allows the guarded gateway catalog request to use an eligible HTTP proxy", async () => {
    // Kilocode's discovery short-circuit is `NODE_ENV === "test" || process.env.VITEST`,
    // and any non-empty VITEST string (e.g. "false") is truthy, so it must be removed —
    // not just reassigned — to exercise the real guarded-fetch path.
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("unavailable", { status: 503 }),
      release,
      finalUrl: KILOCODE_MODELS_URL,
    });

    await discoverKilocodeModels();

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "trusted_env_proxy",
        url: KILOCODE_MODELS_URL,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
