import { getGlobalDispatcher } from "undici";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveMatrixProxyUrl,
  configureMatrixProxy,
  isMatrixProxyConfigured,
  resetProxyStateForTesting,
} from "./proxy.js";

describe("Matrix proxy support", () => {
  const originalEnv = { ...process.env };
  const proxyKeys = [
    "MATRIX_PROXY",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
  ] as const;

  beforeEach(() => {
    resetProxyStateForTesting();
    for (const key of proxyKeys) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of proxyKeys) {
      if (Object.prototype.hasOwnProperty.call(originalEnv, key)) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
    resetProxyStateForTesting();
  });

  describe("resolveMatrixProxyUrl", () => {
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

    it("uses lowercase proxy vars", () => {
      process.env.https_proxy = "http://https-proxy:8080";
      expect(resolveMatrixProxyUrl(process.env)).toBe("http://https-proxy:8080");

      delete process.env.https_proxy;
      process.env.http_proxy = "http://http-proxy:8080";
      expect(resolveMatrixProxyUrl(process.env)).toBe("http://http-proxy:8080");

      delete process.env.http_proxy;
      process.env.all_proxy = "http://all-proxy:8080";
      expect(resolveMatrixProxyUrl(process.env)).toBe("http://all-proxy:8080");
    });
  });

  describe("configureMatrixProxy", () => {
    it("returns false when no proxy env vars are set", () => {
      expect(configureMatrixProxy(process.env)).toBe(false);
      expect(isMatrixProxyConfigured()).toBe(false);
    });

    it("configures proxy when MATRIX_PROXY is set", () => {
      process.env.MATRIX_PROXY = "http://matrix-proxy:8080";

      expect(configureMatrixProxy(process.env)).toBe(true);
      expect(isMatrixProxyConfigured()).toBe(true);
    });

    it("restores initial global dispatcher on reset", () => {
      const initial = getGlobalDispatcher();
      process.env.MATRIX_PROXY = "http://matrix-proxy:8080";

      expect(configureMatrixProxy(process.env)).toBe(true);
      expect(getGlobalDispatcher()).not.toBe(initial);

      resetProxyStateForTesting();
      expect(getGlobalDispatcher()).toBe(initial);
    });
  });
});
