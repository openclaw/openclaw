import { buildExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
// Signal tests cover core plugin behavior.
import {
  createMessageReceiptFromOutboundResults,
  verifyChannelMessageAdapterCapabilityProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as fetchRuntime from "openclaw/plugin-sdk/fetch-runtime";
import {
  createPluginSetupWizardConfigure,
  createPluginSetupWizardStatus,
  createQueuedWizardPrompter,
  runSetupWizardConfigure,
  runSetupWizardPrepare,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSignalAccount } from "./accounts.js";
import {
  clearSignalApprovalReactionTargetsForTest,
  resolveSignalApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";
import { signalPlugin } from "./channel.js";
import * as clientModule from "./client-adapter.js";
import { SignalRpcRequestError } from "./client.js";
import { classifySignalCliLogLine } from "./daemon.js";
import {
  looksLikeUuid,
  normalizeSignalAllowRecipient,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender,
} from "./identity.js";
import { probeSignal } from "./probe.js";
import {
  clearSignalReplyAuthorsForTest,
  registerSignalReplyContext,
  resolveSignalReplyContextWithPersistence,
} from "./reply-authors.js";
import { clearSignalRuntime } from "./runtime.js";
import {
  createSignalCliPathTextInput,
  normalizeSignalAccountInput,
  parseSignalAllowFromEntries,
  prepareSignalSetupWizard,
  setSignalSetupServerProbeForTest,
  signalDmPolicy,
  signalSetupAdapter,
} from "./setup-core.js";

const { execFileAsyncMock, execFileMock, installSignalCliMock } = vi.hoisted(() => {
  const hoistedExecFileAsyncMock = vi.fn();
  const hoistedExecFileMock = vi.fn();
  (hoistedExecFileMock as unknown as Record<symbol, typeof hoistedExecFileAsyncMock>)[
    Symbol.for("nodejs.util.promisify.custom")
  ] = hoistedExecFileAsyncMock;
  return {
    execFileAsyncMock: hoistedExecFileAsyncMock,
    execFileMock: hoistedExecFileMock,
    installSignalCliMock: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("./install-signal-cli.js", () => ({
  installSignalCli: installSignalCliMock,
}));

const getSignalSetupStatus = createPluginSetupWizardStatus(signalPlugin);
const configureSignalSetup = createPluginSetupWizardConfigure(signalPlugin);

afterEach(() => {
  vi.restoreAllMocks();
  setSignalSetupServerProbeForTest(undefined);
  execFileAsyncMock.mockReset();
  execFileMock.mockReset();
  installSignalCliMock.mockReset();
});

describe("looksLikeUuid", () => {
  it("accepts hyphenated UUIDs", () => {
    expect(looksLikeUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
  });

  it("accepts compact UUIDs", () => {
    expect(looksLikeUuid("123e4567e89b12d3a456426614174000")).toBe(true); // pragma: allowlist secret
  });

  it("accepts uuid-like hex values with letters", () => {
    expect(looksLikeUuid("abcd-1234")).toBe(true);
  });

  it("rejects numeric ids and phone-like values", () => {
    expect(looksLikeUuid("1234567890")).toBe(false);
    expect(looksLikeUuid("+15555551212")).toBe(false);
  });
});

describe("signal sender identity", () => {
  it("prefers sourceNumber over sourceUuid", () => {
    const sender = resolveSignalSender({
      sourceNumber: " +15550001111 ",
      sourceUuid: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(sender).toEqual({
      kind: "phone",
      raw: "+15550001111",
      e164: "+15550001111",
    });
  });

  it("uses sourceUuid when sourceNumber is missing", () => {
    const sender = resolveSignalSender({
      sourceUuid: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(sender).toEqual({
      kind: "uuid",
      raw: "123e4567-e89b-12d3-a456-426614174000",
    });
  });

  it("falls back to sourceUuid when sourceNumber has no digits", () => {
    const sender = resolveSignalSender({
      sourceNumber: "not a phone number",
      sourceUuid: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(sender).toEqual({
      kind: "uuid",
      raw: "123e4567-e89b-12d3-a456-426614174000",
    });
  });

  it("normalizes noisy allowlist numbers and rejects digit-free entries", () => {
    expect(normalizeSignalAllowRecipient("signal:++1 (555) 000-1111")).toBe("+15550001111");
    expect(normalizeSignalAllowRecipient("signal:not a phone number")).toBeUndefined();
  });

  it("maps uuid senders to recipient and peer ids", () => {
    const sender = { kind: "uuid", raw: "123e4567-e89b-12d3-a456-426614174000" } as const;
    expect(resolveSignalRecipient(sender)).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(resolveSignalPeerId(sender)).toBe("uuid:123e4567-e89b-12d3-a456-426614174000");
  });
});

describe("probeSignal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockSingleAccountNativeRpc(version = "0.13.22") {
    return vi
      .spyOn(clientModule, "signalRpcRequest")
      .mockResolvedValueOnce({ version })
      .mockRejectedValueOnce(new SignalRpcRequestError(-32601, "Method not implemented"));
  }

  it("forwards named-account transport config through the status probe", async () => {
    clearSignalRuntime();
    const signalCheck = vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValueOnce({
      mode: "native",
      check: { ok: true, status: 200, error: null },
    });
    const signalRpcRequest = mockSingleAccountNativeRpc();

    const params = {
      cfg: {} as never,
      account: {
        accountId: "work",
        enabled: true,
        configured: true,
        baseUrl: "http://127.0.0.1:8080",
        config: { account: "+15555550123", apiMode: "native" },
      } as never,
      timeoutMs: 1000,
    };

    const result = await signalPlugin.status!.probeAccount!(params);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      error: null,
      version: "0.13.22",
      readiness: "ready",
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(signalCheck).toHaveBeenCalledWith("http://127.0.0.1:8080", 1000, {
      account: "+15555550123",
      apiMode: "native",
      requireReceive: false,
    });
    expect(signalRpcRequest).toHaveBeenCalledWith("version", undefined, {
      baseUrl: "http://127.0.0.1:8080",
      timeoutMs: 1000,
      apiMode: "native",
    });
    expect(signalRpcRequest).toHaveBeenCalledWith("listAccounts", undefined, {
      baseUrl: "http://127.0.0.1:8080",
      timeoutMs: 1000,
      apiMode: "native",
    });
  });

  it("extracts version from {version} result", async () => {
    vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValueOnce({
      mode: "native",
      check: { ok: true, status: 200, error: null },
    });
    mockSingleAccountNativeRpc();

    const res = await probeSignal("http://127.0.0.1:8080", 1000, {
      account: "+15555550123",
    });

    expect(res.ok).toBe(true);
    expect(res.version).toBe("0.13.22");
    expect(res.status).toBe(200);
    expect(res.readiness).toBe("ready");
  });

  it("does not hard-fail native probes on finite receive readiness", async () => {
    const signalCheck = vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValueOnce({
      mode: "native",
      check: { ok: true, status: 200, error: null },
    });
    const signalRpcRequest = mockSingleAccountNativeRpc();

    const res = await probeSignal("http://127.0.0.1:8080", 1000, {
      account: "+15555550123",
      apiMode: "auto",
    });

    expect(res.ok).toBe(true);
    expect(res.version).toBe("0.13.22");
    expect(res.readiness).toBe("ready");
    expect(signalCheck).toHaveBeenCalledWith("http://127.0.0.1:8080", 1000, {
      account: "+15555550123",
      apiMode: "auto",
      requireReceive: false,
    });
    expect(signalRpcRequest).toHaveBeenCalledWith("version", undefined, {
      baseUrl: "http://127.0.0.1:8080",
      timeoutMs: 1000,
      apiMode: "native",
    });
  });

  it("still requires receive readiness for auto-detected container probes", async () => {
    const initialCheck = vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValueOnce({
      mode: "container",
      check: { ok: true, status: 200, error: null },
    });
    const receiveCheck = vi.spyOn(clientModule, "signalCheck").mockResolvedValueOnce({
      ok: false,
      status: 200,
      error: "Signal container receive endpoint did not upgrade to WebSocket (HTTP 200)",
    });
    vi.spyOn(clientModule, "signalRpcRequest").mockResolvedValueOnce({ version: "0.13.22" });

    const res = await probeSignal("http://127.0.0.1:8080", 1000, {
      account: "+15555550123",
      apiMode: "auto",
    });

    expect(res.ok).toBe(false);
    expect(res.version).toBe("0.13.22");
    expect(res.readiness).toBe("receive_unavailable");
    expect(initialCheck).toHaveBeenCalledWith("http://127.0.0.1:8080", 1000, {
      account: "+15555550123",
      apiMode: "auto",
      requireReceive: false,
    });
    expect(receiveCheck).toHaveBeenCalledWith("http://127.0.0.1:8080", 1000, {
      account: "+15555550123",
      apiMode: "container",
      requireReceive: true,
    });
  });

  it("returns ok=false when /check fails", async () => {
    vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValueOnce({
      mode: "native",
      check: { ok: false, status: 503, error: "HTTP 503" },
    });

    const res = await probeSignal("http://127.0.0.1:8080", 1000, {
      account: "+15555550123",
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.version).toBe(null);
    expect(res.readiness).toBe("unreachable");
  });

  it("reports accountless native RPC failures as unreachable", async () => {
    vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValueOnce({
      mode: "native",
      check: { ok: true, status: 200, error: null },
    });
    vi.spyOn(clientModule, "signalRpcRequest").mockRejectedValueOnce(new Error("RPC unavailable"));

    const res = await probeSignal("http://127.0.0.1:8080", 1000, {
      apiMode: "native",
    });

    expect(res).toMatchObject({
      ok: false,
      status: 200,
      error: "RPC unavailable",
      readiness: "unreachable",
    });
  });

  it("reports accountful native RPC failures as unreachable", async () => {
    vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValueOnce({
      mode: "native",
      check: { ok: true, status: 200, error: null },
    });
    vi.spyOn(clientModule, "signalRpcRequest").mockRejectedValueOnce(new Error("RPC unavailable"));

    const res = await probeSignal("http://127.0.0.1:8080", 1000, {
      account: "+15555550123",
      apiMode: "native",
    });

    expect(res).toMatchObject({
      ok: false,
      status: 200,
      error: "RPC unavailable",
      readiness: "unreachable",
    });
  });

  it("reports missing account after probing transport reachability", async () => {
    const signalCheck = vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValueOnce({
      mode: "container",
      check: { ok: true, status: 200, error: null },
    });
    const signalRpcRequest = vi
      .spyOn(clientModule, "signalRpcRequest")
      .mockResolvedValueOnce({ version: "0.13.22" });

    const res = await probeSignal("http://127.0.0.1:8080", 1000, {
      apiMode: "container",
    });

    expect(res.ok).toBe(false);
    expect(res.readiness).toBe("account_missing");
    expect(res.error).toBe("Signal account is not configured");
    expect(res.version).toBe("0.13.22");
    expect(signalCheck).toHaveBeenCalledWith("http://127.0.0.1:8080", 1000, {
      account: undefined,
      apiMode: "container",
      requireReceive: false,
    });
    expect(signalRpcRequest).toHaveBeenCalledWith("version", undefined, {
      apiMode: "container",
      baseUrl: "http://127.0.0.1:8080",
      timeoutMs: 1000,
    });
  });

  it("reports native transport-only probes as ready without an account", async () => {
    const signalCheck = vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValueOnce({
      mode: "native",
      check: { ok: true, status: 200, error: null },
    });
    mockSingleAccountNativeRpc();

    const res = await probeSignal("http://127.0.0.1:8080", 1000, {
      apiMode: "auto",
    });

    expect(res.ok).toBe(true);
    expect(res.readiness).toBe("ready");
    expect(res.error).toBeNull();
    expect(res.version).toBe("0.13.22");
    expect(signalCheck).toHaveBeenCalledWith("http://127.0.0.1:8080", 1000, {
      account: undefined,
      apiMode: "auto",
      requireReceive: false,
    });
  });

  it("requires an account for a multi-account native daemon", async () => {
    vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValueOnce({
      mode: "native",
      check: { ok: true, status: 200, error: null },
    });
    vi.spyOn(clientModule, "signalRpcRequest")
      .mockResolvedValueOnce({ version: "0.13.22" })
      .mockResolvedValueOnce([{ number: "+15555550123" }, { number: "+15555550999" }]);

    const res = await probeSignal("http://127.0.0.1:8080", 1000, { apiMode: "native" });

    expect(res).toMatchObject({
      ok: false,
      status: 200,
      readiness: "account_missing",
      error: "Signal native daemon serves multiple accounts; configure a Signal phone number",
      version: "0.13.22",
    });
  });

  it("rejects an account that a multi-account native daemon does not serve", async () => {
    vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValueOnce({
      mode: "native",
      check: { ok: true, status: 200, error: null },
    });
    vi.spyOn(clientModule, "signalRpcRequest")
      .mockResolvedValueOnce({ version: "0.13.22" })
      .mockResolvedValueOnce([{ number: "+15555550999" }]);

    const res = await probeSignal("http://127.0.0.1:8080", 1000, {
      account: "+15555550123",
      apiMode: "native",
    });

    expect(res).toMatchObject({
      ok: false,
      status: 200,
      readiness: "account_missing",
      error: "Signal native daemon does not list +15555550123",
      version: "0.13.22",
    });
  });

  it("accepts an account that a multi-account native daemon serves", async () => {
    vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValueOnce({
      mode: "native",
      check: { ok: true, status: 200, error: null },
    });
    vi.spyOn(clientModule, "signalRpcRequest")
      .mockResolvedValueOnce({ version: "0.13.22" })
      .mockResolvedValueOnce([{ number: "+15555550123" }]);

    const res = await probeSignal("http://127.0.0.1:8080", 1000, {
      account: "+15555550123",
      apiMode: "native",
    });

    expect(res).toMatchObject({
      ok: true,
      status: 200,
      readiness: "ready",
      version: "0.13.22",
    });
  });

  it("reports container receive failures separately from unreachable transport", async () => {
    vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValueOnce({
      mode: "container",
      check: {
        ok: false,
        status: 200,
        error: "Signal container receive endpoint did not upgrade to WebSocket (HTTP 200)",
      },
    });

    const res = await probeSignal("http://127.0.0.1:8080", 1000, {
      account: "+15555550123",
      apiMode: "container",
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(200);
    expect(res.readiness).toBe("receive_unavailable");
  });

  it("does not report a container probe ready when the account is not linked", async () => {
    vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValueOnce({
      mode: "container",
      check: { ok: true, status: 101, error: null },
    });
    vi.spyOn(clientModule, "signalRpcRequest").mockResolvedValueOnce({ version: "0.13.22" });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(["+15555550999"]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.spyOn(fetchRuntime, "resolveFetch").mockReturnValue(fetchImpl as unknown as typeof fetch);

    const res = await probeSignal("http://signal-cli:8080", 1000, {
      account: "+15555550123",
      apiMode: "container",
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://signal-cli:8080/v1/accounts", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(101);
    expect(res.version).toBe("0.13.22");
    expect(res.readiness).toBe("account_missing");
    expect(res.error).toContain("Signal container does not list +15555550123");
  });

  it("reports linked-account lookup failures as unreachable", async () => {
    vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValueOnce({
      mode: "container",
      check: { ok: true, status: 101, error: null },
    });
    vi.spyOn(clientModule, "signalRpcRequest").mockResolvedValueOnce({ version: "0.13.22" });
    vi.spyOn(fetchRuntime, "resolveFetch").mockReturnValue(
      vi.fn(async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch,
    );

    const res = await probeSignal("http://signal-cli:8080", 1000, {
      account: "+15555550123",
      apiMode: "container",
    });

    expect(res.ok).toBe(false);
    expect(res.readiness).toBe("unreachable");
    expect(res.error).toContain("Signal accounts check failed");
  });

  it("reports a container probe ready when the account is linked", async () => {
    vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValueOnce({
      mode: "container",
      check: { ok: true, status: 101, error: null },
    });
    vi.spyOn(clientModule, "signalRpcRequest").mockResolvedValueOnce({ version: "0.13.22" });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(["+15555550123"]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.spyOn(fetchRuntime, "resolveFetch").mockReturnValue(fetchImpl as unknown as typeof fetch);

    const res = await probeSignal("http://signal-cli:8080", 1000, {
      account: "+15555550123",
      apiMode: "container",
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://signal-cli:8080/v1/accounts", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(101);
    expect(res.version).toBe("0.13.22");
    expect(res.readiness).toBe("ready");
  });

  it("lets generic probe wrapper failures fall back to generic capability output", () => {
    const lines = signalPlugin.status!.formatCapabilitiesProbe!({
      probe: { ok: false, error: "probe timed out after 30000ms" } as never,
    });

    expect(lines).toEqual([]);
  });

  it("setup status lines use the selected account cliPath", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            cliPath: "/tmp/root-signal-cli",
            accounts: {
              work: {
                cliPath: "/tmp/work-signal-cli",
              },
            },
          },
        },
      } as never,
      accountOverrides: { signal: "work" },
    });

    expect(status.statusLines).toContain("signal-cli: missing (/tmp/work-signal-cli)");
  });

  it("setup status does not require local signal-cli for existing server transport", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            enabled: true,
            account: "+15555550123",
            httpUrl: "http://signal-cli:8080",
            autoStart: false,
            apiMode: "container",
          },
        },
      } as OpenClawConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
    expect(status.quickstartScore).toBe(1);
    expect(status.statusLines).toContain("Signal transport: existing Signal server");
    expect(status.statusLines.some((line) => line.includes("signal-cli: missing"))).toBe(false);
  });

  it("keeps an accountless external native daemon configured", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            enabled: true,
            httpUrl: "http://127.0.0.1:8080",
            autoStart: false,
          },
        },
      } as OpenClawConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
    expect(status.quickstartScore).toBe(1);
    expect(status.statusLines).toContain("Signal: configured");
    expect(status.statusLines).toContain("Signal transport: existing Signal server");
  });

  it("keeps endpoint-only Signal setup incomplete until an account is configured", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            enabled: true,
            httpUrl: "http://signal-cli:8080",
            autoStart: false,
            apiMode: "container",
          },
        },
      } as OpenClawConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(false);
    expect(status.quickstartScore).toBe(0);
    expect(status.statusLines).toContain("Signal: needs setup");
    expect(status.statusLines).toContain("Signal transport: existing Signal server");
    expect(status.statusLines.some((line) => line.includes("signal-cli: missing"))).toBe(false);
  });

  it("setup status uses the configured default account for external transport", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            defaultAccount: "work",
            accounts: {
              work: {
                account: "+15555550123",
                httpUrl: "http://signal-cli:8080",
                autoStart: false,
              },
            },
          },
        },
      } as OpenClawConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
    expect(status.quickstartScore).toBe(1);
    expect(status.statusLines).toContain("Signal transport: existing Signal server");
    expect(status.statusLines.some((line) => line.includes("signal-cli: missing"))).toBe(false);
  });

  it("setup status uses configured defaultAccount for omitted cliPath lookup", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            cliPath: "/tmp/root-signal-cli",
            defaultAccount: "work",
            accounts: {
              work: {
                cliPath: "/tmp/work-signal-cli",
              },
            },
          },
        },
      } as never,
      accountOverrides: {},
    });

    expect(status.statusLines).toContain("signal-cli: missing (/tmp/work-signal-cli)");
  });

  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const status = await getSignalSetupStatus({
      cfg: {
        channels: {
          signal: {
            defaultAccount: "work",
            cliPath: "/tmp/root-signal-cli",
            accounts: {
              alerts: {
                cliPath: "/tmp/alerts-signal-cli",
              },
              work: {
                cliPath: "",
                account: "+15555550123",
                httpHost: "",
                httpUrl: "",
              },
            },
          },
        },
      } as OpenClawConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
  });

  it("shows focused signal-cli path help before the cliPath prompt", () => {
    const input = createSignalCliPathTextInput(async () => true);

    expect(input.helpTitle).toBe("signal-cli path");
    expect(input.helpLines).toEqual([
      "This is the command OpenClaw runs for local signal-cli setup.",
      "Use the full path if it is not on PATH, for example /opt/homebrew/bin/signal-cli.",
    ]);
  });
});

