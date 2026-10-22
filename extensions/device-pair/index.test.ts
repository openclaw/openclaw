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

async function runDefaultSetup(
  options: RegisterPairOptions = {},
  context: Partial<PluginCommandContext> = {},
) {
  return runPair({ args: "", gatewayClientScopes: INTERNAL_SETUP_SCOPES, ...context }, options);
}

async function expectSetupRejected(
  options: RegisterPairOptions,
  expectedText: string,
  exact = false,
): Promise<void> {
  const result = await runDefaultSetup(options);
  expect(pluginApiMocks.issueDeviceBootstrapToken).not.toHaveBeenCalled();
  if (exact) {
    expect(result).toEqual({ text: expectedText });
  } else {
    expect(requireText(result)).toContain(expectedText);
  }
}

function requireText(result: { text?: unknown } | null | undefined): string {
  if (typeof result?.text !== "string") {
    throw new Error("pair command did not return a text response");
  }
  return result.text;
}

async function expectRejectedCommand(
  context: Partial<PluginCommandContext>,
  untouched: unknown,
  text = PAIRING_REQUIRED,
): Promise<void> {
  expect(await runPair(context)).toEqual({ text });
  expect(untouched).not.toHaveBeenCalled();
}

function createChannelRuntime(
  channel: string,
  sendMessage: (...args: unknown[]) => Promise<unknown>,
): OpenClawPluginApi["runtime"] {
  return {
    channel: {
      outbound: {
        loadAdapter: async (channelId: string) =>
          channelId === channel
            ? {
                sendText: async ({ to, text, ...opts }: Record<string, unknown>) =>
                  await sendMessage(to, text, opts),
                sendMedia: async ({ to, text, ...opts }: Record<string, unknown>) =>
                  await sendMessage(to, text, opts),
              }
            : undefined,
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

  it("rejects qr setup for scoped command owners without Talk secret scope", async () => {
    await expectRejectedCommand(
      { channel: "telegram", senderIsOwner: true, gatewayClientScopes: INTERNAL_PAIRING_SCOPES },
      pluginApiMocks.issueDeviceBootstrapToken,
      TALK_SECRETS_REQUIRED,
    );
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
    const sendMessage = vi.fn().mockImplementation(async (_target, _caption, sendOpts) => {
      if (sendOpts?.mediaUrl) {
        sentPng = await fs.readFile(sendOpts.mediaUrl, "utf8");
      }
      return { messageId: "1" };
    });
    const result = await runPair(
      { channel, ...context, gatewayClientScopes: INTERNAL_SETUP_SCOPES },
      { runtime: createChannelRuntime(channel, sendMessage) },
    );
    const text = requireText(result);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [actualTarget, caption, sendOpts] = sendMessage.mock.calls[0] as [
      string,
      string,
      { mediaUrl?: string; mediaLocalRoots?: string[]; accountId?: string } & Record<
        string,
        unknown
      >,
    ];
    expect(actualTarget).toBe(target);
    expect(caption).toContain("Scan this QR code with the OpenClaw iOS app:");
    expect(caption).toContain("IMPORTANT: After pairing finishes, run /pair cleanup.");
    expect(caption).toContain("If this QR code leaks, run /pair cleanup immediately.");
    const mediaUrl = requireText({ text: sendOpts.mediaUrl });
    expect(mediaUrl).toMatch(/pair-qr\.png$/);
    expect(sendOpts).toEqual({
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

  it.each`
    name                                                                        | context                                                                    | untouched
    ${"fails closed for cleanup when internal gateway scopes are absent"}       | ${{ channel: "webchat", args: "cleanup", gatewayClientScopes: undefined }} | ${pluginApiMocks.clearDeviceBootstrapTokens}
    ${"rejects status for non-gateway command surfaces without pairing scopes"} | ${{ channel: "telegram", args: "status", gatewayClientScopes: undefined }} | ${listDevicePairing}
  `("$name", async ({ context, untouched }) => {
    await expectRejectedCommand(context, untouched);
  });
});

describe("device-pair /pair default setup code", () => {
  describe("trusted-proxy setup", () => {
    const config: OpenClawPluginApi["config"] = {
      gateway: {
        auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-forwarded-user" } },
      },
    };

    beforeEach(() => {
      vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
      vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
    });
    afterEach(() => vi.unstubAllEnvs());

    it.each([
      { scopes: ["operator.admin"], expected: FULL_SETUP_REQUEST },
      { scopes: INTERNAL_SETUP_SCOPES, expected: LIMITED_SETUP_REQUEST },
    ])("preserves issuer grants for $scopes", async ({ scopes, expected }) => {
      const text = requireText(await runDefaultSetup({ config }, { gatewayClientScopes: scopes }));
      expect(text).toContain("Auth: trusted-proxy");
      expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledExactlyOnceWith(expected);
    });

    it.each([
      { scopes: ["operator.read"], message: PAIRING_REQUIRED },
      { scopes: INTERNAL_PAIRING_SCOPES, message: TALK_SECRETS_REQUIRED },
      { scopes: undefined, message: PAIRING_REQUIRED },
    ])("rejects unauthorized setup from $scopes", async ({ scopes, message }) => {
      expect(await runDefaultSetup({ config }, { gatewayClientScopes: scopes })).toEqual({
        text: message,
      });
      expect(pluginApiMocks.issueDeviceBootstrapToken).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      "preserves external command-owner authority (%s)",
      async (senderIsOwner) => {
        const result = await runDefaultSetup(
          { config },
          {
            channel: "discord",
            gatewayClientScopes: undefined,
            senderIsOwner,
          },
        );
        if (senderIsOwner) {
          expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledExactlyOnceWith(
            FULL_SETUP_REQUEST,
          );
          expect(requireText(result)).toContain("Auth: trusted-proxy");
        } else {
          expect(result).toEqual({ text: PAIRING_REQUIRED });
          expect(pluginApiMocks.issueDeviceBootstrapToken).not.toHaveBeenCalled();
        }
      },
    );

    it("keeps plaintext LAN handoff limited and rejects public plaintext", async () => {
      const text = requireText(
        await runDefaultSetup(
          { config, pluginConfig: { publicUrl: "ws://192.168.1.20:18789" } },
          { gatewayClientScopes: ["operator.admin"] },
        ),
      );
      expect(text).toContain("Access: limited");
      expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledExactlyOnceWith(
        LIMITED_SETUP_REQUEST,
      );
      pluginApiMocks.issueDeviceBootstrapToken.mockClear();
      await expectSetupRejected(
        { config, pluginConfig: { publicUrl: "ws://gateway.example.test" } },
        SECURE_URL_REQUIRED,
      );
    });

    it("still rejects unauthenticated gateways", async () => {
      await expectSetupRejected(
        { config: { gateway: { auth: { mode: "none" } } } },
        "Gateway auth is not configured",
      );
    });
  });

  it("rejects unknown subcommands without operator.pairing", async () => {
    await expectRejectedCommand(
      { args: "foo", gatewayClientScopes: ["operator.write"] },
      pluginApiMocks.issueDeviceBootstrapToken,
    );
  });

  it("allows command owners to issue setup codes from non-gateway command surfaces", async () => {
    const text = requireText(
      await runPair({
        channel: "telegram",
        args: "",
        gatewayClientScopes: undefined,
        senderIsOwner: true,
      }),
    );
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledWith(FULL_SETUP_REQUEST);
    expect(text).toContain("Pairing setup code generated.");
  });

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

  it.each<{
    label: string;
    options?: RegisterPairOptions;
    url: string;
    admin?: boolean;
    tailscale?: boolean;
  }>([
    {
      label: "secure bare host port",
      url: "wss://gateway.example.test:18789",
      admin: true,
      options: {
        config: { gateway: { tls: { enabled: true }, auth: gatewayAuth } },
        pluginConfig: { publicUrl: "gateway.example.test:18789/setup" },
      },
    },
    { label: "loopback", url: "ws://127.0.0.1:18789" },
    { label: "mdns", url: "ws://openclaw.local:18789" },
    { label: "IPv6 ULA", url: "ws://[fc00::1]:18789" },
    { label: "IPv6 link-local lower bound", url: "ws://[fe80::1]:18789" },
    { label: "IPv6 link-local upper bound", url: "ws://[febf::1]:18789" },
    {
      label: "Tailscale Serve MagicDNS",
      url: "wss://gateway.tailnet.ts.net",
      tailscale: true,
      options: gatewayOptions({ tailscale: { mode: "serve" } }),
    },
    {
      label: "publicOrigin on loopback",
      url: "wss://gateway.example.test",
      options: gatewayOptions({ bind: "loopback", publicOrigin: "https://gateway.example.test" }),
    },
  ])("issues setup codes through $label", async ({ options, url, admin, tailscale }) => {
    if (tailscale) {
      vi.mocked(runPluginCommandWithTimeout).mockResolvedValueOnce({
        code: 0,
        stdout: '{"Self":{"DNSName":"gateway.tailnet.ts.net"}}',
        stderr: "",
      });
    }
    const text = requireText(
      await runDefaultSetup(
        options ?? { pluginConfig: { publicUrl: url } },
        admin ? { gatewayClientScopes: ["operator.admin"] } : {},
      ),
    );
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
    expect(text).toContain(`Gateway: ${url}`);
  });

  it.each(["publicUrl", "remote"] as const)(
    "keeps /pair setup codes origin-only for a path-qualified %s",
    async (source) => {
      const text = requireText(
        await runDefaultSetup({
          ...gatewayOptions(
            source === "remote" ? { remote: { url: "https://pair.example/extra" } } : {},
          ),
          pluginConfig: {
            publicUrl: source === "publicUrl" ? "https://pair.example/extra" : undefined,
          },
        }),
      );
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

  it("keeps secure setup limited for non-admin gateway callers", async () => {
    const text = requireText(await runDefaultSetup());
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledWith(LIMITED_SETUP_REQUEST);
    expect(text).toContain("Access: limited");
    expect(text).not.toContain("Plaintext ws:// was limited for safety");
  });

  it("allows private LAN cleartext setup urls", async () => {
    const text = requireText(
      await runDefaultSetup(
        { pluginConfig: { publicUrl: "ws://192.168.1.20:18789" } },
        { gatewayClientScopes: ["operator.admin"] },
      ),
    );
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledWith(LIMITED_SETUP_REQUEST);
    expect(text).toContain("Gateway: ws://192.168.1.20:18789");
    expect(text).toContain("Access: limited");
    expect(text).toContain("Plaintext ws:// was limited for safety");
  });

  it.each(["10.211.55.3", "192.168.139.3"])(
    "advertises LAN address %s without legacy Serve fallbacks",
    async (address) => {
      vi.spyOn(os, "networkInterfaces").mockReturnValueOnce(ipv4Interfaces(address));
      const text = requireText(await runDefaultSetup(gatewayOptions({ bind: "lan" })));
      expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledTimes(1);
      expect(text).toContain(`Gateway: ws://${address}:18789`);
      expect(text).not.toContain("Fallback:");
      expect(runPluginCommandWithTimeout).not.toHaveBeenCalled();
    },
  );

  it("does not advertise a loopback Serve route for a custom bind", async () => {
    const text = requireText(
      await runDefaultSetup(gatewayOptions({ bind: "custom", customBindHost: "192.168.139.3" })),
    );
    expect(text).toContain("Gateway: ws://192.168.139.3:18789");
    expect(text).not.toContain("Fallback:");
  });

  it.each([
    "ws://0.0.0.0:18789",
    "ws://[::]:18789",
    "ws://gateway.example.test:18789",
    "ws://[2001:db8::1]:18789",
    "ws://[fe7f::1]:18789",
    "ws://[fec0::1]:18789",
  ])("rejects non-LAN cleartext setup url %s before issuing setup codes", async (publicUrl) => {
    await expectSetupRejected({ pluginConfig: { publicUrl } }, SECURE_URL_REQUIRED);
  });

  it("rejects tailnet cleartext setup urls before issuing setup codes", async () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValueOnce(ipv4Interfaces("100.64.0.9"));
    await expectSetupRejected(
      gatewayOptions({ bind: "tailnet" }),
      "prefer gateway.tailscale.mode=serve",
    );
  });

  it("rejects invalid gateway.remote.url before falling back to bind-derived setup urls", async () => {
    await expectSetupRejected(
      gatewayOptions({
        bind: "custom",
        customBindHost: "127.0.0.1",
        remote: { url: "http://localhost:notaport" },
      }),
      "Error: Configured gateway.remote.url is invalid.",
      true,
    );
  });

  it.each([
    "localhost:notaport",
    "http://localhost:notaport",
    "http:gateway.example.test",
    "ftp:/gateway.example.test",
    "ws://user:pass@gateway.example.test:18789",
  ])("rejects invalid publicUrl %s before issuing setup codes", async (publicUrl) => {
    await expectSetupRejected(
      { pluginConfig: { publicUrl } },
      "Error: Configured publicUrl is invalid.",
      true,
    );
  });
});

describe("device-pair notify pending formatting", () => {
  it("includes role and scopes for pending requests", async () => {
    const { formatPendingRequests } =
      await vi.importActual<typeof import("./notify.ts")>("./notify.ts");
    const text = formatPendingRequests([
      {
        requestId: "req-1",
        deviceId: "device-1",
        displayName: "dev one",
        platform: "ios",
        role: "operator",
        scopes: ["operator.admin", "operator.read"],
        remoteIp: "198.51.100.2",
      },
    ]);
    expect(text).toContain("Pending device pairing requests:");
    expect(text).toContain("name=dev one");
    expect(text).toContain("platform=ios");
    expect(text).toContain("role=operator");
    expect(text).toContain("scopes=operator.admin, operator.read");
    expect(text).toContain("ip=198.51.100.2");
  });

  it("falls back to roles list and no scopes when role/scopes are absent", async () => {
    const { formatPendingRequests } =
      await vi.importActual<typeof import("./notify.ts")>("./notify.ts");
    const text = formatPendingRequests([
      { requestId: "req-2", deviceId: "device-2", roles: ["node", "operator"], scopes: [] },
    ]);
    expect(text).toContain("role=node, operator");
    expect(text).toContain("scopes=none");
  });
});

describe("device-pair /pair approve", () => {
  it.each([
    {
      label: "internal caller without pairing scope",
      context: { channel: "webchat", gatewayClientScopes: ["operator.write"] },
    },
    {
      label: "internal caller without scopes",
      context: { channel: "webchat", gatewayClientScopes: undefined },
    },
    {
      label: "external non-owner",
      context: { channel: "telegram", gatewayClientScopes: undefined, senderIsOwner: false },
    },
  ])("rejects approval from $label before reading or approving requests", async ({ context }) => {
    const result = await runPair({
      ...context,
      args: "approve latest",
    });
    expect(result).toEqual({ text: PAIRING_REQUIRED });
    expect(listDevicePairing).not.toHaveBeenCalled();
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

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
