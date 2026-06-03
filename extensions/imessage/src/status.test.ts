import { createPluginSetupWizardStatus } from "openclaw/plugin-sdk/plugin-test-runtime";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import * as setupRuntime from "openclaw/plugin-sdk/setup";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIMessageAccount } from "./accounts.js";
import * as channelRuntimeModule from "./channel.runtime.js";
import * as clientModule from "./client.js";
import { probeIMessage } from "./probe.js";
import { imessageSetupWizard } from "./setup-surface.js";
import { probeIMessageStatusAccount } from "./status-core.js";

const getIMessageSetupStatus = createPluginSetupWizardStatus({
  id: "imessage",
  meta: {
    label: "iMessage",
  },
  setupWizard: imessageSetupWizard,
} as never);

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

describe("createIMessageRpcClient", () => {
  beforeEach(() => {
    spawnMock.mockClear();
    vi.stubEnv("VITEST", "true");
  });

  it("refuses to spawn imsg rpc in test environments", async () => {
    const { createIMessageRpcClient } = await import("./client.js");
    await expect(createIMessageRpcClient()).rejects.toThrow(
      /Refusing to start imsg rpc in test environment/i,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("promotes Full Disk Access rpc banners to the public probe error", async () => {
    const { IMessageRpcClient, PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR } =
      await import("./client.js");
    const client = new IMessageRpcClient();
    const internals = client as unknown as {
      handleLine: (line: string) => void;
      buildCloseError: (code: number | null, signal: NodeJS.Signals | null) => Error;
    };

    internals.handleLine(
      "imsg cannot access /Users/alice/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
    );

    expect(internals.buildCloseError(1, null).message).toBe(PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR);
  });

  it("handleLine parses valid JSON-RPC containing raw U+2028 (LINE SEPARATOR) — #89830", async () => {
    // #89830: When a JSON-RPC response contains raw U+2028 inside a string,
    // node:readline splits the line before handleLine ever sees it.
    // Our LF-only (\n) splitter (IMessageRpcClient.start()) passes the
    // complete line through, so handleLine must parse it correctly.
    // This test verifies the end-to-end path: a single \n-delimited line
    // containing U+2028 reaches handleLine intact and parses as valid JSON.
    const { IMessageRpcClient } = await import("./client.js");

    const runtimeErrors: string[] = [];
    const client = new IMessageRpcClient({
      runtime: { error: (msg: string) => runtimeErrors.push(msg) } as never,
    });

    const internals = client as unknown as {
      handleLine: (line: string) => void;
    };

    // Valid JSON-RPC response with raw U+2028 inside a message text field
    const jsonWithU2028 =
      '{"jsonrpc":"2.0","id":42,"result":{"messages":[{"text":"Line one Line two"}]}}';

    internals.handleLine(jsonWithU2028);

    // Must not emit parse errors
    expect(runtimeErrors).toHaveLength(0);
  });

  it("handleLine rejects a U+2028-split fragment — proves the old readline bug (#89830)", async () => {
    // This is the failure mode before the fix: node:readline splits a valid
    // JSON-RPC response on U+2028, producing N fragments. Each fragment
    // is NOT valid JSON and fails JSON.parse. This test confirms handleLine
    // correctly rejects fragments (the error path) — the fix ensures these
    // fragments are never produced in the first place.
    const { IMessageRpcClient } = await import("./client.js");

    const runtimeErrors: string[] = [];
    const client = new IMessageRpcClient({
      runtime: { error: (msg: string) => runtimeErrors.push(msg) } as never,
    });

    const internals = client as unknown as {
      handleLine: (line: string) => void;
    };

    // Fragment produced by readline splitting on U+2028 — missing closing brace
    const fragment = '{"jsonrpc":"2.0","id":42,"result":{"messages":[{"text":"Line one';

    internals.handleLine(fragment);

    expect(runtimeErrors).toHaveLength(1);
    expect(runtimeErrors[0]).toContain("imsg rpc: failed to parse");
  });
});

describe("imessage setup status", () => {
  it("does not inherit configured state from a sibling account", async () => {
    const result = await getIMessageSetupStatus({
      cfg: {
        channels: {
          imessage: {
            accounts: {
              default: {
                cliPath: "/usr/local/bin/imsg",
              },
              work: {},
            },
          },
        },
      },
      accountOverrides: {
        imessage: "work",
      },
    });

    expect(result.configured).toBe(false);
    expect(result.statusLines).toContain("iMessage: needs setup");
  });

  it("uses configured defaultAccount for omitted setup status cliPath", async () => {
    const status = await getIMessageSetupStatus({
      cfg: {
        channels: {
          imessage: {
            cliPath: "/tmp/root-imsg",
            defaultAccount: "work",
            accounts: {
              work: {
                cliPath: "/tmp/work-imsg",
              },
            },
          },
        },
      } as never,
      accountOverrides: {},
    });

    expect(status.statusLines).toContain("imsg: missing (/tmp/work-imsg)");
  });

  it("does not inherit configured state from a sibling when defaultAccount is named", async () => {
    const status = await getIMessageSetupStatus({
      cfg: {
        channels: {
          imessage: {
            defaultAccount: "work",
            accounts: {
              default: {
                cliPath: "/usr/local/bin/imsg",
              },
              work: {},
            },
          },
        },
      } as never,
      accountOverrides: {},
    });

    expect(status.configured).toBe(false);
    expect(status.statusLines).toContain("iMessage: needs setup");
  });

  it("setup status lines use the selected account cliPath", async () => {
    const status = await getIMessageSetupStatus({
      cfg: {
        channels: {
          imessage: {
            cliPath: "/tmp/root-imsg",
            accounts: {
              work: {
                cliPath: "/tmp/work-imsg",
              },
            },
          },
        },
      } as never,
      accountOverrides: { imessage: "work" },
    });

    expect(status.statusLines).toContain("imsg: missing (/tmp/work-imsg)");
  });
});

describe("probeIMessage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    spawnMock.mockClear();
    vi.spyOn(setupRuntime, "detectBinary").mockResolvedValue(true);
    vi.spyOn(processRuntime, "runCommandWithTimeout").mockResolvedValue({
      stdout: "",
      stderr: 'unknown command "rpc" for "imsg"',
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    });
  });

  it("marks unknown rpc subcommand as fatal", async () => {
    const createIMessageRpcClientMock = vi
      .spyOn(clientModule, "createIMessageRpcClient")
      .mockResolvedValue({
        request: vi.fn(),
        stop: vi.fn(),
      } as unknown as Awaited<ReturnType<typeof clientModule.createIMessageRpcClient>>);
    const result = await probeIMessage(1000, { cliPath: "imsg-test-rpc" });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.error).toMatch(/rpc/i);
    expect(createIMessageRpcClientMock).not.toHaveBeenCalled();
  });

  it("fails fast for default local imsg probes on non-mac hosts", async () => {
    const createIMessageRpcClientMock = vi
      .spyOn(clientModule, "createIMessageRpcClient")
      .mockResolvedValue({
        request: vi.fn(),
        stop: vi.fn(),
      } as unknown as Awaited<ReturnType<typeof clientModule.createIMessageRpcClient>>);

    const result = await probeIMessage(1000, { cliPath: "imsg", platform: "linux" });

    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.error).toMatch(/macOS/i);
    expect(result.error).toMatch(/SSH wrapper/i);
    expect(setupRuntime.detectBinary).not.toHaveBeenCalled();
    expect(createIMessageRpcClientMock).not.toHaveBeenCalled();
  });

  it("status probe uses account-scoped cliPath and dbPath", async () => {
    const probeSpy = vi.spyOn(channelRuntimeModule, "probeIMessageAccount").mockResolvedValue({
      ok: true,
      cliPath: "imsg-work",
      dbPath: "/tmp/work-db",
    } as Awaited<ReturnType<typeof channelRuntimeModule.probeIMessageAccount>>);

    const cfg = {
      channels: {
        imessage: {
          cliPath: "imsg-root",
          dbPath: "/tmp/root-db",
          accounts: {
            work: {
              cliPath: "imsg-work",
              dbPath: "/tmp/work-db",
            },
          },
        },
      },
    } as const;
    const account = resolveIMessageAccount({ cfg, accountId: "work" });

    await probeIMessageStatusAccount({
      account,
      timeoutMs: 2500,
      probeIMessageAccount: channelRuntimeModule.probeIMessageAccount,
    });

    expect(probeSpy).toHaveBeenCalledWith({
      timeoutMs: 2500,
      cliPath: "imsg-work",
      dbPath: "/tmp/work-db",
    });
  });
});
