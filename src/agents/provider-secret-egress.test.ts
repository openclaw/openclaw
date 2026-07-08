import { describe, expect, it } from "vitest";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import {
  attachModelProviderRequestTransport,
  getModelProviderRequestTransport,
} from "./provider-request-config.js";
import { unwrapModelHeaderSentinelsForProviderEgress } from "./provider-secret-egress.js";

describe("unwrapModelHeaderSentinelsForProviderEgress", () => {
  it("unwraps sentinels in visible headers and attached request transport overrides", () => {
    const headerSecret = "egress-visible-header-secret";
    const bearerSecret = "egress-runtime-bearer-secret";
    const overrideHeaderSecret = "egress-override-header-secret";
    const model = attachModelProviderRequestTransport(
      {
        id: "test-model",
        headers: {
          "x-api-key": mintSecretSentinel(headerSecret, { label: "egress-test:visible" }),
        },
      },
      {
        headers: {
          "x-extra": mintSecretSentinel(overrideHeaderSecret, { label: "egress-test:override" }),
        },
        auth: {
          mode: "authorization-bearer",
          token: mintSecretSentinel(bearerSecret, { label: "egress-test:bearer" }),
        },
      },
    );

    const unwrapped = unwrapModelHeaderSentinelsForProviderEgress(model, "egress test");

    expect(unwrapped.headers?.["x-api-key"]).toBe(headerSecret);
    const request = getModelProviderRequestTransport(unwrapped);
    expect(request?.headers?.["x-extra"]).toBe(overrideHeaderSecret);
    expect(request?.auth).toEqual({ mode: "authorization-bearer", token: bearerSecret });
    // Original model stays sentineled: unwrap must not mutate shared state.
    expect(model.headers["x-api-key"]).not.toBe(headerSecret);
    expect(getModelProviderRequestTransport(model)?.auth).not.toEqual(request?.auth);
  });

  it("unwraps header-mode auth values in attached request transport overrides", () => {
    const headerAuthSecret = "egress-header-auth-secret";
    const model = attachModelProviderRequestTransport(
      { id: "test-model", headers: undefined },
      {
        auth: {
          mode: "header",
          headerName: "x-goog-api-key",
          value: mintSecretSentinel(headerAuthSecret, { label: "egress-test:header-auth" }),
        },
      },
    );

    const request = getModelProviderRequestTransport(
      unwrapModelHeaderSentinelsForProviderEgress(model, "egress test"),
    );

    expect(request?.auth).toEqual({
      mode: "header",
      headerName: "x-goog-api-key",
      value: headerAuthSecret,
    });
  });

  it("returns the same model instance when nothing is sentineled", () => {
    const model = attachModelProviderRequestTransport(
      { id: "test-model", headers: { "x-plain": "plain-value" } },
      { auth: { mode: "provider-default" } },
    );

    expect(unwrapModelHeaderSentinelsForProviderEgress(model, "egress test")).toBe(model);
  });

  it("rejects unknown sentinel-shaped values in attached overrides", () => {
    const model = attachModelProviderRequestTransport(
      { id: "test-model", headers: undefined },
      {
        auth: {
          mode: "authorization-bearer",
          token: "oc-sent-v1-00000000000000000000dead",
        },
      },
    );

    expect(() => unwrapModelHeaderSentinelsForProviderEgress(model, "egress test")).toThrow(
      /not registered in this process/,
    );
  });
});
