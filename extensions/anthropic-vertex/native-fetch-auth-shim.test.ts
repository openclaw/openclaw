// Tests cover the native-fetch window shim used to keep gaxios's Google auth token
// exchange on the native-fetch branch instead of a dynamic `node-fetch` import.
import { describe, expect, it } from "vitest";
import { ensureNativeFetchVisibleToGoogleAuth } from "./native-fetch-auth-shim.js";

function fakeGlobal(overrides: { fetch?: unknown; window?: { fetch: unknown } } = {}) {
  return { ...overrides } as typeof globalThis & { window?: { fetch: typeof fetch } };
}

describe("ensureNativeFetchVisibleToGoogleAuth", () => {
  it("sets a minimal window.fetch when no window exists and native fetch is available", () => {
    const nativeFetch = () => Promise.resolve("native");
    const target = fakeGlobal({ fetch: nativeFetch });

    ensureNativeFetchVisibleToGoogleAuth(target);

    expect(target.window).toBeDefined();
    expect(target.window?.fetch).toBe(nativeFetch);
  });

  it("does not add document, navigator, or crypto to the shimmed window", () => {
    const target = fakeGlobal({ fetch: () => Promise.resolve() });

    ensureNativeFetchVisibleToGoogleAuth(target);

    expect(Object.keys(target.window ?? {})).toEqual(["fetch"]);
  });

  it("does not overwrite an existing window", () => {
    const existingWindow = { fetch: () => Promise.resolve("existing") };
    const target = fakeGlobal({ fetch: () => Promise.resolve("native"), window: existingWindow });

    ensureNativeFetchVisibleToGoogleAuth(target);

    expect(target.window).toBe(existingWindow);
  });

  it("does nothing when native fetch is unavailable", () => {
    const target = fakeGlobal({});

    ensureNativeFetchVisibleToGoogleAuth(target);

    expect(target.window).toBeUndefined();
  });

  it("is idempotent across repeated calls", () => {
    const target = fakeGlobal({ fetch: () => Promise.resolve() });

    ensureNativeFetchVisibleToGoogleAuth(target);
    const firstWindow = target.window;
    ensureNativeFetchVisibleToGoogleAuth(target);

    expect(target.window).toBe(firstWindow);
  });
});
