import {
  createPluginSetupWizardStatus,
  createTestWizardPrompter,
  runSetupWizardPrepare,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import * as setupRuntime from "openclaw/plugin-sdk/setup";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIMessageAccount } from "./accounts.js";
import { imessagePlugin } from "./channel.js";
import * as channelRuntimeModule from "./channel.runtime.js";
import * as clientModule from "./client.js";
import { probeIMessage, probeIMessagePrivateApi } from "./probe.js";
import { createIMessageSetupWizardProxy } from "./setup-core.js";
import { imessageSetupWizard } from "./setup-surface.js";

const getIMessageSetupStatus = createPluginSetupWizardStatus({
  id: "imessage",
  meta: { label: "iMessage" },
  setupWizard: imessageSetupWizard,
} as never);

const spawnMock = vi.hoisted(() => vi.fn());
const setupToolsMocks = vi.hoisted(() => ({
  detectBinary: vi.fn(async () => false),
  formatDocsLink: vi.fn((path: string) => path),
}));
const installIMessageCliMock = vi.hoisted(() => vi.fn());

const timeout = { timeoutMs: 1000 };

type CommandResult = Awaited<ReturnType<typeof processRuntime.runCommandWithTimeout>>;
type RpcClient = Awaited<ReturnType<typeof clientModule.createIMessageRpcClient>>;

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

function privateStatusResult(overrides: Record<string, unknown> = {}): Partial<CommandResult> {
  return {
    stdout: JSON.stringify({
      advanced_features: true,
      v2_ready: true,
      selectors: {},
      rpc_methods: ["chats.list"],
      ...overrides,
    }),
  };
}

function mockCommandSequence(...results: Array<Partial<CommandResult>>) {
  const runCommand = vi.spyOn(processRuntime, "runCommandWithTimeout");
  for (const result of results) {
    runCommand.mockResolvedValueOnce(commandResult(result));
  }
  return runCommand;
}

function mockRpcClient(requestResult: unknown = { chats: [] }) {
  const request = vi.fn().mockResolvedValue(requestResult);
  const stop = vi.fn().mockResolvedValue(undefined);
  const create = vi.spyOn(clientModule, "createIMessageRpcClient").mockResolvedValue({
    request,
    stop,
  } as unknown as RpcClient);
  return { create, request, stop };
}

async function getSetupStatus(accounts: Record<string, { cliPath?: string }>, cliPath?: string) {
  const imessage = { defaultAccount: "work", accounts, ...(cliPath ? { cliPath } : {}) };
  return await getIMessageSetupStatus({
    cfg: { channels: { imessage } } as never,
    accountOverrides: {},
  });
}

vi.mock("openclaw/plugin-sdk/setup-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/setup-tools")>()),
  ...setupToolsMocks,
}));

// mock-isolation: Status tests control installation outcomes without installing the native CLI.
vi.mock("./install-imsg.js", () => ({ installIMessageCli: installIMessageCliMock }));

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  }
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
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
    await expect(clientModule.createIMessageRpcClient()).rejects.toThrow(
      /Refusing to start imsg rpc in test environment/i,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("promotes Full Disk Access rpc banners to the public probe error", async () => {
    const internals = new clientModule.IMessageRpcClient() as unknown as {
      handleLine: (line: string) => void;
      buildCloseError: (code: number | null, signal: NodeJS.Signals | null) => Error;
    };

    internals.handleLine(
      "imsg cannot access /Users/alice/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
    );

    expect(internals.buildCloseError(1, null).message).toBe(
      "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
    );
  });
});

