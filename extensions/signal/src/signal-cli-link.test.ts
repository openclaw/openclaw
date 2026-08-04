import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { linkSignalCliAccount, listSignalCliAccounts } from "./signal-cli-link.js";

const runCommandMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandWithTimeout: runCommandMock,
}));

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  termination: "exit" | "timeout" | "no-output-timeout" | "signal";
};

type CommandOptions = {
  signal: AbortSignal;
  killProcessTree: boolean;
  maxOutputBytes: { stdout: number; stderr: number };
  maxPreservedOutputLines: number;
  preserveOutputLine: (line: string, stream: "stdout" | "stderr") => boolean;
  outputCapture: { stdout: string; stderr: string };
};

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

function createDeferredCommand() {
  let resolve!: (result: CommandResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<CommandResult>((resolveResult, rejectResult) => {
    resolve = resolveResult;
    reject = rejectResult;
  });
  runCommandMock.mockReturnValueOnce(promise);
  return { resolve, reject };
}

function commandOptions(): CommandOptions {
  const options = runCommandMock.mock.calls.at(-1)?.[1] as CommandOptions | undefined;
  if (!options) {
    throw new Error("expected command options");
  }
  return options;
}

function emitStdoutLine(line: string) {
  commandOptions().preserveOutputLine(line, "stdout");
}

beforeEach(() => {
  runCommandMock.mockReset();
});

describe("listSignalCliAccounts", () => {
  it("reads the dependency-owned JSON account list", async () => {
    runCommandMock.mockResolvedValueOnce(
      commandResult({
        stdout: '[{"number":"+15555550123"},{"number":"+15555550124"}]',
      }),
    );

    await expect(
      listSignalCliAccounts({
        cliPath: "/opt/openclaw/signal-cli",
        configPath: "~/.local/share/signal-cli",
      }),
    ).resolves.toEqual({
      ok: true,
      accounts: ["+15555550123", "+15555550124"],
    });
    expect(runCommandMock).toHaveBeenCalledWith(
      [
        "/opt/openclaw/signal-cli",
        "--config",
        path.join(os.homedir(), ".local/share/signal-cli"),
        "--output",
        "json",
        "listAccounts",
      ],
      expect.objectContaining({
        killProcessTree: true,
        outputCapture: { stdout: "head", stderr: "tail" },
        terminateOnOutputLimit: { stdout: true },
      }),
    );
  });

  it("rejects failed or malformed account discovery", async () => {
    runCommandMock
      .mockResolvedValueOnce(commandResult({ code: 1, stderr: "store locked" }))
      .mockResolvedValueOnce(commandResult({ stdout: '[{"number":"not-e164"}]' }));

    await expect(listSignalCliAccounts({ cliPath: "signal-cli" })).resolves.toEqual({
      ok: false,
      error: "store locked",
    });
    await expect(listSignalCliAccounts({ cliPath: "signal-cli" })).resolves.toEqual({
      ok: false,
      error: "signal-cli returned an invalid account list.",
    });
  });
});

describe("linkSignalCliAccount", () => {
  it("does not launch signal-cli when setup is already cancelled", async () => {
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      linkSignalCliAccount({
        cliPath: "signal-cli",
        signal: abortController.signal,
        onLinkUri: vi.fn(async () => undefined),
      }),
    ).resolves.toEqual({ ok: false, error: "Signal account linking was cancelled." });
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("recognizes the upstream link result and forces plain-text output", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const command = createDeferredCommand();
    const onLinkUri = vi.fn(async () => undefined);
    const resultPromise = linkSignalCliAccount({
      cliPath: "/opt/openclaw/signal-cli",
      configPath: "~/.local/share/signal-cli",
      onLinkUri,
    });

    emitStdoutLine("sgnl://linkdevice?uuid=test&pub_key=test");
    emitStdoutLine("Associated with: +15555550123");
    command.resolve(commandResult());

    await expect(resultPromise).resolves.toEqual({
      ok: true,
      associatedAccount: "+15555550123",
    });
    expect(runCommandMock).toHaveBeenCalledWith(
      [
        "/opt/openclaw/signal-cli",
        "--config",
        path.join(os.homedir(), ".local/share/signal-cli"),
        "--output",
        "plain-text",
        "link",
        "-n",
        "OpenClaw",
      ],
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        killProcessTree: true,
        maxPreservedOutputLines: 1,
        preserveOutputLine: expect.any(Function),
      }),
    );
    expect(onLinkUri).toHaveBeenCalledWith(
      "sgnl://linkdevice?uuid=test&pub_key=test",
      expect.any(Promise),
      1_800_000_120_000,
    );
    vi.useRealTimers();
  });

  it("waits for QR presentation to finish before completing setup", async () => {
    const command = createDeferredCommand();
    let releasePresentation!: () => void;
    const presentation = new Promise<void>((resolve) => {
      releasePresentation = resolve;
    });
    const resultPromise = linkSignalCliAccount({
      cliPath: "signal-cli",
      onLinkUri: async (_uri, completion) => {
        await expect(completion).resolves.toBeUndefined();
        await presentation;
      },
    });

    emitStdoutLine("sgnl://linkdevice?uuid=test&pub_key=test");
    command.resolve(commandResult());

    let completed = false;
    void resultPromise.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    releasePresentation();
    await expect(resultPromise).resolves.toMatchObject({ ok: true });
  });

  it("preserves a successful link when QR presentation fails after process exit", async () => {
    const command = createDeferredCommand();
    const resultPromise = linkSignalCliAccount({
      cliPath: "signal-cli",
      onLinkUri: async (_uri, completion) => {
        await completion;
        throw new Error("client disconnected");
      },
    });

    emitStdoutLine("sgnl://linkdevice?uuid=test&pub_key=test");
    emitStdoutLine("Associated with: +15555550123");
    command.resolve(commandResult());

    await expect(resultPromise).resolves.toEqual({
      ok: true,
      associatedAccount: "+15555550123",
    });
  });

  it("bounds signal-cli errors and rejects success without a link URI", async () => {
    const failedCommand = createDeferredCommand();
    const failurePromise = linkSignalCliAccount({
      cliPath: "signal-cli",
      onLinkUri: vi.fn(async () => undefined),
    });
    expect(commandOptions()).toMatchObject({
      maxOutputBytes: { stdout: 8 * 1024, stderr: 2_000 },
      outputCapture: { stdout: "discard", stderr: "tail" },
    });
    failedCommand.resolve(commandResult({ code: 1, stderr: "signal-cli error" }));
    const failure = await failurePromise;
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.error).toBe("signal-cli error");
    }

    const missingUriCommand = createDeferredCommand();
    const missingUriPromise = linkSignalCliAccount({
      cliPath: "signal-cli",
      onLinkUri: vi.fn(async () => undefined),
    });
    missingUriCommand.resolve(commandResult());
    await expect(missingUriPromise).resolves.toEqual({
      ok: false,
      error: "signal-cli link finished without producing a device-link QR code.",
    });
  });

  it("terminates the signal-cli process tree when presentation fails", async () => {
    const command = createDeferredCommand();
    const presentationFailure = linkSignalCliAccount({
      cliPath: "signal-cli",
      onLinkUri: async () => {
        throw new Error("client disconnected");
      },
    });
    emitStdoutLine("sgnl://linkdevice?uuid=test&pub_key=test");
    await vi.waitFor(() => expect(commandOptions().signal.aborted).toBe(true));
    expect(commandOptions().killProcessTree).toBe(true);
    command.resolve(
      commandResult({ code: null, signal: "SIGTERM", killed: true, termination: "signal" }),
    );
    await expect(presentationFailure).resolves.toEqual({
      ok: false,
      error: "Signal account linking stopped: client disconnected",
    });
  });

  it("lets signal-cli own provisioning and post-approval deadlines", async () => {
    vi.useFakeTimers();
    const command = createDeferredCommand();
    const resultPromise = linkSignalCliAccount({
      cliPath: "signal-cli",
      onLinkUri: vi.fn(async () => undefined),
    });
    emitStdoutLine("sgnl://linkdevice?uuid=test&pub_key=test");
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(commandOptions().signal.aborted).toBe(false);
    command.resolve(commandResult());
    await expect(resultPromise).resolves.toMatchObject({ ok: true });
    vi.useRealTimers();
  });

  it("keeps cancellation owned until the whole process tree stops", async () => {
    const command = createDeferredCommand();
    const abortController = new AbortController();
    let presentationReleased = false;
    const onLinkUri = vi.fn(async (_uri: string, completion: Promise<void>) => {
      await completion;
      presentationReleased = true;
    });
    const resultPromise = linkSignalCliAccount({
      cliPath: "signal-cli",
      signal: abortController.signal,
      onLinkUri,
    });

    emitStdoutLine("sgnl://linkdevice?uuid=test&pub_key=test");
    await vi.waitFor(() => expect(onLinkUri).toHaveBeenCalledOnce());

    abortController.abort();

    expect(commandOptions().signal.aborted).toBe(true);
    expect(commandOptions().killProcessTree).toBe(true);
    await vi.waitFor(() => expect(presentationReleased).toBe(true));
    let completed = false;
    void resultPromise.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    command.resolve(
      commandResult({ code: null, signal: "SIGTERM", killed: true, termination: "signal" }),
    );
    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: "Signal account linking was cancelled.",
    });
  });

  it("rejects overlapping links until the active process has stopped", async () => {
    const firstCommand = createDeferredCommand();
    const first = linkSignalCliAccount({
      cliPath: "signal-cli",
      onLinkUri: vi.fn(async () => undefined),
    });

    await expect(
      linkSignalCliAccount({
        cliPath: "signal-cli",
        onLinkUri: vi.fn(async () => undefined),
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Signal account linking is already in progress.",
    });
    expect(runCommandMock).toHaveBeenCalledOnce();

    emitStdoutLine("sgnl://linkdevice?uuid=first&pub_key=first");
    firstCommand.resolve(commandResult());
    await expect(first).resolves.toMatchObject({ ok: true });

    const retryCommand = createDeferredCommand();
    const retry = linkSignalCliAccount({
      cliPath: "signal-cli",
      onLinkUri: vi.fn(async () => undefined),
    });
    emitStdoutLine("sgnl://linkdevice?uuid=retry&pub_key=retry");
    retryCommand.resolve(commandResult());
    await expect(retry).resolves.toMatchObject({ ok: true });
    expect(runCommandMock).toHaveBeenCalledTimes(2);
  });

  it("returns an error when signal-cli cannot start", async () => {
    const command = createDeferredCommand();
    const resultPromise = linkSignalCliAccount({
      cliPath: "/missing/signal-cli",
      onLinkUri: vi.fn(async () => undefined),
    });
    command.reject(new Error("spawn ENOENT"));

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: "Could not start signal-cli: spawn ENOENT",
    });
  });
});
