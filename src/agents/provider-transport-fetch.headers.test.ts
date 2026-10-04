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

  it.each(["Request", "custom iterator"] as const)(
    "resolves %s header sentinels only at egress without mutating the caller",
    async (form) => {
      const secret = form === "Request" ? "request-form-secret" : "iterable-header-secret";
      const sentinel = mintSecretSentinel(secret, { label: "header-form" });
      const header = form === "Request" ? "authorization" : "x-api-key";
      const prefix = form === "Request" ? "Bearer " : "";
      const original = form === "Request" ? `${prefix}${sentinel}` : "original-value";
      const headers = new Headers({ [header]: original });
      if (form === "custom iterator") {
        headers[Symbol.iterator] = function* () {
          yield [header, sentinel];
          return undefined;
        };
      }
      const request =
        form === "Request"
          ? new Request(url, { method: "POST", headers, body: '{"stream":true}' })
          : undefined;
      await (
        await buildGuardedModelFetch(model)(request ?? url, request ? undefined : { headers })
      ).text();
      expect(egressHeaders().get(header)).toBe(`${prefix}${secret}`);
      expect(headers.get(header)).toBe(original);
      if (request) {
        expect(
          new Headers(ensureModelProviderLocalServiceMock.mock.lastCall?.[1]).get(header),
        ).toBe(original);
        expect(request.headers.get(header)).toBe(original);
        const init = fetchWithSsrFGuardMock.mock.lastCall?.[0]?.init;
        expect(init.method).toBe("POST");
        await expect(new Response(init.body).text()).resolves.toBe('{"stream":true}');
      }
    },
  );

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
