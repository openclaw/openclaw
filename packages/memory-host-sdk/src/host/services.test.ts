import { describe, expect, it } from "vitest";
import {
  createDefaultMemoryHostServices,
  getMemoryHostServices,
  setMemoryHostServices,
  withMemoryHostServices,
  type MemoryHostServices,
} from "./services.js";

function makeServices(charCount: number): MemoryHostServices {
  const services = createDefaultMemoryHostServices();
  return {
    ...services,
    io: {
      ...services.io,
      estimateStringChars: () => charCount,
    },
  };
}

describe("MemoryHostServices", () => {
  it("returns a restore callback when overriding services", () => {
    const baseline = createDefaultMemoryHostServices();
    const restoreBaseline = setMemoryHostServices(baseline);
    try {
      const first = makeServices(11);
      const second = makeServices(22);

      const restoreFirst = setMemoryHostServices(first);
      expect(getMemoryHostServices().io.estimateStringChars("abc")).toBe(11);

      const restoreSecond = setMemoryHostServices(second);
      expect(getMemoryHostServices().io.estimateStringChars("abc")).toBe(22);

      restoreSecond();
      expect(getMemoryHostServices()).toBe(first);
      expect(getMemoryHostServices().io.estimateStringChars("abc")).toBe(11);

      restoreFirst();
      expect(getMemoryHostServices()).toBe(baseline);
    } finally {
      restoreBaseline();
    }
  });

  it("scopes service overrides across async failures", async () => {
    const baseline = createDefaultMemoryHostServices();
    const restoreBaseline = setMemoryHostServices(baseline);
    try {
      await expect(
        withMemoryHostServices(makeServices(33), async () => {
          expect(getMemoryHostServices().io.estimateStringChars("abc")).toBe(33);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(getMemoryHostServices()).toBe(baseline);
    } finally {
      restoreBaseline();
    }
  });

  it("keeps host-owned network fetch fail-closed by default", async () => {
    const services = createDefaultMemoryHostServices();

    await expect(
      services.network.fetchWithSsrFGuard({ url: "https://memory.example/v1" }),
    ).rejects.toThrow("requires a host service binding");
  });

  it("redacts likely secrets in the package default service", () => {
    const services = createDefaultMemoryHostServices();
    const secret = "OPENAI_API_KEY=sk-1234567890abcdef";

    expect(services.io.redactSensitiveText(secret)).not.toContain("sk-1234567890abcdef");
  });
});