describe("signal outbound", () => {
  it("resolves aliases through the message target resolver", async () => {
    const resolved = await signalPlugin.messaging?.targetResolver?.resolveTarget?.({
      cfg: {
        channels: {
          signal: {
            aliases: {
              ops: "signal:group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
            },
          },
        },
      } as OpenClawConfig,
      input: "signal:ops",
      normalized: "ops",
      preferredKind: "group",
    });

    expect(resolved).toEqual({
      to: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
      kind: "group",
      display: "ops",
      source: "directory",
    });
  });

  it("resolves aliases through sync outbound target resolution", () => {
    const resolved = signalPlugin.outbound?.resolveTarget?.({
      cfg: {
        channels: {
          signal: {
            aliases: {
              me: "+15551234567",
            },
          },
        },
      } as OpenClawConfig,
      to: "signal:me",
      accountId: "default",
    });

    expect(resolved).toEqual({ ok: true, to: "+15551234567" });
  });

  it("keeps Signal outbound text sanitization enabled", () => {
    expect(
      signalPlugin.outbound?.sanitizeText?.({
        text: "<think>private reasoning</think>\nVisible answer",
        payload: { text: "Visible answer" },
      }),
    ).toBe("Visible answer");
  });

  it("resolves aliases before durable Signal message sends", async () => {
    const send = vi.fn(async () => ({
      messageId: "signal-1",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "signal", messageId: "signal-1" }],
        kind: "text",
      }),
    }));

    await signalPlugin.message?.send?.text?.({
      cfg: {
        channels: {
          signal: {
            aliases: {
              me: "+15551234567",
            },
          },
        },
      } as OpenClawConfig,
      to: "signal:me",
      text: "approval",
      deps: { signal: send },
    });

    expect(send).toHaveBeenCalledWith(
      "+15551234567",
      "approval",
      expect.objectContaining({
        cfg: expect.any(Object),
      }),
    );
  });

  it("resolves aliases before formatted Signal sends", async () => {
    const send = vi.fn(async () => ({
      messageId: "signal-1",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "signal", messageId: "signal-1" }],
        kind: "text",
      }),
    }));

    await signalPlugin.outbound?.sendFormattedText?.({
      cfg: {
        channels: {
          signal: {
            aliases: {
              ops: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
            },
          },
        },
      } as OpenClawConfig,
      to: "signal:ops",
      text: "approval",
      deps: { signal: send },
    });

    expect(send).toHaveBeenCalledWith(
      "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
      "approval",
      expect.objectContaining({
        cfg: expect.any(Object),
      }),
    );
  });

  it("reports a formatted Signal chunk before a later chunk fails", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "signal-1" })
      .mockRejectedValueOnce(new Error("second Signal chunk failed"));
    const onDeliveryResult = vi.fn();

    await expect(
      signalPlugin.outbound?.sendFormattedText?.({
        cfg: { channels: { signal: { replyToMode: "first" } } } as OpenClawConfig,
        to: "+15551234567",
        text: "a".repeat(5000),
        deps: { signal: send },
        replyToId: "1700000000004",
        replyToIdSource: "implicit",
        onDeliveryResult,
      }),
    ).rejects.toThrow("second Signal chunk failed");

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(
      2,
      "+15551234567",
      expect.any(String),
      expect.not.objectContaining({
        replyToId: "1700000000004",
      }),
    );
    expect(onDeliveryResult).toHaveBeenCalledTimes(1);
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "signal", messageId: "signal-1" }),
    );
  });

  it("resolves aliases before formatted Signal media sends", async () => {
    const send = vi.fn(async () => ({
      messageId: "signal-1",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "signal", messageId: "signal-1" }],
        kind: "media",
      }),
    }));

    await signalPlugin.outbound?.sendFormattedMedia?.({
      cfg: {
        channels: {
          signal: {
            aliases: {
              ops: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
            },
          },
        },
      } as OpenClawConfig,
      to: "signal:ops",
      text: "approval",
      mediaUrl: "file:///tmp/signal-proof.png",
      deps: { signal: send },
    });

    expect(send).toHaveBeenCalledWith(
      "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
      "approval",
      expect.objectContaining({
        cfg: expect.any(Object),
        mediaUrl: "file:///tmp/signal-proof.png",
      }),
    );
  });

  it("returns clear outbound errors for recursive aliases", () => {
    const resolved = signalPlugin.outbound?.resolveTarget?.({
      cfg: {
        channels: {
          signal: {
            aliases: {
              home: "signal:me",
              me: "home",
            },
          },
        },
      } as OpenClawConfig,
      to: "signal:home",
    });

    expect(resolved?.ok).toBe(false);
    if (resolved?.ok === false) {
      expect(resolved.error.message).toBe(
        'Signal alias "home" resolves recursively through "home".',
      );
    }
  });

  it("returns target resolver misses for recursive aliases", async () => {
    const resolved = await signalPlugin.messaging?.targetResolver?.resolveTarget?.({
      cfg: {
        channels: {
          signal: {
            aliases: {
              home: "signal:me",
              me: "home",
            },
          },
        },
      } as OpenClawConfig,
      input: "signal:home",
      normalized: "home",
      preferredKind: "user",
    });

    expect(resolved).toBeNull();
  });

  it("returns clear outbound errors for recursive defaultTo aliases", () => {
    const cfg = {
      channels: {
        signal: {
          aliases: {
            home: "signal:me",
            me: "home",
          },
          defaultTo: "signal:home",
        },
      },
    } as OpenClawConfig;

    const defaultTo = signalPlugin.config.resolveDefaultTo?.({
      cfg,
      accountId: "default",
    });
    expect(defaultTo).toBe("signal:home");

    const resolved = signalPlugin.outbound?.resolveTarget?.({
      cfg,
      to: defaultTo,
      accountId: "default",
    });

    expect(resolved?.ok).toBe(false);
    if (resolved?.ok === false) {
      expect(resolved.error.message).toBe(
        'Signal alias "home" resolves recursively through "home".',
      );
    }
  });

  it("builds canonical session routes for aliases", async () => {
    const route = await signalPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {
        channels: {
          signal: {
            aliases: {
              ops: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
            },
          },
        },
      } as OpenClawConfig,
      agentId: "main",
      target: "signal:ops",
      resolvedTarget: {
        to: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
        kind: "group",
        source: "directory",
      },
    });

    expect(route?.to).toBe("group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=");
    expect(route?.baseSessionKey).toContain(
      "signal:group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
    );
  });

  it("lists configured aliases through the Signal directory", async () => {
    const cfg = {
      channels: {
        signal: {
          aliases: {
            me: "+15551234567",
            ops: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      signalPlugin.directory?.listPeers?.({ cfg, query: "me", runtime: {} as never }),
    ).resolves.toEqual([{ kind: "user", id: "+15551234567", name: "me" }]);
    await expect(
      signalPlugin.directory?.listGroups?.({ cfg, query: "ops", runtime: {} as never }),
    ).resolves.toEqual([
      {
        kind: "group",
        id: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
        name: "ops",
      },
    ]);
  });

  it("resolves account and chat-type scoped reply-to modes through plugin threading", () => {
    const resolveReplyToMode = signalPlugin.threading?.resolveReplyToMode;
    if (!resolveReplyToMode) {
      throw new Error("signal threading.resolveReplyToMode unavailable");
    }

    const cfg = {
      channels: {
        signal: {
          replyToMode: "first",
          replyToModeByChatType: { direct: "all", group: "off" },
          accounts: {
            Work: {
              replyToMode: "off",
              replyToModeByChatType: { group: "all" },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveReplyToMode({ cfg, accountId: "work", chatType: "group" })).toBe("all");
    expect(resolveReplyToMode({ cfg, accountId: "work", chatType: "direct" })).toBe("off");
    expect(resolveReplyToMode({ cfg, accountId: "default", chatType: "direct" })).toBe("all");
    expect(resolveReplyToMode({ cfg, accountId: "default", chatType: "group" })).toBe("off");
    expect(resolveReplyToMode({ cfg, accountId: "default" })).toBe("first");
  });

  it("builds same-conversation reply context for message tool sends", () => {
    const buildToolContext = signalPlugin.threading?.buildToolContext;
    if (!buildToolContext) {
      throw new Error("signal threading.buildToolContext unavailable");
    }

    const hasRepliedRef = { value: false };
    const context = buildToolContext({
      cfg: {
        channels: {
          signal: {
            replyToModeByChatType: { direct: "first" },
          },
        },
      } as OpenClawConfig,
      accountId: "default",
      context: {
        Channel: "signal",
        To: "signal:+15550001111",
        ChatType: "direct",
        CurrentMessageId: "1783831798122",
        ReplyToId: "1783831798000",
      },
      hasRepliedRef,
    });
    if (!context) {
      throw new Error("signal threading tool context unavailable");
    }

    expect(context).toEqual({
      currentChannelId: "signal:+15550001111",
      currentChatType: "direct",
      currentMessagingTarget: "signal:+15550001111",
      currentMessageId: "1783831798000",
      replyToMode: "first",
      hasRepliedRef,
    });
    expect(
      signalPlugin.threading?.matchesToolContextTarget?.({
        target: "+15550001111",
        toolContext: context,
      }),
    ).toBe(true);
  });

  it("chunks outbound text without requiring Signal runtime initialization", () => {
    clearSignalRuntime();
    const chunker = signalPlugin.outbound?.chunker;
    if (!chunker) {
      throw new Error("signal outbound.chunker unavailable");
    }

    expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
  });

  it("sanitizes internal assistant scaffolding before outbound delivery", () => {
    const sanitizeText = signalPlugin.outbound?.sanitizeText;
    if (!sanitizeText) {
      throw new Error("signal outbound sanitizer unavailable");
    }

    expect(
      sanitizeText({
        text: "<think>private</think>Visible answer",
        payload: { text: "<think>private</think>Visible answer" },
      }),
    ).toBe("Visible answer");
  });

  it("preserves the local approval prompt suppressor through attached-result composition", () => {
    const suppressor = signalPlugin.outbound?.shouldSuppressLocalPayloadPrompt;
    if (!suppressor) {
      throw new Error("signal outbound approval suppressor unavailable");
    }

    expect(
      suppressor({
        cfg: {
          channels: {
            signal: {
              enabled: true,
              allowFrom: ["+15551230000"],
            },
          },
          approvals: {
            exec: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        accountId: "default",
        payload: {
          text: "Approval required.",
          channelData: {
            execApproval: {
              approvalId: "exec-1",
              approvalSlug: "exec-1",
              approvalKind: "exec",
              sessionKey: "agent:main:signal:+15551230000",
            },
          },
        },
        hint: {
          kind: "approval-pending",
          approvalKind: "exec",
          nativeRouteActive: true,
        },
      }),
    ).toBe(true);
  });

  it("registers structured approval payloads for reactions after delivery", async () => {
    clearSignalApprovalReactionTargetsForTest();
    const cfg = {
      channels: {
        signal: {
          account: "+15550009999",
          allowFrom: ["+15551230000"],
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    } as OpenClawConfig;
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "exec-after-delivery",
      approvalSlug: "exec-aft",
      allowedDecisions: ["allow-once", "deny"],
      command: "printf test",
      host: "gateway",
      agentId: "main",
      sessionKey: "agent:main:signal:direct:+15551230000",
    });
    const rendered = await signalPlugin.outbound?.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: {
        cfg,
        to: "+15551230000",
        text: payload.text ?? "",
        accountId: "default",
        payload,
      },
    });
    expect(rendered?.text).toContain("React with:\n\n👍 Allow Once\n👎 Deny");

    await signalPlugin.outbound?.afterDeliverPayload?.({
      cfg,
      target: {
        channel: "signal",
        to: "+15551230000",
        accountId: "default",
      },
      payload: rendered!,
      results: [
        {
          channel: "signal",
          messageId: "1700000000099",
        },
      ],
    });

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000099",
        reactionKey: "👍",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toEqual({
      approvalId: "exec-after-delivery",
      approvalKind: "exec",
      decision: "allow-once",
      route: {
        deliveryMode: "target",
        to: "+15551230000",
        accountId: "default",
        agentId: "main",
        sessionKey: "agent:main:signal:direct:+15551230000",
      },
    });
  });

  it("renders reaction hints only from structured approval payloads", async () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15550009999",
          allowFrom: ["+15551230000"],
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    } as OpenClawConfig;
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "exec-rendered-approval",
      approvalSlug: "exec-ren",
      allowedDecisions: ["allow-once", "deny"],
      command: "printf test",
      host: "gateway",
    });
    const rendered = await signalPlugin.outbound?.renderPresentation?.({
      payload,
      presentation: payload.presentation!,
      ctx: {
        cfg,
        to: "+15551230000",
        text: payload.text ?? "",
        accountId: "default",
        payload,
      },
    });

    expect(rendered?.text).toContain("React with:\n\n👍 Allow Once\n👎 Deny");
    expect(
      await signalPlugin.outbound?.renderPresentation?.({
        payload: {
          text: [
            "The docs show this example:",
            "Exec approval required",
            "ID: exec-rendered-approval",
            "",
            "Reply with: /approve exec-rendered-approval allow-once|deny",
          ].join("\n"),
          presentation: payload.presentation,
        },
        presentation: payload.presentation!,
        ctx: {
          cfg,
          to: "+15551230000",
          text: payload.text ?? "",
          accountId: "default",
          payload,
        },
      }),
    ).toBeNull();
  });

  it("materializes mixed approval presentation before adding reaction guidance", async () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15550009999",
          allowFrom: ["+15551230000"],
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    } as OpenClawConfig;
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "exec-mixed-presentation",
      approvalSlug: "exec-mixed-presentation",
      allowedDecisions: ["allow-once", "deny"],
      command: "printf test",
      host: "gateway",
    });
    const presentation = {
      ...payload.presentation!,
      blocks: [
        { type: "context" as const, text: "Deployment audit context" },
        {
          type: "table" as const,
          caption: "Targets",
          headers: ["Host", "State"],
          rows: [
            ["alpha", "ready"],
            ["omega", "waiting"],
          ],
        },
        ...payload.presentation!.blocks,
      ],
    };

    const rendered = await signalPlugin.outbound?.renderPresentation?.({
      payload: { ...payload, presentation },
      presentation,
      ctx: {
        cfg,
        to: "+15551230000",
        text: payload.text ?? "",
        accountId: "default",
        payload,
      },
    });

    expect(rendered?.text).toContain("Deployment audit context");
    expect(rendered?.text).toContain("- Host: alpha; State: ready");
    expect(rendered?.text).toContain("- Host: omega; State: waiting");
    expect(rendered?.text?.match(/React with:/g)).toHaveLength(1);
    expect(rendered?.text?.match(/\/approve exec-mixed-presentation allow-once/g)).toHaveLength(1);
    expect(rendered?.text?.match(/\/approve exec-mixed-presentation deny/g)).toHaveLength(1);
    expect(rendered?.text).not.toContain("- Allow Once:");
    expect(rendered?.text).not.toContain("- Deny:");
  });

  it("registers delivered approval reactions under the resolved default account", async () => {
    const renderPresentation = signalPlugin.outbound?.renderPresentation;
    const afterDeliverPayload = signalPlugin.outbound?.afterDeliverPayload;
    if (!renderPresentation || !afterDeliverPayload) {
      throw new Error("signal outbound approval delivery hooks unavailable");
    }

    clearSignalApprovalReactionTargetsForTest();
    const cfg = {
      channels: {
        signal: {
          defaultAccount: "work",
          accounts: {
            work: {
              accountUuid: "123e4567-e89b-12d3-a456-426614174000",
              allowFrom: ["+15551230000"],
            },
          },
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    } as OpenClawConfig;
    const payload: ReplyPayload = {
      text: ["Exec approval required", "ID: exec-1"].join("\n"),
      channelData: {
        execApproval: {
          approvalId: "exec-1",
          approvalSlug: "exec-1",
          approvalKind: "exec",
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    };
    const renderedPayload =
      (await renderPresentation({
        ctx: {
          cfg,
          to: "+15551230000",
          text: payload.text ?? "",
          accountId: "work",
          payload,
        },
        presentation: { blocks: [] },
        payload,
      })) ?? payload;

    expect(renderedPayload.text).toContain("React with:\n\n👍 Allow Once\n👎 Deny");

    await afterDeliverPayload({
      cfg,
      target: { channel: "signal", to: "+15551230000" },
      payload: renderedPayload,
      results: [
        {
          channel: "signal",
          messageId: "1700000000001",
          meta: { signalVisibleText: renderedPayload.text },
        },
      ],
    });

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "work",
        conversationKey: "+15551230000",
        messageId: "1700000000001",
        reactionKey: "👍",
        targetAuthorUuid: "123e4567-e89b-12d3-a456-426614174000",
      }),
    ).resolves.toMatchObject({
      approvalId: "exec-1",
      decision: "allow-once",
    });
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000001",
        reactionKey: "👍",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toBeNull();
    clearSignalApprovalReactionTargetsForTest();
  });

  it("resolves only proven direct reply authors", async () => {
    const replyContext = { to: "signal:+15551234567", replyToId: "1700000000001" };
    await registerSignalReplyContext({
      ...replyContext,
      author: "+15551234567",
      sourceTimestamp: 100,
    });
    await registerSignalReplyContext({
      ...replyContext,
      author: "+15550001111",
      sourceTimestamp: 200,
    });
    await registerSignalReplyContext({
      ...replyContext,
      author: "+15551234567",
      sourceTimestamp: 300,
    });
    await expect(resolveSignalReplyContextWithPersistence(replyContext)).resolves.toEqual({
      ambiguous: true,
    });
    await clearSignalReplyAuthorsForTest();
  });

  it("keeps newer reply context when older events arrive out of order", async () => {
    const replyContext = { to: "signal:+15551234567", replyToId: "1700000000002" };
    await registerSignalReplyContext({
      ...replyContext,
      author: "+15551234567",
      body: "newer",
      sourceTimestamp: 200,
    });
    await registerSignalReplyContext({
      ...replyContext,
      author: "+15551234567",
      body: "older",
      sourceTimestamp: 100,
    });

    await expect(resolveSignalReplyContextWithPersistence(replyContext)).resolves.toEqual({
      author: "+15551234567",
      body: "newer",
    });
    await clearSignalReplyAuthorsForTest();
  });

  it("hydrates durable Signal sends with stored native quote context", async () => {
    await clearSignalReplyAuthorsForTest();
    await registerSignalReplyContext({
      to: "signal:+15555550123",
      replyToId: "1700000000001",
      author: "+15555550123",
      body: "original message",
    });
    const send = vi.fn(async () => ({ messageId: "signal-text-1" }));

    await signalPlugin.message?.send?.text?.({
      cfg: {} as OpenClawConfig,
      to: "signal:+15555550123",
      text: "reply",
      replyToId: "1700000000001",
      deps: { signal: send },
    } as Parameters<NonNullable<typeof signalPlugin.message.send.text>>[0] & {
      deps: { signal: typeof send };
    });

    expect(send).toHaveBeenCalledWith("+15555550123", "reply", {
      cfg: {},
      maxBytes: undefined,
      accountId: undefined,
      replyToId: "1700000000001",
      replyToAuthor: "+15555550123",
      replyToBody: "original message",
    });
    await clearSignalReplyAuthorsForTest();
  });

  it("declares message adapter durable text and media with receipt proofs", async () => {
    const send = vi.fn(async (_to: string, _text: string, opts: { mediaUrl?: string } = {}) => {
      const messageId = opts.mediaUrl ? "signal-media-1" : "signal-text-1";
      return {
        messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "signal", messageId }],
          kind: opts.mediaUrl ? "media" : "text",
        }),
      };
    });
    const deps = { signal: send };

    const proofResults = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "signal",
      adapter: signalPlugin.message!,
      proofs: {
        text: async () => {
          const result = await signalPlugin.message?.send?.text?.({
            cfg: {} as OpenClawConfig,
            to: "signal:+15555550123",
            text: "hello",
            deps,
          } as Parameters<NonNullable<typeof signalPlugin.message.send.text>>[0] & {
            deps: typeof deps;
          });
          expect(send).toHaveBeenCalledWith("+15555550123", "hello", {
            cfg: {},
            maxBytes: undefined,
            accountId: undefined,
          });
          expect(result?.receipt.platformMessageIds).toEqual(["signal-text-1"]);
        },
        media: async () => {
          const result = await signalPlugin.message?.send?.media?.({
            cfg: {} as OpenClawConfig,
            to: "signal:+15555550123",
            text: "image",
            mediaUrl: "https://example.com/image.png",
            deps,
          } as Parameters<NonNullable<typeof signalPlugin.message.send.media>>[0] & {
            deps: typeof deps;
          });
          expect(send).toHaveBeenCalledWith("+15555550123", "image", {
            cfg: {},
            mediaUrl: "https://example.com/image.png",
            maxBytes: undefined,
            accountId: undefined,
          });
          expect(result?.receipt.platformMessageIds).toEqual(["signal-media-1"]);
        },
      },
    });

    expect(proofResults).toEqual([
      { capability: "text", status: "verified" },
      { capability: "media", status: "verified" },
      { capability: "poll", status: "not_declared" },
      { capability: "payload", status: "not_declared" },
      { capability: "silent", status: "not_declared" },
      { capability: "replyTo", status: "not_declared" },
      { capability: "thread", status: "not_declared" },
      { capability: "nativeQuote", status: "not_declared" },
      { capability: "messageSendingHooks", status: "not_declared" },
      { capability: "batch", status: "not_declared" },
      { capability: "reconcileUnknownSend", status: "not_declared" },
      { capability: "afterSendSuccess", status: "not_declared" },
      { capability: "afterCommit", status: "not_declared" },
    ]);
  });
});

