import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import "./test-helpers/fast-core-tools.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { callGatewayTool } from "./tools/gateway.js";

const { callGatewayToolMock, readGatewayCallOptionsMock, configState } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(),
  readGatewayCallOptionsMock: vi.fn(() => ({})),
  configState: { value: {} as Record<string, unknown> },
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configState.value as ReturnType<typeof actual.loadConfig>,
  };
});

vi.mock("./tools/gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools/gateway.js")>();
  return {
    ...actual,
    callGatewayTool: callGatewayToolMock,
    readGatewayCallOptions: readGatewayCallOptionsMock,
  };
});

function requireGatewayTool(agentSessionKey?: string) {
  return createGatewayTool({
    ...(agentSessionKey ? { agentSessionKey } : {}),
    config: { commands: { restart: true } },
  });
}

function expectConfigMutationCall(params: {
  callGatewayTool: {
    mock: {
      calls: Array<readonly unknown[]>;
    };
  };
  action: "config.apply" | "config.patch";
  raw: string;
  sessionKey: string;
}) {
  expect(params.callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
  expect(params.callGatewayTool).toHaveBeenCalledWith(
    params.action,
    expect.any(Object),
    expect.objectContaining({
      raw: params.raw.trim(),
      baseHash: "hash-1",
      sessionKey: params.sessionKey,
    }),
  );
}

describe("gateway tool", () => {
  beforeEach(() => {
    callGatewayToolMock.mockClear();
    readGatewayCallOptionsMock.mockClear();
    configState.value = {};
    callGatewayToolMock.mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            tools: {
              exec: {
                ask: "on-miss",
                security: "allowlist",
              },
            },
          },
        };
      }
      if (method === "config.schema.lookup") {
        return {
          path: "gateway.auth",
          schema: {
            type: "object",
          },
          hint: { label: "Gateway Auth" },
          hintPath: "gateway.auth",
          children: [
            {
              key: "token",
              path: "gateway.auth.token",
              type: "string",
              required: true,
              hasChildren: false,
              hint: { label: "Token", sensitive: true },
              hintPath: "gateway.auth.token",
            },
          ],
        };
      }
      return { ok: true };
    });
  });

  it("marks gateway as owner-only", async () => {
    const tool = requireGatewayTool();
    expect(tool.ownerOnly).toBe(true);
  });

  it("schedules SIGUSR1 restart", async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));

    try {
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_PROFILE: "isolated" },
        async () => {
          const tool = requireGatewayTool();

          const result = await tool.execute("call1", {
            action: "restart",
            delayMs: 0,
          });
          expect(result.details).toMatchObject({
            ok: true,
            pid: process.pid,
            signal: "SIGUSR1",
            delayMs: 0,
          });

          const sentinelPath = path.join(stateDir, "restart-sentinel.json");
          const raw = await fs.readFile(sentinelPath, "utf-8");
          const parsed = JSON.parse(raw) as {
            payload?: { kind?: string; doctorHint?: string | null };
          };
          expect(parsed.payload?.kind).toBe("restart");
          expect(parsed.payload?.doctorHint).toBe(
            "Run: openclaw --profile isolated doctor --non-interactive",
          );

          expect(kill).not.toHaveBeenCalled();
          await vi.runAllTimersAsync();
          expect(kill).toHaveBeenCalledWith(process.pid, "SIGUSR1");
        },
      );
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes config.apply through gateway call", async () => {
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);

    const raw =
      '{\n  agents: { defaults: { workspace: "~/openclaw" } },\n  tools: { exec: { ask: "on-miss", security: "allowlist" } }\n}\n';
    await tool.execute("call2", {
      action: "config.apply",
      raw,
    });

    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.apply",
      raw,
      sessionKey,
    });
  });

  it("passes config.patch through gateway call", async () => {
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);

    const raw = '{\n  channels: { telegram: { groups: { "*": { requireMention: false } } } }\n}\n';
    await tool.execute("call4", {
      action: "config.patch",
      raw,
    });

    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.patch",
      raw,
      sessionKey,
    });
  });

  it("rejects config.patch when it changes exec approval settings", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-patch", {
        action: "config.patch",
        raw: '{ tools: { exec: { ask: "off" } } }',
      }),
    ).rejects.toThrow("gateway config.patch cannot change protected config paths: tools.exec.ask");
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when it changes safe bin approval paths", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-safe-bins-patch", {
        action: "config.patch",
        raw: '{ tools: { exec: { safeBins: ["bash"], safeBinProfiles: { bash: { allowedValueFlags: ["-c"] } } } } }',
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: tools.exec.safeBins, tools.exec.safeBinProfiles",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("passes config.patch through gateway call when protected exec arrays and objects are unchanged", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            tools: {
              exec: {
                ask: "on-miss",
                security: "allowlist",
                safeBins: ["bash"],
                safeBinProfiles: {
                  bash: {
                    allowedValueFlags: ["-c"],
                  },
                },
                safeBinTrustedDirs: ["/tmp/openclaw-bin"],
                strictInlineEval: true,
              },
            },
          },
        };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool("agent:main:whatsapp:dm:+15555550123");

    const raw = `{
      tools: {
        exec: {
          safeBins: ["bash"],
          safeBinProfiles: {
            bash: {
              allowedValueFlags: ["-c"],
            },
          },
          safeBinTrustedDirs: ["/tmp/openclaw-bin"],
          strictInlineEval: true,
        },
      },
    }`;
    await tool.execute("call-same-protected-patch", {
      action: "config.patch",
      raw,
    });

    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.patch",
      raw,
      sessionKey: "agent:main:whatsapp:dm:+15555550123",
    });
  });

  it("rejects config.patch when it enables unsafe external content for gmail hooks", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-dangerous-hook-patch", {
        action: "config.patch",
        raw: "{ hooks: { gmail: { allowUnsafeExternalContent: true } } }",
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot enable dangerous config flags: hooks.gmail.allowUnsafeExternalContent=true",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("allows config.patch when it explicitly keeps a dangerous hook flag disabled", async () => {
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);
    const raw = "{ hooks: { gmail: { allowUnsafeExternalContent: false } } }";

    await tool.execute("call-safe-hook-patch", {
      action: "config.patch",
      raw,
    });

    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.patch",
      raw,
      sessionKey,
    });
  });

  it("rejects config.patch when it weakens workspace-only apply_patch restrictions", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-dangerous-apply-patch", {
        action: "config.patch",
        raw: "{ tools: { exec: { applyPatch: { workspaceOnly: false } } } }",
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot enable dangerous config flags: tools.exec.applyPatch.workspaceOnly=false",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when it changes strict inline eval directly", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1", config: {} };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-inline-eval-direct", {
        action: "config.patch",
        raw: "{ tools: { exec: { strictInlineEval: false } } }",
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: tools.exec.strictInlineEval",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when a legacy tools.bash alias changes strict inline eval", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1", config: {} };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-legacy-protected-inline-eval", {
        action: "config.patch",
        raw: "{ tools: { bash: { strictInlineEval: false } } }",
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: tools.exec.strictInlineEval",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when it disables control ui device auth", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-dangerous-device-auth", {
        action: "config.patch",
        raw: "{ gateway: { controlUi: { dangerouslyDisableDeviceAuth: true } } }",
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot enable dangerous config flags: gateway.controlUi.dangerouslyDisableDeviceAuth=true",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when it enables approve-all plugin permission mode", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-dangerous-plugin-permissions", {
        action: "config.patch",
        raw: '{ plugins: { entries: { acpx: { config: { permissionMode: "approve-all" } } } } }',
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot enable dangerous config flags: plugins.entries.acpx.config.permissionMode=approve-all",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when it activates a disabled plugin with dangerous config", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            plugins: {
              entries: {
                acpx: {
                  enabled: false,
                  config: {
                    permissionMode: "approve-all",
                  },
                },
              },
            },
            tools: { exec: { ask: "on-miss", security: "allowlist" } },
          },
        };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-enable-dangerous-plugin", {
        action: "config.patch",
        raw: "{ plugins: { entries: { acpx: { enabled: true } } } }",
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot enable dangerous config flags: plugins.entries.acpx.config.permissionMode=approve-all",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when it globally re-enables plugins with dangerous config", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            plugins: {
              enabled: false,
              entries: {
                acpx: {
                  config: {
                    permissionMode: "approve-all",
                  },
                },
              },
            },
            tools: { exec: { ask: "on-miss", security: "allowlist" } },
          },
        };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-enable-dangerous-plugins-globally", {
        action: "config.patch",
        raw: "{ plugins: { enabled: true } }",
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot enable dangerous config flags: plugins.entries.acpx.config.permissionMode=approve-all",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects remote config.patch when it changes plugin config", async () => {
    readGatewayCallOptionsMock.mockReturnValueOnce({ gatewayUrl: "wss://gateway.example" });
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-remote-plugin-config", {
        action: "config.patch",
        gatewayUrl: "wss://gateway.example",
        raw: '{ plugins: { entries: { acpx: { config: { permissionMode: "allow" } } } } }',
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change plugin config on remote gateways because dangerous plugin flags are host-specific",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects plugin config writes when remote mode uses a loopback tunnel", async () => {
    // Guard reads live config at assertion time, not captured opts — set configState instead.
    configState.value = { gateway: { mode: "remote", remote: { url: "ws://127.0.0.1:18789" } } };
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-remote-tunnel-plugin-config", {
        action: "config.patch",
        raw: '{ plugins: { entries: { acpx: { config: { permissionMode: "allow" } } } } }',
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change plugin config on remote gateways because dangerous plugin flags are host-specific",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects plugin config writes when remote mode uses a loopback gatewayUrl override", async () => {
    readGatewayCallOptionsMock.mockReturnValueOnce({ gatewayUrl: "ws://127.0.0.1:18789" });
    configState.value = { gateway: { mode: "remote", remote: { url: "wss://gateway.example" } } };
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-remote-loopback-override-plugin-config", {
        action: "config.patch",
        gatewayUrl: "ws://127.0.0.1:18789",
        raw: '{ plugins: { entries: { acpx: { config: { permissionMode: "allow" } } } } }',
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change plugin config on remote gateways because dangerous plugin flags are host-specific",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects tunneled remote config.patch when it changes plugin config", async () => {
    readGatewayCallOptionsMock.mockReturnValueOnce({ gatewayUrl: "ws://127.0.0.1:18789" });
    configState.value = { gateway: { mode: "remote", remote: { url: "ws://127.0.0.1:18789" } } };
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-tunneled-remote-plugin-config", {
        action: "config.patch",
        gatewayUrl: "ws://127.0.0.1:18789",
        raw: '{ plugins: { entries: { acpx: { config: { permissionMode: "allow" } } } } }',
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change plugin config on remote gateways because dangerous plugin flags are host-specific",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects remote-mode config.patch when it changes plugin config without a gatewayUrl override", async () => {
    configState.value = { gateway: { mode: "remote", remote: { url: "wss://gateway.example" } } };
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-configured-remote-plugin-config", {
        action: "config.patch",
        raw: '{ plugins: { entries: { acpx: { config: { permissionMode: "allow" } } } } }',
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change plugin config on remote gateways because dangerous plugin flags are host-specific",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when a legacy tools.bash alias changes exec security", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1", config: {} };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-legacy-protected-patch", {
        action: "config.patch",
        raw: '{ tools: { bash: { security: "full" } } }',
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: tools.exec.security",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when a legacy tools.bash alias weakens workspace-only apply_patch restrictions", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1", config: {} };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-legacy-dangerous-apply-patch", {
        action: "config.patch",
        raw: "{ tools: { bash: { applyPatch: { workspaceOnly: false } } } }",
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot enable dangerous config flags: tools.exec.applyPatch.workspaceOnly=false",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.apply when it changes exec security settings", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-apply", {
        action: "config.apply",
        raw: '{ tools: { exec: { ask: "on-miss", security: "full" } } }',
      }),
    ).rejects.toThrow(
      "gateway config.apply cannot change protected config paths: tools.exec.security",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.apply when protected exec settings are omitted", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-missing-protected", {
        action: "config.apply",
        raw: '{ agents: { defaults: { workspace: "~/openclaw" } } }',
      }),
    ).rejects.toThrow(
      "gateway config.apply cannot change protected config paths: tools.exec.ask, tools.exec.security",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.apply when it changes safe bin trusted directories", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-safe-bin-trust-apply", {
        action: "config.apply",
        raw: '{ tools: { exec: { ask: "on-miss", security: "allowlist", safeBinTrustedDirs: ["/tmp/openclaw-bin"] } } }',
      }),
    ).rejects.toThrow(
      "gateway config.apply cannot change protected config paths: tools.exec.safeBinTrustedDirs",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.apply when a dangerous hook mapping is swapped for a new identity", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            hooks: {
              mappings: [
                {
                  id: "gmail-a",
                  allowUnsafeExternalContent: true,
                },
              ],
            },
            tools: { exec: { ask: "on-miss", security: "allowlist" } },
          },
        };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-swap-dangerous-mapping", {
        action: "config.apply",
        raw: `{
          hooks: { mappings: [{ id: "evil-new", allowUnsafeExternalContent: true }] },
          tools: { exec: { ask: "on-miss", security: "allowlist" } }
        }`,
      }),
    ).rejects.toThrow(
      "gateway config.apply cannot enable dangerous config flags: hooks.mappings[0].allowUnsafeExternalContent=true",
    );
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.apply when an id-less dangerous hook mapping is swapped for a different mapping at the same index", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            hooks: {
              // No `id` field — index-only legacy mapping
              mappings: [{ channel: "original-channel", allowUnsafeExternalContent: true }],
            },
            tools: { exec: { ask: "on-miss", security: "allowlist" } },
          },
        };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-swap-idless-dangerous-mapping", {
        action: "config.apply",
        raw: `{
          hooks: { mappings: [{ channel: "different-channel", allowUnsafeExternalContent: true }] },
          tools: { exec: { ask: "on-miss", security: "allowlist" } }
        }`,
      }),
    ).rejects.toThrow(
      "gateway config.apply cannot enable dangerous config flags: hooks.mappings[0].allowUnsafeExternalContent=true",
    );
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("allows config.apply when the legacy tools.bash alias is canonicalized to tools.exec", async () => {
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            tools: {
              bash: { applyPatch: { workspaceOnly: false } },
              exec: { ask: "on-miss", security: "allowlist" },
            },
          },
        };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool(sessionKey);
    const raw = `{
      tools: { exec: { applyPatch: { workspaceOnly: false }, ask: "on-miss", security: "allowlist" } }
    }`;

    await tool.execute("call-legacy-canonicalize", {
      action: "config.apply",
      raw,
    });

    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.apply",
      raw,
      sessionKey,
    });
  });
  it("allows config.apply when dangerous hook mappings are only reordered", async () => {
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            hooks: {
              mappings: [
                {
                  id: "gmail-a",
                  allowUnsafeExternalContent: true,
                },
              ],
            },
            tools: {
              exec: {
                ask: "on-miss",
                security: "allowlist",
              },
            },
          },
        };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool(sessionKey);
    const raw = `{
      hooks: {
        mappings: [
          { id: "safe-new" },
          { id: "gmail-a", allowUnsafeExternalContent: true }
        ]
      },
      tools: { exec: { ask: "on-miss", security: "allowlist" } }
    }`;

    await tool.execute("call-reordered-dangerous-mapping", {
      action: "config.apply",
      raw,
    });

    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.apply",
      raw,
      sessionKey,
    });
  });

  it("allows config.apply when a dangerous legacy hook mapping only gains an id", async () => {
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            hooks: {
              mappings: [
                {
                  channel: "gmail",
                  allowUnsafeExternalContent: true,
                },
              ],
            },
            tools: {
              exec: {
                ask: "on-miss",
                security: "allowlist",
              },
            },
          },
        };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool(sessionKey);
    const raw = `{
      hooks: {
        mappings: [
          { id: "gmail-a", channel: "gmail", allowUnsafeExternalContent: true }
        ]
      },
      tools: { exec: { ask: "on-miss", security: "allowlist" } }
    }`;

    await tool.execute("call-legacy-mapping-add-id", {
      action: "config.apply",
      raw,
    });

    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.apply",
      raw,
      sessionKey,
    });
  });

  it("allows config.apply when an id-less dangerous hook mapping only changes non-routing fields", async () => {
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            hooks: {
              mappings: [
                {
                  channel: "gmail",
                  allowUnsafeExternalContent: true,
                  textTemplate: "old template",
                },
              ],
            },
            tools: {
              exec: {
                ask: "on-miss",
                security: "allowlist",
              },
            },
          },
        };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool(sessionKey);
    const raw = `{
      hooks: {
        mappings: [
          {
            channel: "gmail",
            allowUnsafeExternalContent: true,
            textTemplate: "updated template"
          }
        ]
      },
      tools: { exec: { ask: "on-miss", security: "allowlist" } }
    }`;

    await tool.execute("call-legacy-mapping-safe-edit", {
      action: "config.apply",
      raw,
    });

    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.apply",
      raw,
      sessionKey,
    });
  });

  it("passes update.run through gateway call", async () => {
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);

    await tool.execute("call3", {
      action: "update.run",
      note: "test update",
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "update.run",
      expect.any(Object),
      expect.objectContaining({
        note: "test update",
        sessionKey,
      }),
    );
    const updateCall = vi
      .mocked(callGatewayTool)
      .mock.calls.find((call) => call[0] === "update.run");
    expect(updateCall).toBeDefined();
    if (updateCall) {
      const [, opts, params] = updateCall;
      expect(opts).toMatchObject({ timeoutMs: 20 * 60_000 });
      expect(params).toMatchObject({ timeoutMs: 20 * 60_000 });
    }
  });

  it("returns a path-scoped schema lookup result", async () => {
    const tool = requireGatewayTool();

    const result = await tool.execute("call5", {
      action: "config.schema.lookup",
      path: "gateway.auth",
    });

    expect(callGatewayTool).toHaveBeenCalledWith("config.schema.lookup", expect.any(Object), {
      path: "gateway.auth",
    });
    expect(result.details).toMatchObject({
      ok: true,
      result: {
        path: "gateway.auth",
        hintPath: "gateway.auth",
        children: [
          expect.objectContaining({
            key: "token",
            path: "gateway.auth.token",
            required: true,
            hintPath: "gateway.auth.token",
          }),
        ],
      },
    });
    const schema = (result.details as { result?: { schema?: { properties?: unknown } } }).result
      ?.schema;
    expect(schema?.properties).toBeUndefined();
  });
});
