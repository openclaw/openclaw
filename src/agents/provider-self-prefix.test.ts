import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetProviderSelfPrefixForTest,
  isProviderSelfPrefixed,
  registerProviderSelfPrefix,
} from "./provider-self-prefix.js";

describe("provider-self-prefix", () => {
  beforeEach(() => {
    __resetProviderSelfPrefixForTest();
  });

  afterEach(() => {
    __resetProviderSelfPrefixForTest();
  });

  it("reports false for unregistered providers", () => {
    expect(isProviderSelfPrefixed("openrouter")).toBe(false);
  });

  it("reports true once a provider has been registered", () => {
    registerProviderSelfPrefix("openrouter");
    expect(isProviderSelfPrefixed("openrouter")).toBe(true);
  });

  it("normalizes case when matching", () => {
    registerProviderSelfPrefix("OpenRouter");
    expect(isProviderSelfPrefixed("openrouter")).toBe(true);
    expect(isProviderSelfPrefixed("OPENROUTER")).toBe(true);
  });

  it("ignores empty provider ids", () => {
    registerProviderSelfPrefix("");
    expect(isProviderSelfPrefixed("")).toBe(false);
  });
});
