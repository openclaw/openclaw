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

  // The bug the next three tests guard against: registration used `key.trim()`
  // only, but runtime lookups go through `model.provider` which normalizeProviderId
  // canonicalizes (lowercased, alias-mapped). The mismatch silently disabled retry
  // for any provider whose config-key form differed from its model-time form.
  describe("provider id canonicalization", () => {
    it("registers and looks up case-insensitively", () => {
      registerProviderRetryConfig("OpenAI", { attempts: 1 });
      expect(getProviderRetryRunner("openai")).toBeDefined();
      expect(getProviderRetryRunner("OPENAI")).toBeDefined();
      expect(getProviderRetryRunner("OpenAI")).toBeDefined();
    });

    it("registration via an alias resolves at lookup-time", () => {
      // `z.ai` and `z-ai` both canonicalize to `zai` per provider-id.ts
      registerProviderRetryConfig("z.ai", { attempts: 1 });
      expect(getProviderRetryRunner("zai")).toBeDefined();
      expect(getProviderRetryRunner("z-ai")).toBeDefined();
    });

    it("registration via an alias matches lookup via the canonical form", () => {
      // `modelstudio` and `qwencloud` both canonicalize to `qwen`
      registerProviderRetryConfig("modelstudio", { attempts: 1 });
      expect(getProviderRetryRunner("qwen")).toBeDefined();
      expect(getProviderRetryRunner("qwencloud")).toBeDefined();
    });

    it("trims whitespace consistently with normalization", () => {
      registerProviderRetryConfig("  vllm  ", { attempts: 1 });
      expect(getProviderRetryRunner("vllm")).toBeDefined();
      expect(getProviderRetryRunner("VLLM")).toBeDefined();
    });
  });
});
