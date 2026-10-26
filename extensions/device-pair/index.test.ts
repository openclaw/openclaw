import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";

const pluginApiMocks = vi.hoisted(() => ({
  clearDeviceBootstrapTokens: vi.fn(async () => ({ removed: 2 })),
  issueDeviceBootstrapToken: vi.fn(async (_params?: { assertCurrent?: () => void }) => ({
    token: "boot-token",
    expiresAtMs: Date.now() + 10 * 60_000,
  })),
  revokeDeviceBootstrapToken: vi.fn(async () => ({ removed: true })),
  resolvePreferredOpenClawTmpDir: vi.fn(() => path.join(os.tmpdir(), "openclaw-device-pair-tests")),
  writeQrPngTempFile: vi.fn(async (dataValue: string, opts: { tmpRoot: string }) => {
    const dirPath = await fs.mkdtemp(path.join(opts.tmpRoot, "device-pair-qr-"));
    const filePath = path.join(dirPath, "pair-qr.png");
    await fs.writeFile(filePath, "fakepng");
    return { filePath, dirPath, mediaLocalRoots: [dirPath] };
  }),
}));

vi.mock("./api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api.js")>()),
  PAIRING_SETUP_BOOTSTRAP_PROFILE: {
    roles: ["node", "operator"],
    scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
  },
  approveDevicePairing: vi.fn(),
  clearDeviceBootstrapTokens: pluginApiMocks.clearDeviceBootstrapTokens,
  definePluginEntry: vi.fn((entry) => entry),
  issueDeviceBootstrapToken: pluginApiMocks.issueDeviceBootstrapToken,
  listDevicePairing: vi.fn(async () => ({ pending: [] })),
  revokeDeviceBootstrapToken: pluginApiMocks.revokeDeviceBootstrapToken,
  resolvePreferredOpenClawTmpDir: pluginApiMocks.resolvePreferredOpenClawTmpDir,
  runPluginCommandWithTimeout: vi.fn(),
  writeQrPngTempFile: pluginApiMocks.writeQrPngTempFile,
}));

vi.mock("./notify.js", () => ({
  armPairNotifyOnce: vi.fn(async () => false),
  formatPendingRequests: vi.fn(() => "No pending device pairing requests."),
  handleNotifyCommand: vi.fn(async () => ({ text: "notify" })),
}));

import { approveDevicePairing, listDevicePairing, runPluginCommandWithTimeout } from "./api.js";
import registerDevicePair from "./index.js";

type ApproveDevicePairingResolved = Awaited<ReturnType<typeof approveDevicePairing>>;
type ApprovedPairingResult = Extract<
  NonNullable<ApproveDevicePairingResolved>,
  { status: "approved" }
>;
type RegisterPairOptions = {
  config?: OpenClawPluginApi["config"];
  runtime?: OpenClawPluginApi["runtime"];
  pluginConfig?: Record<string, unknown>;
};

const gatewayAuth = { mode: "token" as const, token: "gateway-token" };
function gatewayOptions(
  gateway: NonNullable<OpenClawPluginApi["config"]["gateway"]>,
): RegisterPairOptions {
  return {
    config: { gateway: { auth: gatewayAuth, ...gateway } },
    pluginConfig: { publicUrl: undefined },
  };
}

const INTERNAL_PAIRING_SCOPES = ["operator.write", "operator.pairing"];
const INTERNAL_SETUP_SCOPES = [...INTERNAL_PAIRING_SCOPES, "operator.talk.secrets"];
const LIMITED_SETUP_REQUEST = {
  profile: {
    roles: ["node", "operator"],
    scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
  },
};
const FULL_SETUP_REQUEST = {
  profile: {
    roles: ["node", "operator"],
    scopes: [
      "operator.admin",
      "operator.approvals",
      "operator.read",
      "operator.talk.secrets",
      "operator.write",
    ],
    purpose: "mobile-full",
  },
};
const PAIRING_REQUIRED = "⚠️ This command requires operator.pairing.";
const TALK_SECRETS_REQUIRED =
  "⚠️ Setup code handoff includes Talk secrets and requires operator.talk.secrets.";
const SECURE_URL_REQUIRED = "Tailscale and public mobile pairing require a secure gateway URL";

