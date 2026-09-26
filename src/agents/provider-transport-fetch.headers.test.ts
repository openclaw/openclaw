import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import {
  buildGuardedModelFetch,
  ensureModelProviderLocalServiceMock,
  fetchWithSsrFGuardMock,
  installProviderTransportFetchTestHooks,
  latestGuardedFetchParams,
} from "./provider-transport-fetch.test-harness.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

describe("buildGuardedModelFetch headers", () => {
  installProviderTransportFetchTestHooks();

  function sentinelModel(): Model<"openai-responses"> {
    return makeProviderModelFixture<"openai-responses">({
      id: "gpt-5.5",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  }

  it("swaps sentinels in Request-form headers", async () => {
    const sentinel = mintSecretSentinel("request-form-secret", { label: "request-form" });
    const request = new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${sentinel}` },
    });

    const response = await buildGuardedModelFetch(sentinelModel())(request);
    await response.text();

    const headers = new Headers((latestGuardedFetchParams().init as RequestInit).headers);
    expect(headers.get("authorization")).toBe("Bearer request-form-secret");
  });

  it("swaps sentinels in record init headers", async () => {
    const recordSentinel = mintSecretSentinel("record-header-secret", { label: "record-header" });
    const response = await buildGuardedModelFetch(sentinelModel())(
      "https://api.openai.com/v1/responses",
      {
        headers: { "x-api-key": recordSentinel },
      },
    );
    await response.text();
    expect(
      new Headers((latestGuardedFetchParams().init as RequestInit).headers).get("x-api-key"),
    ).toBe("record-header-secret");
    expect(
      new Headers(ensureModelProviderLocalServiceMock.mock.calls[0]?.[1] as HeadersInit).get(
        "x-api-key",
      ),
    ).toBe(recordSentinel);
  });

  it("swaps sentinels in tuple init headers", async () => {
    const tupleSentinel = mintSecretSentinel("tuple-header-secret", { label: "tuple-header" });
    const response = await buildGuardedModelFetch(sentinelModel())(
      "https://api.openai.com/v1/responses",
      {
        headers: [["x-api-key", tupleSentinel]],
      },
    );
    await response.text();
    expect(
      new Headers((latestGuardedFetchParams().init as RequestInit).headers).get("x-api-key"),
    ).toBe("tuple-header-secret");
  });

  it("swaps sentinels in Headers init and composed Cloudflare auth values", async () => {
    const sentinel = mintSecretSentinel("cloudflare-upstream-secret", { label: "cloudflare" });
    const callerHeaders = new Headers({ "cf-aig-authorization": `Bearer ${sentinel}` });
    const response = await buildGuardedModelFetch(sentinelModel())(
      "https://api.openai.com/v1/responses",
      {
        headers: callerHeaders,
      },
    );
    await response.text();

    const headers = new Headers((latestGuardedFetchParams().init as RequestInit).headers);
    expect(headers.get("cf-aig-authorization")).toBe("Bearer cloudflare-upstream-secret");
    expect(callerHeaders.get("cf-aig-authorization")).toBe(`Bearer ${sentinel}`);
  });

  it("normalizes a Headers instance with a custom iterator before scanning sentinels", async () => {
    const sentinel = mintSecretSentinel("iterable-header-secret", { label: "iterable-header" });
    const callerHeaders = new Headers({ "x-api-key": "original-value" });
    callerHeaders[Symbol.iterator] = function* () {
      yield ["x-api-key", sentinel];
      return undefined;
    };
    const response = await buildGuardedModelFetch(sentinelModel())(
      "https://api.openai.com/v1/responses",
      { headers: callerHeaders },
    );
    await response.text();

    expect(
      new Headers((latestGuardedFetchParams().init as RequestInit).headers).get("x-api-key"),
    ).toBe("iterable-header-secret");
    expect(callerHeaders.get("x-api-key")).toBe("original-value");
  });

  it("swaps sentinels in URL query parameters", async () => {
    const sentinel = mintSecretSentinel("gemini&scope=two+#%", { label: "gemini-query" });
    const response = await buildGuardedModelFetch(sentinelModel())(
      `https://api.openai.com/v1/responses?key=${sentinel}`,
    );
    await response.text();

    expect(latestGuardedFetchParams().url).toBe(
      "https://api.openai.com/v1/responses?key=gemini%26scope%3Dtwo%2B%23%25",
    );
  });

  it("rejects unknown sentinel-shaped values before guarded fetch", async () => {
    const unknown = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
    await expect(
      buildGuardedModelFetch(sentinelModel())("https://api.openai.com/v1/responses", {
        headers: { Authorization: `Bearer ${unknown}` },
      }),
    ).rejects.toThrow(
      `Secret sentinel ${unknown} is not registered in this process; refusing to send request`,
    );
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it.each(
    (
      [
        { Authorization: "Bearer plain-env-key" },
        new Headers({ Authorization: "Bearer plain-env-key" }),
        [["Authorization", "Bearer plain-env-key"]],
      ] satisfies HeadersInit[]
    ).map((headers) => ({ headers })),
  )("keeps no-sentinel request headers untouched: $headers", async ({ headers }) => {
    const init: RequestInit = { headers };
    const response = await buildGuardedModelFetch(sentinelModel())(
      "https://api.openai.com/v1/responses",
      init,
    );
    await response.text();
    expect(latestGuardedFetchParams().init).toStrictEqual(init);
  });
});