describe("imessage setup status", () => {
  const confirm = vi.fn(async () => true);
  const note = vi.fn(async () => {});
  async function prepareIMessage(
    params: {
      platform?: NodeJS.Platform;
      cliPath?: string;
      prepare?: NonNullable<typeof imessageSetupWizard.prepare>;
      allowInstall?: boolean;
    } = {},
  ) {
    return withPlatform(params.platform ?? process.platform, () =>
      runSetupWizardPrepare({
        prepare: params.prepare ?? imessageSetupWizard.prepare,
        cfg: { channels: { imessage: params.cliPath ? { cliPath: params.cliPath } : {} } },
        ...(params.allowInstall === false ? {} : { options: { allowIMessageInstall: true } }),
        prompter: createTestWizardPrompter({ confirm, note }),
      }),
    );
  }

  beforeEach(() => {
    setupToolsMocks.detectBinary.mockClear();
    installIMessageCliMock.mockReset();
    confirm.mockClear();
    note.mockClear();
  });

  it.each([
    [
      { work: { cliPath: "/tmp/work-imsg" } },
      "/tmp/root-imsg",
      "imsg: missing (/tmp/work-imsg)",
      undefined,
    ],
    [
      { default: { cliPath: "/usr/local/bin/imsg" }, work: {} },
      undefined,
      "iMessage: needs setup",
      false,
    ],
  ] as const)("resolves named default account %j", async (accounts, cliPath, line, configured) => {
    const status = await getSetupStatus(accounts, cliPath);
    expect(status.statusLines).toContain(line);
    if (configured !== undefined) {
      expect(status.configured).toBe(configured);
    }
  });

  it.each([
    [false, "/opt/homebrew/bin/imsg", "Installed imsg at /opt/homebrew/bin/imsg"],
    [true, undefined, "Using existing imsg at imsg; Homebrew does not manage this binary."],
  ] as const)("prepares imsg with detected=%s", async (detected, path, noteText) => {
    setupToolsMocks.detectBinary.mockResolvedValueOnce(detected);
    installIMessageCliMock.mockResolvedValueOnce(
      path ? { ok: true, cliPath: path, version: "0.13.0" } : { ok: true },
    );
    const result = await prepareIMessage({
      platform: "darwin",
      ...(detected
        ? {}
        : { prepare: createIMessageSetupWizardProxy(async () => imessageSetupWizard).prepare }),
    });
    if (!detected) {
      expect(confirm).toHaveBeenCalledWith({
        message: "imsg not found. Install now?",
        initialValue: true,
      });
    }
    expect(installIMessageCliMock).toHaveBeenCalledWith(expect.anything(), {
      upgrade: detected,
      cliPath: "imsg",
    });
    expect(note).toHaveBeenCalledWith(noteText, "iMessage");
    if (path) {
      expect(result).toEqual({ credentialValues: { cliPath: path } });
    } else {
      expect(result).toBeUndefined();
    }
  });

  it.each([{ platform: "darwin", cliPath: "imsg" }, { platform: "linux" }] as const)(
    "prepare skips automatic install for $platform / $cliPath",
    async (options) => {
      expect(await prepareIMessage(options)).toBeUndefined();
      expect(setupToolsMocks.detectBinary).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(installIMessageCliMock).not.toHaveBeenCalled();
    },
  );

  it("prepare skips imsg install prompts unless explicitly allowed", async () => {
    expect(await prepareIMessage({ allowInstall: false })).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    expect(installIMessageCliMock).not.toHaveBeenCalled();
  });
});

