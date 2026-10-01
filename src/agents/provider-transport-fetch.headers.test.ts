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

const model = makeProviderModelFixture<"openai-responses">({
  id: "fixture-model",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
});
const url = `${model.baseUrl}/responses`;
const egressHeaders = () => new Headers(fetchWithSsrFGuardMock.mock.lastCall?.[0]?.init?.headers);

describe("buildGuardedModelFetch headers", () => {
  installProviderTransportFetchTestHooks();

  it("resolves Request header sentinels only at egress while preserving the request body", async () => {
    const sentinel = mintSecretSentinel("request-form-secret", { label: "request-form" });
    const request = new Request(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${sentinel}` },
      body: '{"stream":true}',
    });
    await (await buildGuardedModelFetch(model)(request)).text();
    expect(egressHeaders().get("authorization")).toBe("Bearer request-form-secret");
    expect(
      new Headers(ensureModelProviderLocalServiceMock.mock.lastCall?.[1]).get("authorization"),
    ).toBe(`Bearer ${sentinel}`);
    expect(request.headers.get("authorization")).toBe(`Bearer ${sentinel}`);
    const init = fetchWithSsrFGuardMock.mock.lastCall?.[0]?.init;
    expect(init.method).toBe("POST");
    await expect(new Response(init.body).text()).resolves.toBe('{"stream":true}');
  });

  it("normalizes custom header iterators without mutating the caller's headers", async () => {
    const sentinel = mintSecretSentinel("iterable-header-secret", { label: "iterable-header" });
    const headers = new Headers({ "x-api-key": "original-value" });
    headers[Symbol.iterator] = function* () {
      yield ["x-api-key", sentinel];
      return undefined;
    };
    await (await buildGuardedModelFetch(model)(url, { headers })).text();
    expect(egressHeaders().get("x-api-key")).toBe("iterable-header-secret");
    expect(headers.get("x-api-key")).toBe("original-value");
  });

  it("escapes resolved query credentials without changing URL structure", async () => {
    const sentinel = mintSecretSentinel("gemini&scope=two+#%", { label: "gemini-query" });
    await (await buildGuardedModelFetch(model)(`${url}?key=${sentinel}`)).text();
    expect(latestGuardedFetchParams().url).toBe(`${url}?key=gemini%26scope%3Dtwo%2B%23%25`);
  });

  it("rejects unregistered sentinels before guarded fetch", async () => {
    const unknown = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
    await expect(
      buildGuardedModelFetch(model)(url, {
        headers: { Authorization: `Bearer ${unknown}` },
      }),
    ).rejects.toThrow(
      `Secret sentinel ${unknown} is not registered in this process; refusing to send request`,
    );
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });
});
