import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProxyEnvDefaults, resolveStdioMcpServerLaunchConfig } from "./mcp-stdio.js";

/**
 * Proxy env var keys that we expect to be forwarded to MCP stdio child
 * processes when set in the gateway's process.env.
 */
const ALL_PROXY_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_OPTIONS",
] as const;

describe("getProxyEnvDefaults", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ALL_PROXY_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ALL_PROXY_KEYS) {
      const prev = saved.get(key);
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  });

  it("returns empty object when no proxy vars are set", () => {
    expect(getProxyEnvDefaults()).toEqual({});
  });

  it("collects HTTPS_PROXY and HTTP_PROXY", () => {
    process.env.HTTPS_PROXY = "http://proxy:3128";
    process.env.HTTP_PROXY = "http://proxy:3128";

    expect(getProxyEnvDefaults()).toEqual({
      HTTPS_PROXY: "http://proxy:3128",
      HTTP_PROXY: "http://proxy:3128",
    });
  });

  it("collects lower-case proxy vars", () => {
    process.env.https_proxy = "http://lower:3128";

    expect(getProxyEnvDefaults()).toEqual({
      https_proxy: "http://lower:3128",
    });
  });

  it("collects NO_PROXY and NODE_OPTIONS", () => {
    process.env.NO_PROXY = "localhost,127.0.0.1";
    process.env.NODE_OPTIONS = "--require /path/to/proxy-patch.js";

    expect(getProxyEnvDefaults()).toEqual({
      NO_PROXY: "localhost,127.0.0.1",
      NODE_OPTIONS: "--require /path/to/proxy-patch.js",
    });
  });

  it("preserves empty string values (explicit proxy disable)", () => {
    process.env.HTTPS_PROXY = "";
    process.env.HTTP_PROXY = "http://proxy:3128";

    expect(getProxyEnvDefaults()).toEqual({
      HTTPS_PROXY: "",
      HTTP_PROXY: "http://proxy:3128",
    });
  });

  it("keeps empty lowercase proxy that overrides uppercase (disable proxy)", () => {
    // Gateway has uppercase proxy configured, but lowercase empty overrides it
    // to mean "no proxy". Both must be forwarded so the child's proxy resolver
    // sees the lowercase empty and skips the uppercase fallback.
    process.env.HTTPS_PROXY = "http://proxy:8080";
    process.env.https_proxy = "";

    const result = getProxyEnvDefaults();
    // Case-dedup keeps only lowercase when both are present
    expect(result).toEqual({
      https_proxy: "",
    });
    expect(result).not.toHaveProperty("HTTPS_PROXY");
  });

  it("deduplicates when both upper and lower case proxy vars are set", () => {
    process.env.HTTPS_PROXY = "http://upper:3128";
    process.env.https_proxy = "http://lower:3128";
    process.env.HTTP_PROXY = "http://upper-http:3128";
    process.env.http_proxy = "http://lower-http:3128";

    const result = getProxyEnvDefaults();
    // Only lowercase should survive when both are present (lowercase
    // takes precedence per src/infra/net/proxy-env.ts convention)
    expect(result).toEqual({
      https_proxy: "http://lower:3128",
      http_proxy: "http://lower-http:3128",
    });
    expect(result).not.toHaveProperty("HTTPS_PROXY");
    expect(result).not.toHaveProperty("HTTP_PROXY");
  });

  it("keeps lowercase when only lowercase is set", () => {
    process.env.https_proxy = "http://lower:3128";

    expect(getProxyEnvDefaults()).toEqual({
      https_proxy: "http://lower:3128",
    });
  });

  it("strips --inspect from NODE_OPTIONS", () => {
    process.env.NODE_OPTIONS = "--inspect --require /patch.js";

    expect(getProxyEnvDefaults()).toEqual({
      NODE_OPTIONS: "--require /patch.js",
    });
  });

  it("strips --inspect-brk from NODE_OPTIONS", () => {
    process.env.NODE_OPTIONS = "--inspect-brk --require /patch.js";

    expect(getProxyEnvDefaults()).toEqual({
      NODE_OPTIONS: "--require /patch.js",
    });
  });

  it("strips --inspect-port=N from NODE_OPTIONS", () => {
    process.env.NODE_OPTIONS = "--require /patch.js --inspect-port=9230";

    expect(getProxyEnvDefaults()).toEqual({
      NODE_OPTIONS: "--require /patch.js",
    });
  });

  it("strips --inspect-publish-uid=stderr from NODE_OPTIONS", () => {
    process.env.NODE_OPTIONS = "--require /patch.js --inspect-publish-uid=stderr";

    expect(getProxyEnvDefaults()).toEqual({
      NODE_OPTIONS: "--require /patch.js",
    });
  });

  it("strips all --inspect* variants from NODE_OPTIONS at once", () => {
    process.env.NODE_OPTIONS =
      "--inspect --inspect-brk --inspect-port=9230 --inspect-publish-uid=stderr --require /patch.js";

    expect(getProxyEnvDefaults()).toEqual({
      NODE_OPTIONS: "--require /patch.js",
    });
  });

  it("removes NODE_OPTIONS entirely if only inspect flags remain", () => {
    process.env.NODE_OPTIONS = "--inspect-brk";

    expect(getProxyEnvDefaults()).toEqual({});
  });
});

