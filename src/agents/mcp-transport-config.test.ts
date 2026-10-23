import { beforeEach, describe, expect, it, vi } from "vitest";
import { logWarn } from "../logger.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";

vi.mock("../logger.js", () => ({ logWarn: vi.fn() }));

const defaults = {
  connectionTimeoutMs: 30_000,
  requestTimeoutMs: 60_000,
  supportsParallelToolCalls: false,
};
const warning = (server: string, key: string) =>
  `bundle-mcp: server "${server}": env "${key}" is blocked for stdio startup safety and was ignored.`;

describe("resolveMcpTransportConfig", () => {
  beforeEach(() => {
    vi.mocked(logWarn).mockClear();
  });

  it("drops dangerous env overrides from stdio config", () => {
    const blocked = {
      NODE_OPTIONS: "--require=./evil.js",
      LD_PRELOAD: "/tmp/pwn.so",
      BASH_ENV: "/tmp/pwn.sh",
      ANSIBLE_CONFIG: "/tmp/evil-ansible.cfg",
      TF_CLI_CONFIG_FILE: "/tmp/evil-terraform.rc",
    };
    const resolved = resolveMcpTransportConfig("probe", {
      command: "node",
      env: {
        SAFE_VALUE: "ok",
        PORT: 3000,
        ENABLED: true,
        GITHUB_TOKEN: "token",
        HTTP_PROXY: "http://proxy.example",
        ...blocked,
      },
    });

    expect(resolved).toEqual({
      kind: "stdio",
      transportType: "stdio",
      command: "node",
      args: undefined,
      cwd: undefined,
      description: "node",
      ...defaults,
      env: {
        SAFE_VALUE: "ok",
        PORT: "3000",
        ENABLED: "true",
        GITHUB_TOKEN: "token",
        HTTP_PROXY: "http://proxy.example",
      },
    });
    for (const key of Object.keys(blocked)) {
      expect(logWarn).toHaveBeenCalledWith(warning("probe", key));
    }
  });

  it("warns once per blocked stdio env key and server", () => {
    const warnings = [
      ["repeat-server", "PYTHONPATH"],
      ["other-server", "PYTHONPATH"],
      ["repeat-server", "NODE_OPTIONS"],
      ["svc", "LD_A:LD_B"],
      ["svc:LD_A", "LD_B"],
    ] as const;
    for (const [server, key] of [warnings[0], warnings[0], ...warnings]) {
      expect(
        resolveMcpTransportConfig(server, { command: "node", env: { [key]: "/tmp/unsafe" } }),
      ).toEqual(expect.objectContaining({ env: {} }));
    }
    expect(logWarn).toHaveBeenCalledTimes(5);
    expect(vi.mocked(logWarn).mock.calls).toEqual(
      warnings.map(([server, key]) => [warning(server, key)]),
    );
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
      kind: "http",
      transportType: "sse",
      ...defaults,
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
