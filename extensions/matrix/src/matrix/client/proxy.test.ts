import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveMatrixProxyUrl } from "./proxy.js";

describe("Matrix proxy support", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("resolveMatrixProxyUrl", () => {
    it("returns undefined when no proxy env vars are set", () => {
      delete process.env.MATRIX_PROXY;
      delete process.env.HTTPS_PROXY;
      delete process.env.HTTP_PROXY;
      delete process.env.ALL_PROXY;

      expect(resolveMatrixProxyUrl(process.env)).toBeUndefined();
    });

    it("prefers MATRIX_PROXY over other proxy vars", () => {
      process.env.MATRIX_PROXY = "http://matrix-proxy:8080";
      process.env.HTTPS_PROXY = "http://https-proxy:8080";
      process.env.HTTP_PROXY = "http://http-proxy:8080";

      expect(resolveMatrixProxyUrl(process.env)).toBe("http://matrix-proxy:8080");
    });

    it("uses HTTPS_PROXY when MATRIX_PROXY is not set", () => {
      delete process.env.MATRIX_PROXY;
      process.env.HTTPS_PROXY = "http://https-proxy:8080";
      process.env.HTTP_PROXY = "http://http-proxy:8080";

      expect(resolveMatrixProxyUrl(process.env)).toBe("http://https-proxy:8080");
    });

    it("uses HTTP_PROXY when MATRIX_PROXY and HTTPS_PROXY are not set", () => {
      delete process.env.MATRIX_PROXY;
      delete process.env.HTTPS_PROXY;
      process.env.HTTP_PROXY = "http://http-proxy:8080";

      expect(resolveMatrixProxyUrl(process.env)).toBe("http://http-proxy:8080");
    });

    it("trims whitespace from proxy URLs", () => {
      process.env.MATRIX_PROXY = "  http://proxy:8080  ";

      expect(resolveMatrixProxyUrl(process.env)).toBe("http://proxy:8080");
    });

    it("treats empty string as undefined", () => {
      process.env.MATRIX_PROXY = "   ";
      delete process.env.HTTPS_PROXY;
      delete process.env.HTTP_PROXY;
      delete process.env.ALL_PROXY;

      expect(resolveMatrixProxyUrl(process.env)).toBeUndefined();
    });
  });
});