describe("probeIMessage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    spawnMock.mockClear();
    vi.spyOn(setupRuntime, "detectBinary").mockResolvedValue(true);
    vi.spyOn(processRuntime, "runCommandWithTimeout").mockResolvedValue(
      commandResult({ stderr: 'unknown command "rpc" for "imsg"', code: 1 }),
    );
  });

  it("keeps foundational RPC healthy when an older imsg lacks private status", async () => {
    const runCommand = mockCommandSequence(
      { stdout: "rpc help" },
      { stderr: "Unknown subcommand 'status' for command 'imsg'", code: 1 },
    );
    const { request, stop } = mockRpcClient();

    await expect(
      probeIMessage(1000, { cliPath: "imsg-legacy", platform: "darwin" }),
    ).resolves.toMatchObject({
      ok: true,
      privateApi: {
        available: false,
        v2Ready: false,
        selectors: {},
        rpcMethods: [],
        cliCapabilities: { sendRichSupportsAttachment: false, pollSendSupportsNoComment: false },
        error:
          'imsg CLI does not support the "status" subcommand. Update imsg on the Messages Mac: brew update && brew upgrade imsg',
      },
    });
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand).toHaveBeenNthCalledWith(2, ["imsg-legacy", "status", "--json"], timeout);
    expect(request).toHaveBeenCalledWith("chats.list", { limit: 1 }, timeout);
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each([
    [
      undefined,
      "imsg not found (imsg). Install imsg on the Messages Mac: brew install steipete/tap/imsg",
    ],
    ["imsg", "imsg command not found (imsg). Check the configured iMessage cliPath or wrapper."],
  ] as const)("explains how to fix missing imsg with cliPath %s", async (cliPath, error) => {
    vi.spyOn(setupRuntime, "detectBinary").mockResolvedValue(false);
    const { create } = mockRpcClient();
    expect(await probeIMessage(1000, { cliPath, platform: "darwin" })).toMatchObject({
      ok: false,
      error,
    });
    expect(processRuntime.runCommandWithTimeout).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("drops cached rpc support when the current clock is not a valid date timestamp", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_700_000_000_000)
      .mockReturnValueOnce(Number.NaN)
      .mockReturnValue(1_700_000_000_000);
    const runCommand = mockCommandSequence(
      { stderr: 'unknown command "rpc" for "imsg"', code: 1 },
      { stdout: "rpc help" },
      privateStatusResult(),
      { stdout: "send-rich --file" },
    );
    mockRpcClient();

    await expect(probeIMessage(1000, { cliPath: "imsg-clock" })).resolves.toMatchObject({
      ok: false,
      fatal: true,
    });
    await expect(probeIMessage(1000, { cliPath: "imsg-clock" })).resolves.toMatchObject({
      ok: true,
    });

    expect(runCommand).toHaveBeenNthCalledWith(1, ["imsg-clock", "rpc", "--help"], timeout);
    expect(runCommand).toHaveBeenNthCalledWith(2, ["imsg-clock", "rpc", "--help"], timeout);
  });

  it("propagates imsg's status message when advanced features are unavailable", async () => {
    const note =
      "System Integrity Protection (SIP) is enabled.\nAdvanced IMCore features are intentionally disabled.";
    mockCommandSequence(
      privateStatusResult({ advanced_features: false, v2_ready: false, message: note }),
      { stdout: "send-rich --help" },
    );

    await expect(probeIMessagePrivateApi("imsg-message", 1000)).resolves.toMatchObject({
      available: false,
      statusMessage: note,
    });
  });

  it("does not infer poll caption suppression from selectors when the flag is absent", async () => {
    mockCommandSequence(
      privateStatusResult({ selectors: { pollPayloadMessage: true } }),
      { stdout: "send-rich --file" },
      { stdout: "poll send --question <text> --option <text>" },
    );

    await expect(probeIMessagePrivateApi("imsg-no-caption", 1000)).resolves.toMatchObject({
      available: true,
      selectors: { pollPayloadMessage: true },
      cliCapabilities: { pollSendSupportsNoComment: false },
    });
  });

  it("fails fast for default local imsg probes on non-mac hosts", async () => {
    const { create } = mockRpcClient();

    const result = await probeIMessage(1000, { cliPath: "imsg", platform: "linux" });

    expect(result).toMatchObject({ ok: false, fatal: true });
    expect(result.error).toMatch(/macOS/i);
    expect(result.error).toMatch(/SSH wrapper/i);
    expect(setupRuntime.detectBinary).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("status probe uses account-scoped cliPath and dbPath", async () => {
    const probeSpy = vi
      .spyOn(channelRuntimeModule, "probeIMessageAccount")
      .mockResolvedValue({ ok: true });
    const work = { cliPath: "imsg-work", dbPath: "/tmp/work-db", remoteHost: "work@messages-mac" };

    const cfg = {
      channels: { imessage: { cliPath: "imsg-root", dbPath: "/tmp/root-db", accounts: { work } } },
    } as const;
    const account = resolveIMessageAccount({ cfg, accountId: "work" });

    await imessagePlugin.status!.probeAccount!({ account, cfg, timeoutMs: 2500 });

    expect(probeSpy).toHaveBeenCalledWith({ timeoutMs: 2500, ...work });
  });
});