function registerPairCommand(params: RegisterPairOptions = {}): OpenClawPluginCommandDefinition {
  let command: OpenClawPluginCommandDefinition | undefined;
  registerDevicePair.register(
    createTestPluginApi({
      id: "device-pair",
      name: "device-pair",
      source: "test",
      config: params.config ?? { gateway: { auth: gatewayAuth } },
      pluginConfig: { publicUrl: "wss://gateway.example.test", ...params.pluginConfig },
      runtime: (params.runtime ?? {}) as OpenClawPluginApi["runtime"],
      registerCommand: (nextCommand) => {
        command = nextCommand;
      },
    }),
  );
  if (!command) {
    throw new Error("device-pair plugin did not register its /pair command");
  }
  return command;
}

function createCommandContext(params: Partial<PluginCommandContext> = {}): PluginCommandContext {
  const args = params.args ?? "qr";
  return {
    channel: "webchat",
    isAuthorizedSender: true,
    commandBody: `/pair ${args}`.trim(),
    args,
    config: {},
    requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
    ...params,
  };
}

async function runPair(context: Partial<PluginCommandContext>, options: RegisterPairOptions = {}) {
  return await registerPairCommand(options).handler(createCommandContext(context));
}

function requireText(result: { text?: unknown } | null | undefined): string {
  if (typeof result?.text !== "string") {
    throw new Error("pair command did not return a text response");
  }
  return result.text;
}

type SendPayload = { to: string; text: string; mediaUrl?: string; [key: string]: unknown };
function createChannelRuntime(
  channel: string,
  send: (payload: SendPayload) => Promise<unknown>,
): OpenClawPluginApi["runtime"] {
  return {
    channel: {
      outbound: {
        loadAdapter: async (id: string) =>
          id === channel ? { sendText: send, sendMedia: send } : undefined,
      },
    },
  } as unknown as OpenClawPluginApi["runtime"];
}

function ipv4Interfaces(address: string): ReturnType<typeof os.networkInterfaces> {
  return {
    en0: [
      {
        address,
        family: "IPv4",
        internal: false,
        netmask: "255.255.255.0",
        mac: "00:00:00:00:00:00",
        cidr: `${address}/24`,
      },
    ],
  };
}

const device = {
  deviceId: "victim-phone",
  publicKey: "victim-public-key",
  displayName: "Victim Phone",
  platform: "ios",
};
function makeApprovedPairingResult(): ApprovedPairingResult {
  return {
    status: "approved",
    requestId: "req-1",
    device: { ...device, createdAtMs: Date.now(), approvedAtMs: Date.now() },
  };
}

function makeForbiddenPairingResult(): ApproveDevicePairingResolved {
  return {
    status: "forbidden",
    reason: "caller-missing-scope",
    scope: "operator.admin",
  };
}

