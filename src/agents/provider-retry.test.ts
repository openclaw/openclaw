import { afterEach, describe, expect, it } from "vitest";
import {
  clearProviderRetryRunners,
  getProviderRetryRunner,
  registerProviderRetryConfig,
} from "./provider-retry.js";

describe("provider retry registry", () => {
  afterEach(() => {
    clearProviderRetryRunners();
  });

  it("returns undefined for unregistered provider", () => {
    expect(getProviderRetryRunner("unknown")).toBeUndefined();
  });

  it("returns a runner after registration", () => {
    registerProviderRetryConfig("vllm", { attempts: 5 });
    const runner = getProviderRetryRunner("vllm");
    expect(runner).toBeDefined();
    expect(typeof runner).toBe("function");
  });

  it("runner retries transient errors", async () => {
    registerProviderRetryConfig("vllm", {
      attempts: 3,
      minDelayMs: 0,
      maxDelayMs: 0,
      jitter: 0,
    });
    const runner = getProviderRetryRunner("vllm")!;
    let attempts = 0;
    const result = await runner(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("connect ECONNREFUSED");
      }
      return "success";
    }, "test");
    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  it("clearProviderRetryRunners removes all entries", () => {
    registerProviderRetryConfig("a", { attempts: 1 });
    registerProviderRetryConfig("b", { attempts: 1 });
    expect(getProviderRetryRunner("a")).toBeDefined();
    clearProviderRetryRunners();
    expect(getProviderRetryRunner("a")).toBeUndefined();
    expect(getProviderRetryRunner("b")).toBeUndefined();
  });
});
