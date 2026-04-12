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

  it("ignores empty string values", () => {
    process.env.HTTPS_PROXY = "";
    process.env.HTTP_PROXY = "http://proxy:3128";

    expect(getProxyEnvDefaults()).toEqual({
      HTTP_PROXY: "http://proxy:3128",
    });
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
});