function mockPendingPairingList() {
  vi.mocked(listDevicePairing).mockResolvedValueOnce({
    pending: [{ ...device, requestId: "req-1", ts: Date.now() }],
    paired: [],
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_GATEWAY_PORT", "18789");
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
  vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
  pluginApiMocks.issueDeviceBootstrapToken.mockResolvedValue({
    token: "boot-token",
    expiresAtMs: Date.now() + 10 * 60_000,
  });
  await fs.mkdir(pluginApiMocks.resolvePreferredOpenClawTmpDir(), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(pluginApiMocks.resolvePreferredOpenClawTmpDir(), { recursive: true, force: true });
});

afterAll(() => {
  vi.doUnmock("./api.js");
  vi.doUnmock("./notify.js");
  vi.resetModules();
});

it("declares bare invocation client presentation without changing remote argument handling", () => {
  const command = registerPairCommand();
  expect(command.acceptsArgs).toBe(true);
  expect(command.clientPresentation).toEqual({
    when: "no-arguments",
    action: { kind: "device-pairing" },
  });
});

describe("device-pair /pair qr", () => {
  it("returns an inline QR image for webchat surfaces", async () => {
    const command = registerPairCommand();
    expect(command.requiredScopes).toEqual(["operator.pairing"]);
    const result = await command.handler(
      createCommandContext({ channel: "webchat", gatewayClientScopes: ["operator.admin"] }),
    );
    const payload = result as {
      text?: string;
      mediaUrl?: string;
      channelData?: Record<string, unknown>;
      sensitiveMedia?: boolean;
    };
    const text = requireText(result);

    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledWith(FULL_SETUP_REQUEST);
    expect(text).toContain("Scan this QR code with the OpenClaw iOS app:");
    expect(payload.mediaUrl).toBeUndefined();
    expect(payload.channelData?.openclawPairingQr).toEqual({
      setupCode: expect.any(String),
      expiresAtMs: expect.any(Number),
    });
    expect(payload.sensitiveMedia).toBe(true);
    expect(text).toContain("- Security: single-use bootstrap token");
    expect(text).toContain("**Important:** Run `/pair cleanup` after pairing finishes.");
    expect(text).toContain("If this QR code leaks, run `/pair cleanup` immediately.");
    expect(text).not.toContain("![OpenClaw pairing QR]");
  });

  it.each`
    name                                           | channel       | context                                                                                  | target                   | opts
    ${"sends Telegram a real QR image attachment"} | ${"telegram"} | ${{ senderId: "123", accountId: "default", messageThreadId: 271 }}                       | ${"123"}                 | ${{ accountId: "default", threadId: 271 }}
    ${"sends Discord a real QR image attachment"}  | ${"discord"}  | ${{ senderId: "123", accountId: "default" }}                                             | ${"user:123"}            | ${{ accountId: "default" }}
    ${"sends Slack a real QR image attachment"}    | ${"slack"}    | ${{ senderId: "user:U123", accountId: "default", messageThreadId: "1234567890.000001" }} | ${"user:U123"}           | ${{ accountId: "default", threadId: "1234567890.000001" }}
    ${"sends Signal a real QR image attachment"}   | ${"signal"}   | ${{ senderId: "signal:+15551234567", accountId: "default" }}                             | ${"signal:+15551234567"} | ${{ accountId: "default" }}
    ${"sends iMessage a real QR image attachment"} | ${"imessage"} | ${{ senderId: "+15551234567", accountId: "default" }}                                    | ${"+15551234567"}        | ${{ accountId: "default" }}
    ${"sends WhatsApp a real QR image attachment"} | ${"whatsapp"} | ${{ senderId: "+15551234567", accountId: "default" }}                                    | ${"+15551234567"}        | ${{ accountId: "default", verbose: false }}
  `("$name", async ({ channel, context, target, opts }) => {
    let sentPng = "";
    const sendMessage = vi.fn(async (payload: SendPayload) => {
      if (payload.mediaUrl) {
        sentPng = await fs.readFile(payload.mediaUrl, "utf8");
      }
      return { messageId: "1" };
    });
    const result = await runPair(
      { channel, ...context, gatewayClientScopes: INTERNAL_SETUP_SCOPES },
      { runtime: createChannelRuntime(channel, sendMessage) },
    );
    const text = requireText(result);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const payload = sendMessage.mock.calls[0]![0];
    const caption = payload.text;
    expect(caption).toContain("Scan this QR code with the OpenClaw iOS app:");
    expect(caption).toContain("IMPORTANT: After pairing finishes, run /pair cleanup.");
    expect(caption).toContain("If this QR code leaks, run /pair cleanup immediately.");
    const mediaUrl = requireText({ text: payload.mediaUrl });
    expect(mediaUrl).toMatch(/pair-qr\.png$/);
    expect(payload).toEqual({
      to: target,
      text: caption,
      cfg: { gateway: { auth: { mode: "token", token: "gateway-token" } } },
      mediaUrl,
      mediaLocalRoots: [path.dirname(mediaUrl)],
      ...opts,
    });
    expect(sentPng).toBe("fakepng");
    await expect(fs.access(mediaUrl)).rejects.toMatchObject({ code: "ENOENT" });
    expect(text).toContain("QR code sent above.");
    expect(text).toContain("IMPORTANT: Run /pair cleanup after pairing finishes.");
  });

  it("reissues the bootstrap token after QR delivery failure before falling back", async () => {
    pluginApiMocks.issueDeviceBootstrapToken
      .mockResolvedValueOnce({ token: "first-token", expiresAtMs: Date.now() + 10 * 60_000 })
      .mockResolvedValueOnce({ token: "second-token", expiresAtMs: Date.now() + 10 * 60_000 });
    const sendMessage = vi.fn().mockRejectedValue(new Error("upload failed"));
    const text = requireText(
      await runPair(
        {
          channel: "discord",
          senderId: "123",
          gatewayClientScopes: INTERNAL_SETUP_SCOPES,
        },
        { runtime: createChannelRuntime("discord", sendMessage) },
      ),
    );

    expect(pluginApiMocks.revokeDeviceBootstrapToken).toHaveBeenCalledWith({
      token: "first-token",
    });
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledTimes(2);
    expect(text).toContain("Pairing setup code generated.");
    expect(text).toContain("If this code leaks or you are done, run /pair cleanup");
  });

  it("requires QR channel senders to be own entries", async () => {
    const loadAdapter = vi.fn(async () => undefined);
    const text = requireText(
      await runPair(
        {
          channel: "__proto__",
          senderId: "prototype-channel",
          gatewayClientScopes: INTERNAL_SETUP_SCOPES,
        },
        {
          runtime: {
            channel: { outbound: { loadAdapter } },
          } as unknown as OpenClawPluginApi["runtime"],
        },
      ),
    );
    expect(pluginApiMocks.writeQrPngTempFile).not.toHaveBeenCalled();
    expect(loadAdapter).not.toHaveBeenCalled();
    expect(pluginApiMocks.revokeDeviceBootstrapToken).not.toHaveBeenCalled();
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
    expect(text).toContain("QR image delivery is not available on this channel");
    expect(text).toContain("Setup code:");
    expect(text).toContain("IMPORTANT: After pairing finishes, run /pair cleanup.");
    expect(text).not.toContain("```");
  });

  it("supports invalidating unused setup codes", async () => {
    const result = await runPair({
      channel: "telegram",
      args: "cleanup",
      gatewayClientScopes: INTERNAL_PAIRING_SCOPES,
    });
    expect(pluginApiMocks.clearDeviceBootstrapTokens).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ text: "Invalidated 2 unused setup codes." });
  });
});

