import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { createModelFixture } from "./model-fixture.test-support.js";
import { CodexAppServerScopedRequestRejectedError } from "./request.js";
import { CODEX_RESPONSES_OAUTH_PROVIDER } from "./responses-oauth.js";
import { withCodexAppServerFastModeServiceTier } from "./run-attempt-lifecycle.js";
import { resolveCodexUltrafastServiceTier } from "./service-tier.js";
import { createClientHarness } from "./test-support.js";

const supportedModel = {
  ...createModelFixture("native-model"),
  id: "catalog-alias",
  serviceTiers: [{ id: "ultrafast", name: "Ultrafast", description: "Faster" }],
};

function fixture() {
  const { client } = createClientHarness();
  const request = vi.spyOn(client, "request").mockResolvedValue({ data: [supportedModel] });
  const params = {
    enabled: true,
    serviceTier: "priority",
    model: "native-model",
    modelProvider: "openai",
    client,
    timeoutMs: 2500,
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
  };
  return {
    request,
    params,
    resolve: (overrides: Partial<Parameters<typeof resolveCodexUltrafastServiceTier>[0]> = {}) =>
      resolveCodexUltrafastServiceTier({ ...params, ...overrides }),
  };
}

describe("optional Codex Ultrafast", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    { tier: "priority", expected: "priority" },
    { tier: undefined, expected: null },
    { tier: "ultrafast", expected: "priority" },
  ] as const)(
    "restores baseline $expected after explicit Ultrafast with configured tier $tier",
    async ({ tier, expected }) => {
      const baseline = {
        ...resolveCodexAppServerRuntimeOptions({ env: {} }),
        serviceTier: tier,
      };
      const restored = withCodexAppServerFastModeServiceTier(
        { ...baseline, serviceTier: "ultrafast" },
        { fastMode: undefined },
        baseline,
      );
      expect(restored.serviceTier).toBe(expected);
      const { resolve, request } = fixture();
      request.mockResolvedValue({
        data: [{ ...supportedModel, serviceTiers: [] }],
      });
      expect(await resolve({ serviceTier: restored.serviceTier })).toBe(expected);
    },
  );
  it("bounds all catalog pages by one optional discovery budget", async () => {
    const { resolve, request } = fixture();
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    request.mockImplementation(async () => {
      now.mockReturnValue(4000);
      return { data: [], nextCursor: "next-page" };
    });
    expect(await resolve()).toBe("priority");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("keeps the catalog deadline bounded when the wall clock rewinds", async () => {
    const { resolve, request } = fixture();
    const capturedTimeoutMs: number[] = [];
    let monotonicNow = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => 1000);
    request.mockImplementation(
      async (_method: string, _params: unknown, options?: { timeoutMs?: number }) => {
        if (options?.timeoutMs !== undefined) {
          capturedTimeoutMs.push(options.timeoutMs);
        }
        // Rewinding wall time must not extend the monotonic discovery budget.
        if (capturedTimeoutMs.length === 1) {
          dateNow.mockReturnValue(-120_000);
          monotonicNow += 500;
        }
        return capturedTimeoutMs.length === 1
          ? { data: [supportedModel], nextCursor: "next-page" }
          : { data: [supportedModel] };
      },
    );
    await resolve();
    expect(capturedTimeoutMs.length).toBe(2);
    for (const captured of capturedTimeoutMs) {
      expect(captured).toBeLessThanOrEqual(2500);
    }
  });
  it.each([
    [{ enabled: false, serviceTier: "flex" }, "flex", 0],
    [{ modelProvider: "custom-provider" }, "priority", 0],
    [{ modelProvider: CODEX_RESPONSES_OAUTH_PROVIDER, serviceTier: null }, "ultrafast", 1],
    [{ model: "catalog-alias" }, "priority", 1],
  ] as const)("resolves selection %j to %s", async (selection, expected, requests) => {
    const { resolve, request } = fixture();
    expect(await resolve(selection)).toBe(expected);
    expect(request).toHaveBeenCalledTimes(requests);
  });

  it.each(["cancellation", "scoped rejection", "retired authority"])(
    "propagates %s instead of falling back",
    async (failure) => {
      const { params, resolve, request } = fixture();
      const controller = new AbortController();
      const error =
        failure === "scoped rejection"
          ? new CodexAppServerScopedRequestRejectedError("retired owner")
          : new Error(failure);
      request.mockImplementation(async () => {
        if (failure === "retired authority") {
          params.assertCurrent.mockImplementation(() => {
            throw error;
          });
        } else {
          if (failure === "cancellation") {
            controller.abort(error);
          }
          throw error;
        }
        return { data: [supportedModel] };
      });
      await expect(resolve({ signal: controller.signal })).rejects.toBe(error);
    },
  );
});
