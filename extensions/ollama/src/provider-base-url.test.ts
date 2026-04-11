import { describe, expect, it } from "vitest";
import { readProviderBaseUrl } from "./provider-base-url.js";

describe("readProviderBaseUrl", () => {
  describe("with canonical baseUrl (lowercase)", () => {
    it("returns trimmed baseUrl when present", () => {
      expect(readProviderBaseUrl({ baseUrl: "http://localhost:11434", models: [] })).toBe(
        "http://localhost:11434",
      );
    });

    it("returns trimmed baseUrl with whitespace", () => {
      expect(readProviderBaseUrl({ baseUrl: "  http://localhost:11434  ", models: [] })).toBe(
        "http://localhost:11434",
      );
    });

    it("returns undefined for empty baseUrl", () => {
      expect(readProviderBaseUrl({ baseUrl: "", models: [] })).toBeUndefined();
      expect(readProviderBaseUrl({ baseUrl: "   ", models: [] })).toBeUndefined();
    });

    it("returns undefined when baseUrl is not a string", () => {
      expect(
        readProviderBaseUrl({ baseUrl: 123 as unknown as string, models: [] }),
      ).toBeUndefined();
      expect(
        readProviderBaseUrl({ baseUrl: null as unknown as string, models: [] }),
      ).toBeUndefined();
    });
  });

  describe("with baseURL alternate spelling (uppercase)", () => {
    it("returns trimmed baseURL when baseUrl is absent", () => {
      const provider = {
        baseURL: "http://192.168.1.100:11434",
        models: [],
      } as unknown as { baseUrl?: string; models: unknown[] };
      expect(readProviderBaseUrl(provider)).toBe("http://192.168.1.100:11434");
    });

    it("returns trimmed baseURL with whitespace", () => {
      const provider = {
        baseURL: "  http://192.168.1.100:11434  ",
        models: [],
      } as unknown as { baseUrl?: string; models: unknown[] };
      expect(readProviderBaseUrl(provider)).toBe("http://192.168.1.100:11434");
    });

    it("returns undefined for empty baseURL when baseUrl is also empty", () => {
      const provider = {
        baseUrl: "",
        baseURL: "",
        models: [],
      } as unknown as { baseUrl?: string; models: unknown[] };
      expect(readProviderBaseUrl(provider)).toBeUndefined();
    });

    it("prefers baseUrl over baseURL when both are present", () => {
      const provider = {
        baseUrl: "http://preferred:11434",
        baseURL: "http://ignored:11434",
        models: [],
      } as unknown as { baseUrl?: string; models: unknown[] };
      expect(readProviderBaseUrl(provider)).toBe("http://preferred:11434");
    });
  });

  describe("edge cases", () => {
    it("returns undefined for undefined provider", () => {
      expect(readProviderBaseUrl(undefined)).toBeUndefined();
    });

    it("returns undefined for provider without baseUrl or baseURL", () => {
      expect(readProviderBaseUrl({ models: [] })).toBeUndefined();
    });

    it("handles remote Ollama host URLs", () => {
      expect(readProviderBaseUrl({ baseUrl: "http://192.168.1.50:11434", models: [] })).toBe(
        "http://192.168.1.50:11434",
      );
      expect(
        readProviderBaseUrl({
          baseUrl: "http://ollama-server.local:11434",
          models: [],
        }),
      ).toBe("http://ollama-server.local:11434");
    });

    it("handles URLs with trailing slash", () => {
      expect(readProviderBaseUrl({ baseUrl: "http://localhost:11434/", models: [] })).toBe(
        "http://localhost:11434/",
      );
    });

    it("ignores prototype pollution for baseUrl (CWE-1321)", () => {
      const provider = { models: [] } as { baseUrl?: string; models: unknown[] };
      // Simulate prototype pollution
      Object.setPrototypeOf(provider, { baseUrl: "http://malicious:11434" });
      expect(readProviderBaseUrl(provider)).toBeUndefined();
      Object.setPrototypeOf(provider, null); // Cleanup
    });

    it("ignores prototype pollution for baseURL (CWE-1321)", () => {
      const provider = { models: [] } as unknown as { baseUrl?: string; models: unknown[] } & {
        baseURL?: string;
      };
      // Simulate prototype pollution
      Object.setPrototypeOf(provider, { baseURL: "http://malicious:11434" });
      expect(readProviderBaseUrl(provider)).toBeUndefined();
      Object.setPrototypeOf(provider, null); // Cleanup
    });
  });
});