describe("resolveStdioMcpServerLaunchConfig — proxy env propagation", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ALL_PROXY_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ALL_PROXY_KEYS) {
      const prev = saved.get(key);
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  });

  it("propagates gateway proxy vars when user env is not configured", () => {
    process.env.HTTPS_PROXY = "http://proxy:3128";
    process.env.NODE_OPTIONS = "--require /patch.js";

    const result = resolveStdioMcpServerLaunchConfig({ command: "node", args: ["server.js"] });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.env).toEqual({
      HTTPS_PROXY: "http://proxy:3128",
      NODE_OPTIONS: "--require /patch.js",
    });
  });

  it("user-configured env overrides gateway proxy vars", () => {
    process.env.HTTPS_PROXY = "http://gateway-proxy:3128";

    const result = resolveStdioMcpServerLaunchConfig({
      command: "node",
      args: ["server.js"],
      env: { HTTPS_PROXY: "http://user-proxy:9999", CUSTOM_VAR: "value" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.env).toEqual({
      HTTPS_PROXY: "http://user-proxy:9999",
      CUSTOM_VAR: "value",
    });
  });

  it("merges gateway proxy vars with user env (user wins on conflict)", () => {
    process.env.HTTPS_PROXY = "http://gateway:3128";
    process.env.NO_PROXY = "localhost";

    const result = resolveStdioMcpServerLaunchConfig({
      command: "node",
      args: ["server.js"],
      env: { MY_TOKEN: "secret" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.env).toEqual({
      HTTPS_PROXY: "http://gateway:3128",
      NO_PROXY: "localhost",
      MY_TOKEN: "secret",
    });
  });

  it("returns undefined env when no proxy vars and no user env", () => {
    const result = resolveStdioMcpServerLaunchConfig({ command: "node", args: ["server.js"] });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.env).toBeUndefined();
  });

  it("drops uppercase default when user sets lowercase equivalent", () => {
    process.env.HTTPS_PROXY = "http://gateway:3128";

    const result = resolveStdioMcpServerLaunchConfig({
      command: "node",
      args: ["server.js"],
      env: { https_proxy: "http://user:9999" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // User's lowercase wins; gateway's uppercase default must not leak through
    expect(result.config.env).toEqual({
      https_proxy: "http://user:9999",
    });
    expect(result.config.env).not.toHaveProperty("HTTPS_PROXY");
  });

  it("drops lowercase default when user sets uppercase equivalent", () => {
    process.env.https_proxy = "http://gateway:3128";

    const result = resolveStdioMcpServerLaunchConfig({
      command: "node",
      args: ["server.js"],
      env: { HTTPS_PROXY: "http://user:9999" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.env).toEqual({
      HTTPS_PROXY: "http://user:9999",
    });
    expect(result.config.env).not.toHaveProperty("https_proxy");
  });

  it("strips --inspect-brk from propagated NODE_OPTIONS", () => {
    process.env.NODE_OPTIONS = "--inspect-brk --require /patch.js";

    const result = resolveStdioMcpServerLaunchConfig({ command: "node", args: ["server.js"] });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.env).toEqual({
      NODE_OPTIONS: "--require /patch.js",
    });
  });
});
