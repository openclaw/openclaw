import { expect, it, vi } from "vitest";
import * as host from "./model-auth-runtime-shared.js";

it("recognizes canonical auth instances across duplicated SDK modules without rewrapping", async () => {
  vi.resetModules();
  const plugin = await import("./model-auth-runtime-shared.js");
  expect(plugin.ProviderAuthError).not.toBe(host.ProviderAuthError);
  const providerError = new plugin.ProviderAuthError(
    "missing-provider-auth",
    "fixture",
    "Missing auth",
  );
  const missingKey = new plugin.MissingProviderAuthError("fixture", {
    mode: "api-key",
    source: "fixture",
  });
  expect(providerError).not.toBeInstanceOf(host.ProviderAuthError);
  expect(host.isProviderAuthError(providerError, "missing-provider-auth")).toBe(true);
  expect(host.isProviderAuthError(providerError, "missing-api-key")).toBe(false);
  expect(host.isMissingProviderAuthError(providerError)).toBe(false);
  expect(host.isProviderAuthError(missingKey, "missing-api-key")).toBe(true);
  expect(host.isMissingProviderAuthError(missingKey)).toBe(true);
  expect(missingKey).toMatchObject({
    name: "MissingProviderAuthError",
    mode: "api-key",
    source: "fixture",
  });
  const hostError = new host.ProviderAuthError("missing-provider-auth", "fixture", "Host auth");
  expect(plugin.isProviderAuthError(hostError)).toBe(true);
});

it("rejects structural lookalikes, including errors with copied names and codes", () => {
  for (const error of [
    null,
    undefined,
    "missing-provider-auth",
    {},
    Object.assign(new Error("Missing auth"), {
      name: "ProviderAuthError",
      code: "missing-provider-auth",
      provider: "fixture",
      providerGuidance: false,
    }),
    Object.assign(new Error("Missing key"), {
      name: "MissingProviderAuthError",
      code: "missing-api-key",
      provider: "fixture",
      mode: "api-key",
      source: "fixture",
    }),
  ]) {
    expect(host.isProviderAuthError(error)).toBe(false);
    expect(host.isMissingProviderAuthError(error)).toBe(false);
  }
});
