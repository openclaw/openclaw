import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveMatrixProxyUrl } from "./proxy.js";

describe("Matrix proxy support", () => {
  describe("resolveMatrixProxyUrl", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      // Clear proxy vars (both uppercase and lowercase)
      delete process.env.MATRIX_PROXY;
      delete process.env.HTTPS_PROXY;
      delete process.env.https_proxy;
      delete process.env.HTTP_PROXY;
      delete process.env.http_proxy;
      delete process.env.ALL_PROXY;
      delete process.env.all_proxy;
    });

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("returns undefined when no proxy env vars are set", () => {
      expect(resolveMatrixProxyUrl(process.env)).toBeUndefined();
    });

    it("prefers MATRIX_PROXY over other proxy vars", () => {
      process.env.MATRIX_PROXY = "http://matrix-proxy:8080";
      process.env.HTTPS_PROXY = "http://https-proxy:8080";
      process.env.HTTP_PROXY = "http://http-proxy:8080";
      process.env.ALL_PROXY = "http://all-proxy:8080";

      expect(resolveMatrixProxyUrl(process.env)).toBe("http://matrix-proxy:8080");
    });

    it("uses HTTPS_PROXY when MATRIX_PROXY is not set", () => {
      process.env.HTTPS_PROXY = "http://https-proxy:8080";
      process.env.HTTP_PROXY = "http://http-proxy:8080";
      process.env.ALL_PROXY = "http://all-proxy:8080";

      expect(resolveMatrixProxyUrl(process.env)).toBe("http://https-proxy:8080");
    });

    it("uses HTTP_PROXY when MATRIX_PROXY and HTTPS_PROXY are not set", () => {
      process.env.HTTP_PROXY = "http://http-proxy:8080";
      process.env.ALL_PROXY = "http://all-proxy:8080";

      expect(resolveMatrixProxyUrl(process.env)).toBe("http://http-proxy:8080");
    });

    it("uses ALL_PROXY as fallback when other proxy vars are not set", () => {
      process.env.ALL_PROXY = "http://all-proxy:8080";

      expect(resolveMatrixProxyUrl(process.env)).toBe("http://all-proxy:8080");
    });

    it("trims whitespace from proxy URLs", () => {
      process.env.MATRIX_PROXY = "  http://proxy:8080  ";

      expect(resolveMatrixProxyUrl(process.env)).toBe("http://proxy:8080");
    });

    it("treats empty string as undefined", () => {
      process.env.MATRIX_PROXY = "   ";

      expect(resolveMatrixProxyUrl(process.env)).toBeUndefined();
    });

    it("treats whitespace-only strings as undefined for all vars", () => {
      process.env.MATRIX_PROXY = "  ";
      process.env.HTTPS_PROXY = "  ";
      process.env.HTTP_PROXY = "  ";
      process.env.ALL_PROXY = "  ";

      expect(resolveMatrixProxyUrl(process.env)).toBeUndefined();
    });

    it("uses lowercase https_proxy when uppercase not set", () => {
      process.env.https_proxy = "http://https-proxy:8080";

      expect(resolveMatrixProxyUrl(process.env)).toBe("http://https-proxy:8080");
    });

    it("uses lowercase http_proxy when uppercase not set", () => {
      process.env.http_proxy = "http://http-proxy:8080";

      expect(resolveMatrixProxyUrl(process.env)).toBe("http://http-proxy:8080");
    });

    it("uses lowercase all_proxy as fallback", () => {
      process.env.all_proxy = "http://all-proxy:8080";

      expect(resolveMatrixProxyUrl(process.env)).toBe("http://all-proxy:8080");
    });

    it("prefers uppercase over lowercase variants", () => {
      process.env.HTTPS_PROXY = "http://uppercase:8080";
      process.env.https_proxy = "http://lowercase:8080";

      expect(resolveMatrixProxyUrl(process.env)).toBe("http://uppercase:8080");
    });
  });
});
