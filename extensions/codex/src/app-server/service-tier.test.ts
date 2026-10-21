import { describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { CodexAppServerScopedRequestRejectedError } from "./request.js";
import { CODEX_RESPONSES_OAUTH_PROVIDER } from "./responses-oauth.js";
import { withCodexAppServerFastModeServiceTier } from "./run-attempt-lifecycle.js";
import { resolveCodexUltrafastServiceTier } from "./service-tier.js";
import { createClientHarness } from "./test-support.js";

const supportedModel = {
  id: "catalog-alias",
  model: "native-model",
  displayName: "Test model",
  description: "Test model",
  hidden: false,
  isDefault: false,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: "medium",
  serviceTiers: [{ id: "ultrafast", name: "Ultrafast", description: "Faster" }],
};

function fixture() {
  const { client } = createClientHarness();
  const request = vi.spyOn(client, "request").mockResolvedValue({ data: [supportedModel] });
  const controller = new AbortController();
  const params = {
    enabled: true,
    serviceTier: "priority",
    model: "native-model",
    modelProvider: "openai",
    client,
    timeoutMs: 2500,
    signal: controller.signal,
    assertCurrent: vi.fn(),
  };
  return {
    request,
    controller,
    params,
    resolve: (overrides: Partial<Parameters<typeof resolveCodexUltrafastServiceTier>[0]> = {}) =>
      resolveCodexUltrafastServiceTier({ ...params, ...overrides }),
  };
}

describe("optional Codex Ultrafast", () => {
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
    const { params, request } = fixture();
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    request.mockImplementation(async () => {
      now.mockReturnValue(4000);
      return { data: [], nextCursor: "next-page" };
    });
    try {
      expect(await resolveCodexUltrafastServiceTier(params)).toBe("priority");
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });
  it("keeps the catalog deadline bounded when the wall clock rewinds", async () => {
    const { params, request } = fixture();
    const capturedTimeoutMs: number[] = [];
    let monotonicNow = 1000;
    const perfNow = vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
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
    try {
      await resolveCodexUltrafastServiceTier(params);
      expect(capturedTimeoutMs.length).toBe(2);
      for (const captured of capturedTimeoutMs) {
        expect(captured).toBeLessThanOrEqual(2500);
      }
    } finally {
      perfNow.mockRestore();
      dateNow.mockRestore();
    }
  });
  it.each([
    { enabled: false, serviceTier: "flex", modelProvider: "openai" },
    { enabled: true, serviceTier: "priority", modelProvider: "custom-provider" },
  ])("keeps inactive or custom-provider selection $serviceTier", async (selection) => {
    const { resolve, request } = fixture();
    expect(await resolve(selection)).toBe(selection.serviceTier);
    expect(request).toHaveBeenCalledTimes(0);
  });

  it("supports the managed ChatGPT subscription-sharing provider", async () => {
    const { resolve } = fixture();
    expect(
      await resolve({ modelProvider: CODEX_RESPONSES_OAUTH_PROVIDER, serviceTier: null }),
    ).toBe("ultrafast");
  });

  it("does not match another model through its catalog alias", async () => {
    const { resolve } = fixture();
    expect(await resolve({ model: "catalog-alias" })).toBe("priority");
  });

  it("propagates cancellation instead of falling back", async () => {
    const { params, request, controller } = fixture();
    const aborted = new Error("cancelled turn");
    request.mockImplementation(async () => {
      controller.abort(aborted);
      throw aborted;
    });
    await expect(resolveCodexUltrafastServiceTier(params)).rejects.toBe(aborted);
  });

  it("propagates scoped authority rejection instead of falling back", async () => {
    const { params, request } = fixture();
    const rejected = new CodexAppServerScopedRequestRejectedError("retired owner");
    request.mockRejectedValue(rejected);
    await expect(resolveCodexUltrafastServiceTier(params)).rejects.toBe(rejected);
  });

  it("rechecks live authority after the catalog response", async () => {
    const { params, request } = fixture();
    const retired = new Error("retired owner");
    request.mockImplementation(async () => {
      params.assertCurrent.mockImplementation(() => {
        throw retired;
      });
      return { data: [supportedModel] };
    });
    await expect(resolveCodexUltrafastServiceTier(params)).rejects.toBe(retired);
  });
});
