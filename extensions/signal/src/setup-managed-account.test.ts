import os from "node:os";
import path from "node:path";
import { createQueuedWizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  linkSignalCliAccount: vi.fn(
    async (params: {
      abortSignal?: AbortSignal;
      onLinkUri: (uri: string, completion: Promise<{ ok: boolean }>) => Promise<void>;
    }) => {
      await params.onLinkUri(
        "sgnl://linkdevice?uuid=test&pub_key=test",
        Promise.resolve({ ok: true }),
      );
      return { ok: true as const, associatedAccount: "+15555550123" };
    },
  ),
  renderQrPngBase64: vi.fn(async () => "c2lnbmFsLXFy"),
  renderQrTerminal: vi.fn(async () => "terminal QR"),
  runPluginCommandWithTimeout: vi
    .fn()
    .mockResolvedValueOnce({ code: 0, stdout: "[]", stderr: "" })
    .mockResolvedValueOnce({
      code: 0,
      stdout: '[{"number":"+15555550123"}]',
      stderr: "",
    }),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  renderQrPngBase64: mocks.renderQrPngBase64,
  renderQrTerminal: mocks.renderQrTerminal,
}));

vi.mock("openclaw/plugin-sdk/run-command", () => ({
  runPluginCommandWithTimeout: mocks.runPluginCommandWithTimeout,
}));

vi.mock("./signal-cli-link.js", () => ({
  linkSignalCliAccount: mocks.linkSignalCliAccount,
}));

import { resolveManagedSignalAccount } from "./setup-managed-account.js";

