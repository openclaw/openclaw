// Verifies MCP transport config normalization and startup-safety filtering.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logWarn } from "../logger.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";

vi.mock("../logger.js", () => ({ logWarn: vi.fn() }));

const stdioDefaults = {
  kind: "stdio",
  transportType: "stdio",
  command: "node",
  args: undefined,
  env: undefined,
  cwd: undefined,
  description: "node",
  connectionTimeoutMs: 30_000,
  requestTimeoutMs: 60_000,
  supportsParallelToolCalls: false,
};
const httpDefaults = {
  kind: "http",
  transportType: "sse",
  headers: undefined,
  connectionTimeoutMs: 30_000,
  requestTimeoutMs: 60_000,
  supportsParallelToolCalls: false,
};

describe("resolveMcpTransportConfig", () => {
  beforeEach(() => {
    vi.mocked(logWarn).mockClear();
  });

  it("drops dangerous env overrides from stdio config", () => {
    // Stdio env is inherited executable process input. Block loader/shell hook
    // variables and child-process config pivots while preserving explicit MCP
    // credentials and ordinary scalar env values.
    const resolved = resolveMcpTransportConfig("probe", {
      command: "node",
      env: {
        SAFE_VALUE: "ok",
        PORT: 3000,
        ENABLED: true,
        GITHUB_TOKEN: "token",
        HTTP_PROXY: "http://proxy.example",
        NODE_OPTIONS: "--require=./evil.js",
        LD_PRELOAD: "/tmp/pwn.so",
        BASH_ENV: "/tmp/pwn.sh",
        ANSIBLE_CONFIG: "/tmp/evil-ansible.cfg",
        TF_CLI_CONFIG_FILE: "/tmp/evil-terraform.rc",
      },
    });

    expect(resolved).toEqual({
      ...stdioDefaults,
      env: {
        SAFE_VALUE: "ok",
        PORT: "3000",
        ENABLED: "true",
        GITHUB_TOKEN: "token",
        HTTP_PROXY: "http://proxy.example",
      },
    });
    for (const key of [
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "BASH_ENV",
      "ANSIBLE_CONFIG",
      "TF_CLI_CONFIG_FILE",
    ]) {
      expect(logWarn).toHaveBeenCalledWith(
        `bundle-mcp: server "probe": env "${key}" is blocked for stdio startup safety and was ignored.`,
      );
    }
  });

  it("warns once per blocked stdio env key and server", () => {
    const repeatedResolutions = Array.from({ length: 3 }, () =>
      resolveMcpTransportConfig("repeat-server", {
        command: "node",
        env: {
          PYTHONPATH: "/tmp/workspace",
        },
      }),
    );
    const sameKeyDifferentServer = resolveMcpTransportConfig("other-server", {
      command: "node",
      env: {
        PYTHONPATH: "/tmp/other-workspace",
      },
    });
    const sameServerDifferentKey = resolveMcpTransportConfig("repeat-server", {
      command: "node",
      env: {
        NODE_OPTIONS: "--require=./evil.js",
      },
    });
    const firstCollidingPair = resolveMcpTransportConfig("svc", {
      command: "node",
      env: {
        "LD_A:LD_B": "/tmp/workspace",
      },
    });
    const secondCollidingPair = resolveMcpTransportConfig("svc:LD_A", {
      command: "node",
      env: {
        LD_B: "/tmp/workspace",
      },
    });

    for (const resolved of [
      ...repeatedResolutions,
      sameKeyDifferentServer,
      sameServerDifferentKey,
      firstCollidingPair,
      secondCollidingPair,
    ]) {
      expect(resolved).toEqual(expect.objectContaining({ env: {} }));
    }
    expect(logWarn).toHaveBeenCalledTimes(5);
    const warnings = [
      ["repeat-server", "PYTHONPATH"],
      ["other-server", "PYTHONPATH"],
      ["repeat-server", "NODE_OPTIONS"],
      ["svc", "LD_A:LD_B"],
      ["svc:LD_A", "LD_B"],
    ];
    warnings.forEach(([server, key], index) => {
      expect(logWarn).toHaveBeenNthCalledWith(
        index + 1,
        `bundle-mcp: server "${server}": env "${key}" is blocked for stdio startup safety and was ignored.`,
      );
    });
  });

  it("sanitizes config-controlled names in stdio env warnings", () => {
    resolveMcpTransportConfig("probe\nWARN forged\u001b[31m", {
      command: "node",
      env: {
        "LD_PRELOAD\nWARN forged\u001b[31m": "/tmp/pwn.so",
      },
    });

    expect(logWarn).toHaveBeenCalledWith(
      'bundle-mcp: server "probeWARN forged": env "LD_PRELOADWARN forged" is blocked for stdio startup safety and was ignored.',
    );
  });

  it("resolves SSE config by default", () => {
    const resolved = resolveMcpTransportConfig("probe", {
      url: "https://mcp.example.com/sse",
      headers: {
        Authorization: "Bearer token",
        "X-Count": 42,
      },
    });

    expect(resolved).toEqual({
      ...httpDefaults,
      url: "https://mcp.example.com/sse",
      headers: {
        Authorization: "Bearer token",
        "X-Count": "42",
      },
      description: "https://mcp.example.com/sse",
    });
  });

  it.each([
    {
      name: "rejects non-HTTP URL schemes",
      server: { url: "ftp://mcp.example.com/tools", transport: "streamable-http" },
    },
    {
      name: "rejects http as a canonical transport",
      server: { url: "https://mcp.example.com/http", transport: "http" },
    },
  ])("$name", ({ server }) => {
    expect(resolveMcpTransportConfig("probe", server)).toBeNull();
  });
});