describe("classifySignalCliLogLine", () => {
  it("treats INFO/DEBUG as log", () => {
    expect(classifySignalCliLogLine("INFO  DaemonCommand - Started")).toBe("log");
    expect(classifySignalCliLogLine("DEBUG Something")).toBe("log");
  });

  it("treats routine warnings as logs and errors as error state", () => {
    expect(classifySignalCliLogLine("WARN  Something")).toBe("log");
    expect(classifySignalCliLogLine("WARNING Something")).toBe("log");
    expect(classifySignalCliLogLine("ERROR Something")).toBe("error");
  });

  it("treats failures without explicit severity as error", () => {
    expect(classifySignalCliLogLine("Failed to initialize HTTP Server - oops")).toBe("error");
    expect(classifySignalCliLogLine('Exception in thread "main"')).toBe("error");
  });

  it("returns null for empty lines", () => {
    expect(classifySignalCliLogLine("")).toBe(null);
    expect(classifySignalCliLogLine("   ")).toBe(null);
  });
});

describe("signal setup parsing", () => {
  it("accepts already normalized numbers", () => {
    expect(normalizeSignalAccountInput("+15555550123")).toBe("+15555550123");
  });

  it("normalizes valid E.164 numbers", () => {
    expect(normalizeSignalAccountInput(" +1 (555) 555-0123 ")).toBe("+15555550123");
  });

  it("rejects empty input", () => {
    expect(normalizeSignalAccountInput("   ")).toBeNull();
  });

  it("rejects invalid values", () => {
    expect(normalizeSignalAccountInput("abc")).toBeNull();
    expect(normalizeSignalAccountInput("++--")).toBeNull();
  });

  it("rejects inputs with stray + characters", () => {
    expect(normalizeSignalAccountInput("++12345")).toBeNull();
    expect(normalizeSignalAccountInput("+1+2345")).toBeNull();
  });

  it("rejects numbers that are too short or too long", () => {
    expect(normalizeSignalAccountInput("+1234")).toBeNull();
    expect(normalizeSignalAccountInput("+1234567890123456")).toBeNull();
  });

  it("parses e164, uuid and wildcard entries", () => {
    expect(
      parseSignalAllowFromEntries(
        "signal:+15555550123, uuid:123e4567-e89b-12d3-a456-426614174000, *",
      ),
    ).toEqual({
      entries: ["+15555550123", "uuid:123e4567-e89b-12d3-a456-426614174000", "*"],
    });
  });

  it("normalizes bare uuid values", () => {
    expect(parseSignalAllowFromEntries("123e4567-e89b-12d3-a456-426614174000")).toEqual({
      entries: ["uuid:123e4567-e89b-12d3-a456-426614174000"],
    });
  });

  it("returns validation errors for invalid entries", () => {
    expect(parseSignalAllowFromEntries("uuid:")).toEqual({
      entries: [],
      error: "Invalid uuid entry",
    });
    expect(parseSignalAllowFromEntries("invalid")).toEqual({
      entries: [],
      error: "Invalid entry: invalid",
    });
  });

  it("reads the named-account DM policy instead of the channel root", () => {
    expect(
      signalDmPolicy.getCurrent(
        {
          channels: {
            signal: {
              dmPolicy: "disabled",
              accounts: {
                work: {
                  account: "+15555550123",
                  dmPolicy: "allowlist",
                },
              },
            },
          },
        },
        "work",
      ),
    ).toBe("allowlist");
  });

  it("reports account-scoped config keys for named accounts", () => {
    expect(signalDmPolicy.resolveConfigKeys?.({ channels: { signal: {} } }, "work")).toEqual({
      policyKey: "channels.signal.accounts.work.dmPolicy",
      allowFromKey: "channels.signal.accounts.work.allowFrom",
    });
  });

  it("configures native signal-cli auto-start setup through the wizard", async () => {
    const cliPath = "/tmp/openclaw-missing-signal-cli-native-setup";
    const prompts = createQueuedWizardPrompter({
      selectValues: ["native"],
      textValues: [cliPath, "+1 (555) 555-0123", "~/.local/share/signal-cli"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            cliPath,
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(result.cfg.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      cliPath,
      configPath: "~/.local/share/signal-cli",
      autoStart: true,
    });
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining("/opt/homebrew/bin/signal-cli"),
      "signal-cli path",
    );
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining("for example +15555550123"),
      "Signal phone number",
    );
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining("Example: ~/.local/share/signal-cli"),
      "signal-cli config path",
    );
    expect(
      prompts.text.mock.calls.map(([prompt]) => (prompt as { message?: string }).message),
    ).toEqual(["signal-cli path", "Signal phone number", "signal-cli config path (optional)"]);
    expect(result.cfg.channels?.signal?.httpUrl).toBeUndefined();
    expect(result.cfg.channels?.signal?.apiMode).toBeUndefined();
  });

  it("returns to the Signal setup choice after signal-cli auto-install fails", async () => {
    installSignalCliMock.mockResolvedValueOnce({
      ok: false,
      error: "Signal setup hit an error while installing signal-cli.",
    });
    setSignalSetupServerProbeForTest(async () => ({ ok: true as const, version: "0.13.22" }));
    const prompts = createQueuedWizardPrompter({
      selectValues: ["native", "external-native"],
      confirmValues: [true],
      textValues: ["+15555550123", "http://127.0.0.1:18080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            cliPath: "/tmp/openclaw-missing-signal-cli-install-retry",
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
      options: { allowSignalInstall: true },
    });

    expect(installSignalCliMock).toHaveBeenCalledTimes(1);
    expect(prompts.note).toHaveBeenCalledWith(
      "Signal setup hit an error while installing signal-cli.",
      "Signal",
    );
    expect(prompts.select).toHaveBeenCalledTimes(2);
    expect(
      prompts.select.mock.calls.map(([prompt]) => (prompt as { message?: string }).message),
    ).toEqual([
      "How do you want to set up Signal for OpenClaw?",
      "How do you want to set up Signal for OpenClaw?",
    ]);
    expect(
      prompts.text.mock.calls.map(([prompt]) => (prompt as { message?: string }).message),
    ).not.toContain("signal-cli path");
    expect(result.cfg.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      httpUrl: "http://127.0.0.1:18080",
      autoStart: false,
      apiMode: "auto",
    });
    const status = await getSignalSetupStatus({
      cfg: result.cfg,
      accountOverrides: {},
    });
    expect(status.statusLines).toContain("Signal transport: existing Signal server");
  });

  it("uses an installed signal-cli path for native setup", async () => {
    installSignalCliMock.mockResolvedValueOnce({
      ok: true,
      cliPath: "/tmp/openclaw-installed-signal-cli",
    });
    const prompts = createQueuedWizardPrompter({
      selectValues: ["native"],
      confirmValues: [true],
      textValues: [
        "/tmp/openclaw-installed-signal-cli",
        "+1 (555) 555-0123",
        "~/.local/share/signal-cli",
      ],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            cliPath: "/tmp/openclaw-missing-signal-cli-install-success",
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
      options: { allowSignalInstall: true },
    });

    expect(installSignalCliMock).toHaveBeenCalledTimes(1);
    expect(prompts.note).toHaveBeenCalledWith(
      "Installed signal-cli at /tmp/openclaw-installed-signal-cli",
      "Signal",
    );
    const textPrompts = prompts.text.mock.calls.map(
      ([prompt]) =>
        prompt as {
          message?: string;
          initialValue?: string;
        },
    );
    expect(textPrompts).toEqual([
      expect.objectContaining({
        message: "signal-cli path",
        initialValue: "/tmp/openclaw-installed-signal-cli",
      }),
      expect.objectContaining({ message: "Signal phone number" }),
      expect.objectContaining({ message: "signal-cli config path (optional)" }),
    ]);
    expect(result.cfg.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      cliPath: "/tmp/openclaw-installed-signal-cli",
      configPath: "~/.local/share/signal-cli",
      autoStart: true,
    });
    expect(result.cfg.channels?.signal?.httpUrl).toBeUndefined();
    expect(result.cfg.channels?.signal?.apiMode).toBeUndefined();
  });

  it("switches stale external setup back to native signal-cli setup", async () => {
    const prompts = createQueuedWizardPrompter({
      selectValues: ["native"],
      confirmValues: [true],
      textValues: ["/tmp/missing-signal-cli-native-switch", ""],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            enabled: true,
            account: "+15555550123",
            cliPath: "/tmp/missing-signal-cli-native-switch",
            configPath: "/tmp/stale-signal-config",
            httpHost: "192.0.2.10",
            httpPort: 18080,
            autoStart: false,
            apiMode: "auto",
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(result.cfg.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      cliPath: "/tmp/missing-signal-cli-native-switch",
      autoStart: true,
    });
    expect(result.cfg.channels?.signal?.httpUrl).toBeUndefined();
    expect(result.cfg.channels?.signal?.httpHost).toBeUndefined();
    expect(result.cfg.channels?.signal?.httpPort).toBeUndefined();
    expect(result.cfg.channels?.signal?.configPath).toBeUndefined();
    expect(result.cfg.channels?.signal?.apiMode).toBe("native");
  });

  it("preserves custom native daemon host and port when rerunning native setup", async () => {
    const prompts = createQueuedWizardPrompter({
      selectValues: ["native"],
      textValues: ["/tmp/missing-signal-cli-native-custom", "+15555550123", ""],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            enabled: true,
            account: "+15555550123",
            cliPath: "/tmp/missing-signal-cli-native-custom",
            autoStart: true,
            apiMode: "native",
            httpHost: "127.0.0.1",
            httpPort: 19089,
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(result.cfg.channels?.signal).toMatchObject({
      account: "+15555550123",
      cliPath: "/tmp/missing-signal-cli-native-custom",
      autoStart: true,
      apiMode: "native",
      httpHost: "127.0.0.1",
      httpPort: 19089,
    });
  });

  it("preserves the root native port when interactive setup scopes the default account", async () => {
    const prompts = createQueuedWizardPrompter({
      selectValues: ["native"],
      textValues: ["/tmp/missing-signal-cli-native-default", "+15555550123", ""],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            cliPath: "/tmp/missing-signal-cli-native-default",
            httpHost: "127.0.0.1",
            httpPort: 19089,
            autoStart: true,
            apiMode: "native",
            accounts: {
              work: {
                account: "+15555550124",
                httpUrl: "http://signal-container:8080",
                autoStart: false,
              },
            },
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(result.cfg.channels?.signal?.httpPort).toBeUndefined();
    expect(result.cfg.channels?.signal?.accounts?.default).toMatchObject({
      httpHost: "127.0.0.1",
      httpPort: 19089,
      autoStart: true,
      apiMode: "native",
    });
  });

  it("persists native transport clears for named Signal accounts", async () => {
    const prompts = createQueuedWizardPrompter({
      selectValues: ["native"],
      textValues: ["/tmp/missing-signal-cli-native-work", "+15555550124", ""],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            enabled: true,
            account: "+15555550123",
            httpUrl: "http://127.0.0.1:18080",
            httpHost: "signal-container",
            httpPort: 18080,
            autoStart: false,
            apiMode: "container",
            accounts: {
              default: {
                account: "+15555550123",
                cliPath: "/usr/local/bin/signal-cli",
                autoStart: true,
              },
            },
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
      accountOverrides: { signal: "work" },
    });

    const workAccount = result.cfg.channels?.signal?.accounts?.work;
    expect(workAccount).toMatchObject({
      account: "+15555550124",
      autoStart: true,
      apiMode: "native",
      httpUrl: "",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      configPath: "",
    });

    const reloadedCfg = structuredClone(result.cfg);
    const resolved = resolveSignalAccount({ cfg: reloadedCfg, accountId: "work" });
    expect(resolved.baseUrl).toBe("http://127.0.0.1:8080");
    expect(resolved.config.apiMode).toBe("native");
    expect(resolved.config.autoStart).toBe(true);
    expect(resolved.config.httpUrl).toBe("");
  });

  it("scopes default native setup fields when Signal named accounts exist", async () => {
    const prompts = createQueuedWizardPrompter({
      selectValues: ["native"],
      textValues: ["/tmp/missing-signal-cli-native-default", "+15555550123", ""],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            enabled: true,
            name: "Legacy default",
            account: "+15550000000",
            accountUuid: "123e4567-e89b-12d3-a456-426614174000",
            cliPath: "/tmp/stale-root-signal-cli",
            configPath: "/tmp/stale-root-signal-config",
            httpUrl: "http://stale-root:8080",
            httpHost: "stale-root",
            httpPort: 19090,
            autoStart: false,
            apiMode: "container",
            accounts: {
              default: {
                enabled: false,
              },
              work: {
                name: "Work",
                autoStart: false,
              },
              personal: {},
            },
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(result.cfg.channels?.signal?.account).toBeUndefined();
    expect(result.cfg.channels?.signal?.name).toBeUndefined();
    expect(result.cfg.channels?.signal?.accountUuid).toBeUndefined();
    expect(result.cfg.channels?.signal?.cliPath).toBeUndefined();
    expect(result.cfg.channels?.signal?.configPath).toBeUndefined();
    expect(result.cfg.channels?.signal?.httpUrl).toBeUndefined();
    expect(result.cfg.channels?.signal?.httpHost).toBeUndefined();
    expect(result.cfg.channels?.signal?.httpPort).toBeUndefined();
    expect(result.cfg.channels?.signal?.autoStart).toBeUndefined();
    expect(result.cfg.channels?.signal?.apiMode).toBe("container");
    expect(result.cfg.channels?.signal?.accounts?.default).toMatchObject({
      enabled: true,
      name: "Legacy default",
      account: "+15555550123",
      cliPath: "/tmp/missing-signal-cli-native-default",
      autoStart: true,
      apiMode: "native",
      httpUrl: "",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      accountUuid: "123e4567-e89b-12d3-a456-426614174000",
    });

    const reloadedCfg = structuredClone(result.cfg);
    const work = resolveSignalAccount({ cfg: reloadedCfg, accountId: "work" });
    expect(work.name).toBe("Work");
    expect(work.config.account).toBe("+15550000000");
    expect(work.config.accountUuid).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(work.config.cliPath).toBe("/tmp/stale-root-signal-cli");
    expect(work.config.configPath).toBe("/tmp/stale-root-signal-config");
    expect(work.config.httpUrl).toBe("http://stale-root:8080");
    expect(work.config.httpHost).toBe("stale-root");
    expect(work.config.httpPort).toBe(19090);
    expect(work.config.apiMode).toBe("container");
    expect(work.config.autoStart).toBe(false);
    expect(resolveSignalAccount({ cfg: reloadedCfg, accountId: "personal" }).name).toBeUndefined();
  });

  it("preselects native setup for an existing native Signal account", async () => {
    const prompts = createQueuedWizardPrompter({
      selectValues: ["native"],
    });

    await runSetupWizardPrepare({
      prepare: prepareSignalSetupWizard,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How do you want to set up Signal for OpenClaw?",
        initialValue: "native",
      }),
    );
  });

  it("preselects existing-server setup when container mode has an existing URL", async () => {
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
    });

    const result = await runSetupWizardPrepare({
      prepare: prepareSignalSetupWizard,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            httpUrl: "http://127.0.0.1:18080",
            autoStart: false,
            apiMode: "container",
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How do you want to set up Signal for OpenClaw?",
        initialValue: "external-native",
      }),
    );
    expect(result?.credentialValues?.signalTransport).toBe("external-native");
  });

  it("preselects native setup when explicit auto-start uses a custom URL", async () => {
    const prompts = createQueuedWizardPrompter({
      selectValues: ["native"],
    });

    const result = await runSetupWizardPrepare({
      prepare: prepareSignalSetupWizard,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            httpUrl: "http://127.0.0.1:18080",
            autoStart: true,
            apiMode: "native",
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How do you want to set up Signal for OpenClaw?",
        initialValue: "native",
      }),
    );
    expect(result?.credentialValues?.signalTransport).toBe("native");
  });

  it("preselects existing-server setup when container mode has host and port", async () => {
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
    });

    const result = await runSetupWizardPrepare({
      prepare: prepareSignalSetupWizard,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            httpHost: "127.0.0.1",
            httpPort: 18080,
            autoStart: false,
            apiMode: "container",
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How do you want to set up Signal for OpenClaw?",
        initialValue: "external-native",
      }),
    );
    expect(result?.credentialValues?.signalTransport).toBe("external-native");
  });

  it("connects to an existing Signal server through the wizard", async () => {
    const probe = vi.fn(async () => ({ ok: true as const, version: "0.13.22" }));
    setSignalSetupServerProbeForTest(probe);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      textValues: ["+15555550123", "http://127.0.0.1:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(result.cfg.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      httpUrl: "http://127.0.0.1:8080",
      autoStart: false,
      apiMode: "auto",
    });
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining("For a local helper, this usually looks like http://127.0.0.1:8080."),
      "Signal server URL",
    );
    expect(probe).toHaveBeenCalledWith({
      httpUrl: "http://127.0.0.1:8080",
      account: "+15555550123",
      apiMode: "auto",
    });
    expect(prompts.progress).toHaveBeenCalledWith("Testing Signal server URL");
    const progress = prompts.progress.mock.results[0]?.value;
    expect(progress?.update).toHaveBeenCalledWith("Testing http://127.0.0.1:8080");
    expect(progress?.stop).toHaveBeenCalledWith("Signal server reachable");
    expect(result.cfg.channels?.signal?.cliPath).toBeUndefined();
    const nextStepsNotes = prompts.note.mock.calls.filter(
      ([, title]) => title === "Signal next steps",
    );
    expect(nextStepsNotes).toEqual([
      [
        expect.stringContaining("Link and manage this account through the selected Signal server."),
        "Signal next steps",
      ],
    ]);
    expect(nextStepsNotes[0]?.[0]).not.toContain("signal-cli link");
  });

  it("connects to an accountless native Signal server through the wizard", async () => {
    const probe = vi.fn(async () => ({ ok: true as const, version: "0.13.22" }));
    setSignalSetupServerProbeForTest(probe);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      textValues: ["", "http://127.0.0.1:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(result.cfg.channels?.signal).toMatchObject({
      enabled: true,
      httpUrl: "http://127.0.0.1:8080",
      autoStart: false,
      apiMode: "auto",
    });
    expect(result.cfg.channels?.signal?.account).toBeUndefined();
    expect(probe).toHaveBeenCalledWith({
      httpUrl: "http://127.0.0.1:8080",
      account: "",
      apiMode: "auto",
    });
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining("Signal server connected.\n"),
      "Signal next steps",
    );
    expect(prompts.note).not.toHaveBeenCalledWith(
      expect.stringContaining("undefined"),
      expect.anything(),
    );
  });

  it("clears an existing Signal account for accountless native server setup", async () => {
    const probe = vi.fn(async () => ({ ok: true as const, version: "0.13.22" }));
    setSignalSetupServerProbeForTest(probe);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      textValues: ["", "http://127.0.0.1:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            httpUrl: "http://127.0.0.1:8080",
            autoStart: false,
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(result.cfg.channels?.signal?.account).toBe("");
    expect(resolveSignalAccount({ cfg: structuredClone(result.cfg) }).config.account).toBe("");
  });

  it("clears a stale invalid Signal account for accountless native server setup", async () => {
    const probe = vi.fn(async () => ({ ok: true as const, version: "0.13.22" }));
    setSignalSetupServerProbeForTest(probe);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      textValues: ["", "http://127.0.0.1:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            account: "stale-invalid-account",
            httpUrl: "http://127.0.0.1:8080",
            autoStart: false,
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(result.cfg.channels?.signal?.account).toBe("");
    expect(resolveSignalAccount({ cfg: structuredClone(result.cfg) }).config.account).toBe("");
  });

  it("clears an inherited Signal account for named accountless server setup", async () => {
    const probe = vi.fn(async () => ({ ok: true as const, version: "0.13.22" }));
    setSignalSetupServerProbeForTest(probe);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      textValues: ["", "http://127.0.0.1:8081"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            accounts: {
              work: {},
            },
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
      accountOverrides: { signal: "work" },
    });

    expect(result.cfg.channels?.signal?.account).toBe("+15555550123");
    expect(result.cfg.channels?.signal?.accounts?.work?.account).toBe("");
    expect(
      normalizeSignalAccountInput(
        resolveSignalAccount({ cfg: structuredClone(result.cfg), accountId: "work" }).config
          .account,
      ),
    ).toBeNull();
  });

  it("validates an existing native server account without receive probing", async () => {
    vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValue({
      mode: "native",
      check: { ok: true, status: 200, error: null },
    });
    vi.spyOn(clientModule, "signalRpcRequest")
      .mockResolvedValueOnce({ version: "0.13.22" })
      .mockResolvedValueOnce([{ number: "+15555550123" }]);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      textValues: ["+15555550123", "http://signal-cli:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(clientModule.signalCheckWithMode).toHaveBeenCalledWith(
      "http://signal-cli:8080",
      5_000,
      expect.objectContaining({ requireReceive: false }),
    );
    expect(result.cfg.channels?.signal).toMatchObject({
      account: "+15555550123",
      httpUrl: "http://signal-cli:8080",
      autoStart: false,
      apiMode: "auto",
    });
  });

  it("re-prompts an account that an existing native server does not list", async () => {
    vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValue({
      mode: "native",
      check: { ok: true, status: 200, error: null },
    });
    vi.spyOn(clientModule, "signalRpcRequest")
      .mockResolvedValueOnce({ version: "0.13.22" })
      .mockResolvedValueOnce([{ number: "+15555550999" }])
      .mockResolvedValueOnce({ version: "0.13.22" })
      .mockResolvedValueOnce([{ number: "+15555550999" }]);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      textValues: [
        "+15555550123",
        "http://signal-cli:8080",
        "+15555550999",
        "http://signal-cli:8080",
      ],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(
      prompts.text.mock.calls.map(([prompt]) => (prompt as { message?: string }).message),
    ).toEqual([
      "Signal phone number",
      "Signal server URL",
      "Signal phone number",
      "Signal server URL",
    ]);
    expect(result.cfg.channels?.signal).toMatchObject({
      account: "+15555550999",
      httpUrl: "http://signal-cli:8080",
      autoStart: false,
      apiMode: "auto",
    });
  });

  it("does not save an existing native server when the RPC probe fails", async () => {
    vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValue({
      mode: "native",
      check: { ok: true, status: 200, error: null },
    });
    vi.spyOn(clientModule, "signalRpcRequest").mockRejectedValue(new Error("RPC unavailable"));
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      confirmValues: [false],
      textValues: ["+15555550123", "http://signal-cli:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining("OpenClaw could not reach a working Signal server"),
      "Signal server URL",
    );
    expect(prompts.confirm).toHaveBeenCalledWith({
      message: "Try the Signal server URL again?",
      initialValue: true,
    });
    expect(result.cancelled).toBe(true);
    expect(result.cfg).toEqual({});
  });

  it("saves a new default account number when connecting to an existing server with named accounts", async () => {
    const probe = vi.fn(async () => ({ ok: true as const, version: "0.13.22" }));
    setSignalSetupServerProbeForTest(probe);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      confirmValues: [false],
      textValues: ["+15555550124", "http://127.0.0.1:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            enabled: true,
            account: "+15550000000",
            cliPath: "/tmp/stale-root-signal-cli",
            configPath: "/tmp/stale-root-signal-config",
            httpUrl: "http://stale-root:8080",
            httpHost: "stale-root",
            httpPort: 19090,
            autoStart: false,
            apiMode: "auto",
            accounts: {
              default: {
                account: "+15555550123",
              },
              work: {
                account: "+15555550125",
              },
            },
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(probe).toHaveBeenCalledWith({
      httpUrl: "http://127.0.0.1:8080",
      account: "+15555550124",
      apiMode: "auto",
    });
    expect(result.cfg.channels?.signal?.account).toBeUndefined();
    expect(result.cfg.channels?.signal?.accounts?.default).toMatchObject({
      account: "+15555550124",
      httpUrl: "http://127.0.0.1:8080",
      autoStart: false,
      apiMode: "auto",
    });
    expect(result.cfg.channels?.signal?.accounts?.work).toMatchObject({
      account: "+15555550125",
    });
  });

  it("re-prompts the Signal account when the container does not list it", async () => {
    vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValue({
      mode: "container",
      check: { ok: true, status: 101, error: null },
    });
    vi.spyOn(clientModule, "signalRpcRequest").mockResolvedValue({
      version: "0.13.22",
    } as never);
    vi.spyOn(clientModule, "signalCheck").mockResolvedValue({
      ok: true,
      status: 101,
      error: null,
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(["+15555550999"]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.spyOn(fetchRuntime, "resolveFetch").mockReturnValue(fetchImpl as unknown as typeof fetch);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      textValues: [
        "+15555550123",
        "http://signal-cli:8080",
        "+15555550999",
        "http://signal-cli:8080",
      ],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://signal-cli:8080/v1/accounts", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(
      prompts.text.mock.calls.map(([prompt]) => (prompt as { message?: string }).message),
    ).toEqual([
      "Signal phone number",
      "Signal server URL",
      "Signal phone number",
      "Signal server URL",
    ]);
    expect(result.cfg.channels?.signal).toMatchObject({
      account: "+15555550999",
      httpUrl: "http://signal-cli:8080",
      autoStart: false,
      apiMode: "auto",
    });
  });

  it("accepts a bare existing container server URL when the account is linked", async () => {
    vi.spyOn(clientModule, "signalCheckWithMode").mockResolvedValue({
      mode: "container",
      check: { ok: true, status: 101, error: null },
    });
    vi.spyOn(clientModule, "signalRpcRequest").mockResolvedValue({
      version: "0.13.22",
    } as never);
    vi.spyOn(clientModule, "signalCheck").mockResolvedValue({
      ok: true,
      status: 101,
      error: null,
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(["+15555550123"]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.spyOn(fetchRuntime, "resolveFetch").mockReturnValue(fetchImpl as unknown as typeof fetch);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      textValues: ["+15555550123", "signal-cli:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://signal-cli:8080/v1/accounts", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(result.cfg.channels?.signal).toMatchObject({
      account: "+15555550123",
      httpUrl: "signal-cli:8080",
      autoStart: false,
      apiMode: "auto",
    });
  });

  it("retries the Signal server URL until the server check passes", async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, error: "connect ECONNREFUSED 127.0.0.1:8080" })
      .mockResolvedValueOnce({ ok: true as const, version: "0.13.22" });
    setSignalSetupServerProbeForTest(probe);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      confirmValues: [true],
      textValues: ["+15555550123", "http://127.0.0.1:8080", "http://127.0.0.1:18080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "OpenClaw could not reach a working Signal server at http://127.0.0.1:8080.",
      ),
      "Signal server URL",
    );
    expect(prompts.confirm).toHaveBeenCalledWith({
      message: "Try the Signal server URL again?",
      initialValue: true,
    });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(result.cfg.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      httpUrl: "http://127.0.0.1:18080",
      autoStart: false,
      apiMode: "auto",
    });
    const status = await getSignalSetupStatus({
      cfg: result.cfg,
      accountOverrides: {},
    });
    expect(status.statusLines).toContain("Signal transport: existing Signal server");
  });

  it("cancels Signal server URL setup without throwing when the user declines retry", async () => {
    const probe = vi.fn().mockResolvedValueOnce({
      ok: false as const,
      error: "connect ECONNREFUSED 127.0.0.1:8080",
    });
    setSignalSetupServerProbeForTest(probe);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      confirmValues: [false],
      textValues: ["+15555550123", "http://127.0.0.1:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(prompts.confirm).toHaveBeenCalledWith({
      message: "Try the Signal server URL again?",
      initialValue: true,
    });
    expect(prompts.note).toHaveBeenCalledWith(
      "Signal server URL was not saved. Start or fix the Signal helper, then run setup again.",
      "Signal server URL",
    );
    expect(
      prompts.note.mock.calls.some(([message]) =>
        String(message).includes("Then run: openclaw channels status --probe"),
      ),
    ).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.cancelled).toBe(true);
    expect(result.cfg).toEqual({});
  });

  it("does not save Signal server URL setup when the server probe throws", async () => {
    const probe = vi.fn().mockRejectedValueOnce(new Error("probe exploded"));
    setSignalSetupServerProbeForTest(probe);
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      confirmValues: [false],
      textValues: ["+15555550123", "http://127.0.0.1:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "OpenClaw could not check the Signal server at http://127.0.0.1:8080.",
      ),
      "Signal server URL",
    );
    expect(prompts.note).toHaveBeenCalledWith(
      "Signal server URL was not saved. Start or fix the Signal helper, then run setup again.",
      "Signal server URL",
    );
    expect(prompts.confirm).toHaveBeenCalledWith({
      message: "Try the Signal server URL again?",
      initialValue: true,
    });
    const progress = prompts.progress.mock.results[0]?.value;
    expect(progress?.update).toHaveBeenCalledWith("Testing http://127.0.0.1:8080");
    expect(progress?.stop).toHaveBeenCalledWith();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.cancelled).toBe(true);
    expect(result.cfg).toEqual({});
  });

  it("uses auto mode for existing Signal server setup", async () => {
    setSignalSetupServerProbeForTest(async () => ({ ok: true as const, version: "0.13.22" }));
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      confirmValues: [true],
      textValues: ["+15555550123", "http://signal-cli:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            enabled: true,
            account: "+15555550123",
            httpUrl: "http://signal-cli:8080",
            autoStart: false,
            apiMode: "auto",
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(result.cfg.channels?.signal).toMatchObject({
      account: "+15555550123",
      httpUrl: "http://signal-cli:8080",
      autoStart: false,
      apiMode: "auto",
    });
  });

  it("prompts with existing host and port for Signal server setup", async () => {
    setSignalSetupServerProbeForTest(async () => ({ ok: true as const, version: "0.13.22" }));
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      confirmValues: [true],
      textValues: ["+15555550123", "http://signal-cli:8081"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      cfg: {
        channels: {
          signal: {
            enabled: true,
            account: "+15555550123",
            httpHost: "signal-cli",
            httpPort: 8081,
            autoStart: false,
            apiMode: "auto",
          },
        },
      } as OpenClawConfig,
      prompter: prompts.prompter,
    });

    expect(prompts.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Signal server URL",
        initialValue: "http://signal-cli:8081",
      }),
    );
    expect(result.cfg.channels?.signal).toMatchObject({
      account: "+15555550123",
      httpUrl: "http://signal-cli:8081",
      autoStart: false,
      apiMode: "auto",
    });
  });

  it("keeps native daemon auto-start when non-interactive setup supplies bind options", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {} as OpenClawConfig,
      accountId: "default",
      input: {
        signalNumber: "+15555550123",
        httpHost: "0.0.0.0",
        httpPort: "8081",
      },
    });

    expect(next?.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      httpHost: "0.0.0.0",
      httpPort: 8081,
    });
    expect(next?.channels?.signal?.autoStart).toBe(true);
    expect(next?.channels?.signal?.apiMode).toBe("native");
  });

  it("resets stale container mode for non-interactive external server setup", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            httpUrl: "http://127.0.0.1:18080",
            apiMode: "container",
            autoStart: false,
          },
        },
      } as OpenClawConfig,
      accountId: "default",
      input: {
        httpUrl: "http://127.0.0.1:8080",
      },
    });

    expect(next?.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      httpUrl: "http://127.0.0.1:8080",
      autoStart: false,
      apiMode: "auto",
    });
  });

  it("resets stale container mode for non-interactive native setup", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            httpUrl: "http://127.0.0.1:18080",
            apiMode: "container",
            autoStart: false,
          },
        },
      } as OpenClawConfig,
      accountId: "default",
      input: {
        cliPath: "/usr/local/bin/signal-cli",
      },
    });

    expect(next?.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      cliPath: "/usr/local/bin/signal-cli",
      httpUrl: "",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      autoStart: true,
      apiMode: "native",
    });
  });

  it("lets the native cliPath prompt write before the Signal account prompt", async () => {
    const input = createSignalCliPathTextInput(async () => true);

    const next = await input.applySet?.({
      cfg: {} as OpenClawConfig,
      accountId: "default",
      value: "/usr/local/bin/signal-cli",
    });

    expect(next?.channels?.signal).toMatchObject({
      enabled: true,
      cliPath: "/usr/local/bin/signal-cli",
    });
    expect(next?.channels?.signal?.account).toBeUndefined();
  });

  it("keeps existing Signal server setup as an escape hatch", async () => {
    setSignalSetupServerProbeForTest(async () => ({ ok: true as const, version: "0.13.22" }));
    const prompts = createQueuedWizardPrompter({
      selectValues: ["external-native"],
      textValues: ["+15555550123", "http://signal-cli:8080"],
    });

    const result = await runSetupWizardConfigure({
      configure: configureSignalSetup,
      prompter: prompts.prompter,
    });

    expect(result.cfg.channels?.signal).toMatchObject({
      enabled: true,
      account: "+15555550123",
      httpUrl: "http://signal-cli:8080",
      autoStart: false,
      apiMode: "auto",
    });
    expect(result.cfg.channels?.signal?.cliPath).toBeUndefined();
  });

  it("uses configured defaultAccount for omitted DM policy account context", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          defaultAccount: "work",
          dmPolicy: "disabled",
          allowFrom: ["+15555550123"],
          accounts: {
            work: {
              account: "+15555550999",
              dmPolicy: "allowlist",
            },
          },
        },
      },
    };

    expect(signalDmPolicy.getCurrent(cfg)).toBe("allowlist");
    expect(signalDmPolicy.resolveConfigKeys?.(cfg)).toEqual({
      policyKey: "channels.signal.accounts.work.dmPolicy",
      allowFromKey: "channels.signal.accounts.work.allowFrom",
    });

    const next = signalDmPolicy.setPolicy(cfg, "open");
    expect(next.channels?.signal?.dmPolicy).toBe("disabled");
    expect(next.channels?.signal?.allowFrom).toEqual(["+15555550123"]);
    expect(next.channels?.signal?.accounts?.work?.dmPolicy).toBe("open");
    expect(next.channels?.signal?.accounts?.work?.allowFrom).toEqual(["+15555550123", "*"]);
  });

  it('writes open policy state to the named account and stores inherited allowFrom with "*"', () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          allowFrom: ["+15555550123"],
          accounts: {
            work: {
              account: "+15555550999",
            },
          },
        },
      },
    };

    const next = signalDmPolicy.setPolicy(cfg, "open", "work");

    expect(next.channels?.signal?.dmPolicy).toBeUndefined();
    expect(next.channels?.signal?.allowFrom).toEqual(["+15555550123"]);
    expect(next.channels?.signal?.accounts?.work?.dmPolicy).toBe("open");
    expect(next.channels?.signal?.accounts?.work?.allowFrom).toEqual(["+15555550123", "*"]);
  });
});