describe("device-pair /pair setup", () => {
  const trustedProxy = {
    config: {
      gateway: {
        auth: { mode: "trusted-proxy" as const, trustedProxy: { userHeader: "x-forwarded-user" } },
      },
    },
  };
  const pub = (
    publicUrl: string,
    gateway: NonNullable<OpenClawPluginApi["config"]["gateway"]> = {},
  ): RegisterPairOptions => ({
    ...gatewayOptions(gateway),
    pluginConfig: { publicUrl },
  });
  function discoverDns() {
    vi.mocked(runPluginCommandWithTimeout).mockResolvedValueOnce({
      code: 0,
      stdout: '{"Self":{"DNSName":"gateway.tailnet.ts.net"}}',
      stderr: "",
    });
  }
  const network = (address: string) => () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValueOnce(ipv4Interfaces(address));
  };
  type SetupRow = {
    label: string;
    options: RegisterPairOptions;
    context: Partial<PluginCommandContext>;
    text: string | string[];
    issued: 0 | 1 | typeof LIMITED_SETUP_REQUEST | typeof FULL_SETUP_REQUEST;
    prepare?: () => void;
    absent?: string;
    noDiscovery?: boolean;
  };
  it.each`
    label                                                  | options                                                                                                          | context                                                                                                   | text                                                                                                 | issued                   | prepare                     | absent                                      | noDiscovery
    ${"trusted admin"}                                     | ${trustedProxy}                                                                                                  | ${{ gatewayClientScopes: ["operator.admin"] }}                                                            | ${["Auth: trusted-proxy"]}                                                                           | ${FULL_SETUP_REQUEST}    | ${undefined}                | ${undefined}                                | ${false}
    ${"trusted limited"}                                   | ${trustedProxy}                                                                                                  | ${{}}                                                                                                     | ${["Auth: trusted-proxy"]}                                                                           | ${LIMITED_SETUP_REQUEST} | ${undefined}                | ${undefined}                                | ${false}
    ${"trusted owner"}                                     | ${trustedProxy}                                                                                                  | ${{ channel: "discord", gatewayClientScopes: undefined, senderIsOwner: true }}                            | ${["Auth: trusted-proxy"]}                                                                           | ${FULL_SETUP_REQUEST}    | ${undefined}                | ${undefined}                                | ${false}
    ${"trusted non-owner"}                                 | ${trustedProxy}                                                                                                  | ${{ channel: "discord", gatewayClientScopes: undefined, senderIsOwner: false }}                           | ${PAIRING_REQUIRED}                                                                                  | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"trusted read-only"}                                 | ${trustedProxy}                                                                                                  | ${{ gatewayClientScopes: ["operator.read"] }}                                                             | ${PAIRING_REQUIRED}                                                                                  | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"trusted no Talk scope"}                             | ${trustedProxy}                                                                                                  | ${{ gatewayClientScopes: INTERNAL_PAIRING_SCOPES }}                                                       | ${TALK_SECRETS_REQUIRED}                                                                             | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"trusted no scopes"}                                 | ${trustedProxy}                                                                                                  | ${{ gatewayClientScopes: undefined }}                                                                     | ${PAIRING_REQUIRED}                                                                                  | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"QR owner with no Talk scope"}                       | ${{}}                                                                                                            | ${{ args: "qr", channel: "telegram", senderIsOwner: true, gatewayClientScopes: INTERNAL_PAIRING_SCOPES }} | ${TALK_SECRETS_REQUIRED}                                                                             | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"cleanup with no scopes"}                            | ${{}}                                                                                                            | ${{ args: "cleanup", gatewayClientScopes: undefined }}                                                    | ${PAIRING_REQUIRED}                                                                                  | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"external status with no scopes"}                    | ${{}}                                                                                                            | ${{ args: "status", channel: "telegram", gatewayClientScopes: undefined }}                                | ${PAIRING_REQUIRED}                                                                                  | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"unknown subcommand"}                                | ${{}}                                                                                                            | ${{ args: "foo", gatewayClientScopes: ["operator.write"] }}                                               | ${PAIRING_REQUIRED}                                                                                  | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"approval read-only"}                                | ${{}}                                                                                                            | ${{ args: "approve latest", gatewayClientScopes: ["operator.write"] }}                                    | ${PAIRING_REQUIRED}                                                                                  | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"approval no scopes"}                                | ${{}}                                                                                                            | ${{ args: "approve latest", gatewayClientScopes: undefined }}                                             | ${PAIRING_REQUIRED}                                                                                  | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"approval non-owner"}                                | ${{}}                                                                                                            | ${{ args: "approve latest", channel: "telegram", gatewayClientScopes: undefined, senderIsOwner: false }}  | ${PAIRING_REQUIRED}                                                                                  | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"unauthenticated gateway"}                           | ${gatewayOptions({ auth: { mode: "none" } })}                                                                    | ${{}}                                                                                                     | ${["Gateway auth is not configured"]}                                                                | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"external token owner"}                              | ${{}}                                                                                                            | ${{ channel: "telegram", gatewayClientScopes: undefined, senderIsOwner: true }}                           | ${["Pairing setup code generated."]}                                                                 | ${FULL_SETUP_REQUEST}    | ${undefined}                | ${undefined}                                | ${false}
    ${"bare secure URL"}                                   | ${pub("gateway.example.test:18789/setup", { tls: { enabled: true } })}                                           | ${{ gatewayClientScopes: ["operator.admin"] }}                                                            | ${["Gateway: wss://gateway.example.test:18789"]}                                                     | ${1}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"loopback"}                                          | ${pub("ws://127.0.0.1:18789")}                                                                                   | ${{}}                                                                                                     | ${["Gateway: ws://127.0.0.1:18789"]}                                                                 | ${1}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"mdns"}                                              | ${pub("ws://openclaw.local:18789")}                                                                              | ${{}}                                                                                                     | ${["Gateway: ws://openclaw.local:18789"]}                                                            | ${1}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"IPv6 ULA"}                                          | ${pub("ws://[fc00::1]:18789")}                                                                                   | ${{}}                                                                                                     | ${["Gateway: ws://[fc00::1]:18789"]}                                                                 | ${1}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"IPv6 link-local lower"}                             | ${pub("ws://[fe80::1]:18789")}                                                                                   | ${{}}                                                                                                     | ${["Gateway: ws://[fe80::1]:18789"]}                                                                 | ${1}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"IPv6 link-local upper"}                             | ${pub("ws://[febf::1]:18789")}                                                                                   | ${{}}                                                                                                     | ${["Gateway: ws://[febf::1]:18789"]}                                                                 | ${1}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"Tailscale Serve"}                                   | ${gatewayOptions({ tailscale: { mode: "serve" } })}                                                              | ${{}}                                                                                                     | ${["Gateway: wss://gateway.tailnet.ts.net"]}                                                         | ${1}                     | ${discoverDns}              | ${undefined}                                | ${false}
    ${"publicOrigin"}                                      | ${gatewayOptions({ bind: "loopback", publicOrigin: "https://gateway.example.test" })}                            | ${{}}                                                                                                     | ${["Gateway: wss://gateway.example.test"]}                                                           | ${1}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"limited secure caller"}                             | ${{}}                                                                                                            | ${{}}                                                                                                     | ${["Access: limited"]}                                                                               | ${LIMITED_SETUP_REQUEST} | ${undefined}                | ${"Plaintext ws:// was limited for safety"} | ${false}
    ${"private LAN admin"}                                 | ${pub("ws://192.168.1.20:18789")}                                                                                | ${{ gatewayClientScopes: ["operator.admin"] }}                                                            | ${["Gateway: ws://192.168.1.20:18789", "Access: limited", "Plaintext ws:// was limited for safety"]} | ${LIMITED_SETUP_REQUEST} | ${undefined}                | ${undefined}                                | ${false}
    ${"trusted private LAN admin"}                         | ${{ ...trustedProxy, pluginConfig: { publicUrl: "ws://192.168.1.20:18789" } }}                                   | ${{ gatewayClientScopes: ["operator.admin"] }}                                                            | ${["Access: limited"]}                                                                               | ${LIMITED_SETUP_REQUEST} | ${undefined}                | ${undefined}                                | ${false}
    ${"trusted public plaintext"}                          | ${{ ...trustedProxy, pluginConfig: { publicUrl: "ws://gateway.example.test" } }}                                 | ${{}}                                                                                                     | ${[SECURE_URL_REQUIRED]}                                                                             | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"LAN 10.211.55.3"}                                   | ${gatewayOptions({ bind: "lan" })}                                                                               | ${{}}                                                                                                     | ${["Gateway: ws://10.211.55.3:18789"]}                                                               | ${1}                     | ${network("10.211.55.3")}   | ${"Fallback:"}                              | ${true}
    ${"LAN 192.168.139.3"}                                 | ${gatewayOptions({ bind: "lan" })}                                                                               | ${{}}                                                                                                     | ${["Gateway: ws://192.168.139.3:18789"]}                                                             | ${1}                     | ${network("192.168.139.3")} | ${"Fallback:"}                              | ${true}
    ${"custom bind"}                                       | ${gatewayOptions({ bind: "custom", customBindHost: "192.168.139.3" })}                                           | ${{}}                                                                                                     | ${["Gateway: ws://192.168.139.3:18789"]}                                                             | ${1}                     | ${undefined}                | ${"Fallback:"}                              | ${false}
    ${"reject ws://0.0.0.0:18789"}                         | ${pub("ws://0.0.0.0:18789")}                                                                                     | ${{}}                                                                                                     | ${[SECURE_URL_REQUIRED]}                                                                             | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"reject ws://[::]:18789"}                            | ${pub("ws://[::]:18789")}                                                                                        | ${{}}                                                                                                     | ${[SECURE_URL_REQUIRED]}                                                                             | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"reject ws://gateway.example.test:18789"}            | ${pub("ws://gateway.example.test:18789")}                                                                        | ${{}}                                                                                                     | ${[SECURE_URL_REQUIRED]}                                                                             | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"reject ws://[2001:db8::1]:18789"}                   | ${pub("ws://[2001:db8::1]:18789")}                                                                               | ${{}}                                                                                                     | ${[SECURE_URL_REQUIRED]}                                                                             | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"reject ws://[fe7f::1]:18789"}                       | ${pub("ws://[fe7f::1]:18789")}                                                                                   | ${{}}                                                                                                     | ${[SECURE_URL_REQUIRED]}                                                                             | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"reject ws://[fec0::1]:18789"}                       | ${pub("ws://[fec0::1]:18789")}                                                                                   | ${{}}                                                                                                     | ${[SECURE_URL_REQUIRED]}                                                                             | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"plaintext tailnet"}                                 | ${gatewayOptions({ bind: "tailnet" })}                                                                           | ${{}}                                                                                                     | ${["prefer gateway.tailscale.mode=serve"]}                                                           | ${0}                     | ${network("100.64.0.9")}    | ${undefined}                                | ${false}
    ${"invalid remote URL"}                                | ${gatewayOptions({ bind: "custom", customBindHost: "127.0.0.1", remote: { url: "http://localhost:notaport" } })} | ${{}}                                                                                                     | ${"Error: Configured gateway.remote.url is invalid."}                                                | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"invalid localhost:notaport"}                        | ${pub("localhost:notaport")}                                                                                     | ${{}}                                                                                                     | ${"Error: Configured publicUrl is invalid."}                                                         | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"invalid http://localhost:notaport"}                 | ${pub("http://localhost:notaport")}                                                                              | ${{}}                                                                                                     | ${"Error: Configured publicUrl is invalid."}                                                         | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"invalid http:gateway.example.test"}                 | ${pub("http:gateway.example.test")}                                                                              | ${{}}                                                                                                     | ${"Error: Configured publicUrl is invalid."}                                                         | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"invalid ftp:/gateway.example.test"}                 | ${pub("ftp:/gateway.example.test")}                                                                              | ${{}}                                                                                                     | ${"Error: Configured publicUrl is invalid."}                                                         | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
    ${"invalid ws://user:pass@gateway.example.test:18789"} | ${pub("ws://user:pass@gateway.example.test:18789")}                                                              | ${{}}                                                                                                     | ${"Error: Configured publicUrl is invalid."}                                                         | ${0}                     | ${undefined}                | ${undefined}                                | ${false}
  `(
    "$label",
    async ({ options, context, text, issued, prepare, absent, noDiscovery }: SetupRow) => {
      prepare?.();
      const result = await runPair(
        { args: "", gatewayClientScopes: INTERNAL_SETUP_SCOPES, ...context },
        options,
      );
      if (typeof text === "string") {
        expect(result).toEqual({ text });
      } else {
        for (const part of text) {
          expect(requireText(result)).toContain(part);
        }
      }
      if (issued === 0) {
        expect(pluginApiMocks.issueDeviceBootstrapToken).not.toHaveBeenCalled();
        expect(listDevicePairing).not.toHaveBeenCalled();
        expect(approveDevicePairing).not.toHaveBeenCalled();
        expect(pluginApiMocks.clearDeviceBootstrapTokens).not.toHaveBeenCalled();
      } else if (issued === 1) {
        expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
      } else {
        expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledExactlyOnceWith(issued);
      }
      if (absent) {
        expect(requireText(result)).not.toContain(absent);
      }
      if (noDiscovery) {
        expect(runPluginCommandWithTimeout).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    "rechecks channel ownership after Gateway URL discovery (gateway admin: %s)",
    async (gatewayAdmin) => {
      let current = true;
      const ctx = createCommandContext({
        channel: "discord",
        args: "",
        gatewayClientScopes: gatewayAdmin ? ["operator.admin"] : undefined,
        senderIsOwner: true,
        assertOwnerCurrent: () => {
          if (!current) {
            throw new Error("original owner revoked");
          }
        },
      });
      vi.mocked(runPluginCommandWithTimeout).mockImplementationOnce(async () => {
        current = false;
        ctx.assertOwnerCurrent = () => {};
        return { code: 0, stdout: '{"Self":{"DNSName":"gateway.tailnet.ts.net"}}', stderr: "" };
      });
      let issued = false;
      pluginApiMocks.issueDeviceBootstrapToken.mockImplementationOnce(async (params) => {
        params?.assertCurrent?.();
        issued = true;
        return { token: "boot-token", expiresAtMs: Date.now() + 60_000 };
      });
      const pending = registerPairCommand(gatewayOptions({ tailscale: { mode: "serve" } })).handler(
        ctx,
      );
      if (gatewayAdmin) {
        await expect(pending).resolves.toMatchObject({
          text: expect.stringContaining("Pairing setup code generated"),
        });
      } else {
        await expect(pending).rejects.toThrow("original owner revoked");
      }
      expect(issued).toBe(gatewayAdmin);
    },
  );

  it.each(["publicUrl", "remote"] as const)(
    "keeps /pair setup codes origin-only for a path-qualified %s",
    async (source) => {
      const result = await runPair(
        { args: "", gatewayClientScopes: INTERNAL_SETUP_SCOPES },
        {
          ...gatewayOptions(
            source === "remote" ? { remote: { url: "https://pair.example/extra" } } : {},
          ),
          pluginConfig: {
            publicUrl: source === "publicUrl" ? "https://pair.example/extra" : undefined,
          },
        },
      );
      const text = requireText(result);
      const code = text.match(/Setup code:\n([A-Za-z0-9_-]+)/u)?.[1];
      if (!code) {
        throw new Error("Missing setup code in /pair reply");
      }
      expect(JSON.parse(Buffer.from(code, "base64url").toString("utf8"))).toMatchObject({
        url: "wss://pair.example",
        bootstrapToken: "boot-token",
      });
      expect(text.split("\n")).toContain("Gateway: wss://pair.example");
    },
  );
});

describe("device-pair notify pending formatting", () => {
  it.each`
    request                                                                                                                                                                           | fragments
    ${{ requestId: "req-1", deviceId: "device-1", displayName: "dev one", platform: "ios", role: "operator", scopes: ["operator.admin", "operator.read"], remoteIp: "198.51.100.2" }} | ${["Pending device pairing requests:", "name=dev one", "platform=ios", "role=operator", "scopes=operator.admin, operator.read", "ip=198.51.100.2"]}
    ${{ requestId: "req-2", deviceId: "device-2", roles: ["node", "operator"], scopes: [] }}                                                                                          | ${["role=node, operator", "scopes=none"]}
  `(
    "formats $request.requestId",
    async ({
      request,
      fragments,
    }: {
      request: Parameters<typeof import("./notify.js").formatPendingRequests>[0][number];
      fragments: string[];
    }) => {
      const { formatPendingRequests } =
        await vi.importActual<typeof import("./notify.js")>("./notify.js");
      const text = formatPendingRequests([request]);
      for (const fragment of fragments) {
        expect(text).toContain(fragment);
      }
    },
  );
});

describe("device-pair /pair approve", () => {
  it.each`
    name                                                                    | context                                                                                       | approved                      | expectedCall               | expectedText
    ${"allows internal gateway callers with operator.pairing"}              | ${{ channel: "webchat", gatewayClientScopes: INTERNAL_PAIRING_SCOPES }}                       | ${makeApprovedPairingResult}  | ${INTERNAL_PAIRING_SCOPES} | ${"✅ Paired Victim Phone (ios)."}
    ${"allows command owners to approve from non-gateway command surfaces"} | ${{ channel: "telegram", gatewayClientScopes: undefined, senderIsOwner: true }}               | ${makeApprovedPairingResult}  | ${["operator.pairing"]}    | ${"✅ Paired Victim Phone (ios)."}
    ${"preserves gateway caller scopes for command-owner approvals"}        | ${{ channel: "telegram", gatewayClientScopes: INTERNAL_PAIRING_SCOPES, senderIsOwner: true }} | ${makeApprovedPairingResult}  | ${INTERNAL_PAIRING_SCOPES} | ${"✅ Paired Victim Phone (ios)."}
    ${"rejects approvals that request scopes above the caller session"}     | ${{ channel: "webchat", gatewayClientScopes: INTERNAL_PAIRING_SCOPES }}                       | ${makeForbiddenPairingResult} | ${INTERNAL_PAIRING_SCOPES} | ${"⚠️ This command requires operator.admin to approve this pairing request."}
  `("$name", async ({ context, approved, expectedCall, expectedText }) => {
    mockPendingPairingList();
    vi.mocked(approveDevicePairing).mockResolvedValueOnce(approved());
    const result = await runPair({
      ...context,
      args: "approve latest",
    });
    expect(approveDevicePairing).toHaveBeenCalledWith("req-1", {
      callerScopes: expectedCall,
    });
    expect(result).toEqual({ text: expectedText });
  });
});
