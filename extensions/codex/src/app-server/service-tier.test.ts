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
  return {
    request,
    controller,
    params: {
      enabled: true,
      serviceTier: "priority",
      model: "native-model",
      modelProvider: "openai",
      client,
      timeoutMs: 2500,
      signal: controller.signal,
      assertCurrent: vi.fn(),
    },
  };
}

describe("optional Codex Ultrafast", () => {
  it.each(["priority", undefined] as const)(
    "restores baseline %s after a prior upgrade before an unsupported retry",
    async (tier) => {
      const baseline = { ...resolveCodexAppServerRuntimeOptions({ env: {} }), serviceTier: tier };
      const restored = withCodexAppServerFastModeServiceTier(
        { ...baseline, serviceTier: "ultrafast" },
        { fastMode: undefined },
        baseline,
      );
      expect(restored.serviceTier).toBe(tier ?? null);
      const { params, request } = fixture();
      request.mockResolvedValue({ data: [{ ...supportedModel, serviceTiers: [] }] });
      expect(
        await resolveCodexUltrafastServiceTier({ ...params, serviceTier: restored.serviceTier }),
      ).toBe(tier ?? null);
    },
  );
  it("bounds all catalog pages by one optional discovery budget", async () => {
    const { params, request } = fixture();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
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
  it.each([
    { enabled: false, serviceTier: "flex", modelProvider: "openai" },
    { enabled: true, serviceTier: "priority", modelProvider: "custom-provider" },
  ])("keeps inactive or custom-provider selection $serviceTier", async (selection) => {
    const { params, request } = fixture();
    expect(await resolveCodexUltrafastServiceTier({ ...params, ...selection })).toBe(
      selection.serviceTier,
    );
    expect(request).toHaveBeenCalledTimes(0);
  });

  it("supports the managed ChatGPT subscription-sharing provider", async () => {
    const { params } = fixture();
    expect(
      await resolveCodexUltrafastServiceTier({
        ...params,
        modelProvider: CODEX_RESPONSES_OAUTH_PROVIDER,
        serviceTier: null,
      }),
    ).toBe("ultrafast");
  });

  it("does not match another model through its catalog alias", async () => {
    const { params } = fixture();
    expect(await resolveCodexUltrafastServiceTier({ ...params, model: "catalog-alias" })).toBe(
      "priority",
    );
  });

  it("keeps the baseline when the catalog response is malformed", async () => {
    const { params, request } = fixture();
    request.mockResolvedValue({ data: [{ model: "malformed" }] });
    expect(await resolveCodexUltrafastServiceTier(params)).toBe("priority");
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