describe("resolveManagedSignalAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runPluginCommandWithTimeout
      .mockReset()
      .mockResolvedValueOnce({ code: 0, stdout: "[]", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: '[{"number":"+15555550123"}]',
        stderr: "",
      });
  });

  it("uses a PNG QR image when the wizard client supports it", async () => {
    const queued = createQueuedWizardPrompter({ selectValues: ["link"] });
    const abortController = new AbortController();
    const effectOrder: string[] = [];
    const qrCode = vi.fn(async () => {
      effectOrder.push("confirmed");
      return true;
    });
    const beforePersistentEffect = vi.fn(async () => {
      effectOrder.push("locked");
    });

    await expect(
      resolveManagedSignalAccount({
        transport: {
          kind: "managed-native",
          baseUrl: "http://127.0.0.1:8080",
          cliPath: "/opt/openclaw/signal-cli",
          configPath: "~/.local/share/signal-cli",
          httpHost: "127.0.0.1",
          httpPort: 8080,
          startupTimeoutMs: 30_000,
        },
        selectionMode: "choose",
        prompter: { ...queued.prompter, qrCode },
        beforePersistentEffect,
        abortSignal: abortController.signal,
      }),
    ).resolves.toEqual({ account: "+15555550123", linked: true });

    expect(mocks.renderQrPngBase64).toHaveBeenCalledWith(
      "sgnl://linkdevice?uuid=test&pub_key=test",
    );
    expect(mocks.runPluginCommandWithTimeout).toHaveBeenNthCalledWith(1, {
      argv: [
        "/opt/openclaw/signal-cli",
        "--config",
        path.join(os.homedir(), ".local/share/signal-cli"),
        "--output",
        "json",
        "listAccounts",
      ],
      timeoutMs: 10_000,
    });
    expect(qrCode).toHaveBeenCalledWith({
      title: "Signal account linking",
      message: expect.stringContaining("Signal > Settings > Linked devices"),
      pngBase64: "c2lnbmFsLXFy",
      dismissWhen: expect.any(Promise),
    });
    expect(effectOrder).toEqual(["locked", "confirmed"]);
    expect(mocks.linkSignalCliAccount).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: abortController.signal }),
    );
    expect(mocks.renderQrTerminal).not.toHaveBeenCalled();
  });

  it("lets a configured account switch to another linked local account", async () => {
    mocks.runPluginCommandWithTimeout.mockReset().mockResolvedValue({
      code: 0,
      stdout: '[{"number":"+15555550123"},{"number":"+15555550124"}]',
      stderr: "",
    });
    const queued = createQueuedWizardPrompter({
      selectValues: ["account:+15555550123"],
    });

    await expect(
      resolveManagedSignalAccount({
        transport: {
          kind: "managed-native",
          baseUrl: "http://127.0.0.1:8080",
          cliPath: "/opt/openclaw/signal-cli",
          configPath: "/var/lib/signal-cli",
          httpHost: "127.0.0.1",
          httpPort: 8080,
          startupTimeoutMs: 30_000,
        },
        configuredAccount: "+15555550124",
        selectionMode: "reuse-only-account",
        prompter: queued.prompter,
      }),
    ).resolves.toEqual({ account: "+15555550123", linked: true });

    expect(queued.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Choose the linked Signal account for OpenClaw",
        initialValue: "account:+15555550124",
      }),
    );
  });

  it("stops after a declined remote linking QR", async () => {
    const queued = createQueuedWizardPrompter({ selectValues: ["link"] });
    const effectOrder: string[] = [];
    const beforePersistentEffect = vi.fn(async () => {
      effectOrder.push("locked");
    });

    await expect(
      resolveManagedSignalAccount({
        transport: {
          kind: "managed-native",
          baseUrl: "http://127.0.0.1:8080",
          cliPath: "/opt/openclaw/signal-cli",
          configPath: "/var/lib/signal-cli",
          httpHost: "127.0.0.1",
          httpPort: 8080,
          startupTimeoutMs: 30_000,
        },
        selectionMode: "choose",
        prompter: {
          ...queued.prompter,
          qrCode: async () => {
            effectOrder.push("shown");
            return false;
          },
        },
        beforePersistentEffect,
      }),
    ).rejects.toThrow("Signal account linking was not confirmed");

    expect(effectOrder).toEqual(["locked", "shown"]);
  });

  it("does not finish linking when the user continues before signal-cli completes", async () => {
    let complete!: (result: { ok: boolean }) => void;
    const completion = new Promise<{ ok: boolean }>((resolve) => {
      complete = resolve;
    });
    mocks.linkSignalCliAccount.mockImplementationOnce(async (params) => {
      await params.onLinkUri("sgnl://linkdevice?uuid=test&pub_key=test", completion);
      return { ok: true as const, associatedAccount: "+15555550123" };
    });
    const queued = createQueuedWizardPrompter({ selectValues: ["link"] });
    const qrCode = vi.fn(async () => true);

    const resolution = resolveManagedSignalAccount({
      transport: {
        kind: "managed-native",
        baseUrl: "http://127.0.0.1:8080",
        cliPath: "/opt/openclaw/signal-cli",
        configPath: "/var/lib/signal-cli",
        httpHost: "127.0.0.1",
        httpPort: 8080,
        startupTimeoutMs: 30_000,
      },
      selectionMode: "choose",
      prompter: { ...queued.prompter, qrCode },
    });
    let resolved = false;
    void resolution.then(() => {
      resolved = true;
    });

    await vi.waitFor(() => expect(qrCode).toHaveBeenCalledOnce());
    await Promise.resolve();
    const resolvedBeforeCompletion = resolved;
    complete({ ok: true });

    await expect(resolution).resolves.toEqual({ account: "+15555550123", linked: true });
    expect(resolvedBeforeCompletion).toBe(false);
  });

  it("waits for user acknowledgement after signal-cli finishes", async () => {
    const queued = createQueuedWizardPrompter({ selectValues: ["link"] });
    let confirm!: (confirmed: boolean) => void;
    const confirmation = new Promise<boolean>((resolve) => {
      confirm = resolve;
    });
    const qrCode = vi.fn(async () => await confirmation);

    const resolution = resolveManagedSignalAccount({
      transport: {
        kind: "managed-native",
        baseUrl: "http://127.0.0.1:8080",
        cliPath: "/opt/openclaw/signal-cli",
        configPath: "/var/lib/signal-cli",
        httpHost: "127.0.0.1",
        httpPort: 8080,
        startupTimeoutMs: 30_000,
      },
      selectionMode: "choose",
      prompter: { ...queued.prompter, qrCode },
    });
    let resolved = false;
    void resolution.then(() => {
      resolved = true;
    });

    await vi.waitFor(() => expect(qrCode).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(resolved).toBe(false);
    confirm(true);
    await expect(resolution).resolves.toEqual({ account: "+15555550123", linked: true });
    expect(qrCode).toHaveBeenCalledOnce();
  });

  it("stops a remote wizard before starting a link it cannot display", async () => {
    const queued = createQueuedWizardPrompter();

    await expect(
      resolveManagedSignalAccount({
        transport: {
          kind: "managed-native",
          baseUrl: "http://127.0.0.1:8080",
          cliPath: "/opt/openclaw/signal-cli",
          configPath: "/var/lib/signal-cli",
          httpHost: "127.0.0.1",
          httpPort: 8080,
          startupTimeoutMs: 30_000,
        },
        selectionMode: "choose",
        prompter: queued.prompter,
        remoteWizard: true,
      }),
    ).rejects.toThrow("cannot display the Signal linking QR code");

    expect(mocks.linkSignalCliAccount).not.toHaveBeenCalled();
    expect(queued.note).not.toHaveBeenCalled();
  });
});
