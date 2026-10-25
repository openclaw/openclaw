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
  issueDeviceBootstrapToken: vi.fn<typeof import("./api.js").issueDeviceBootstrapToken>(),
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
  ...pluginApiMocks,
  definePluginEntry: vi.fn((entry) => entry),
  listDevicePairing: vi.fn(async () => ({ pending: [] })),
  runPluginCommandWithTimeout: vi.fn(),
}));

vi.mock("./notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./notify.js")>()),
  armPairNotifyOnce: vi.fn(async () => false),
  handleNotifyCommand: vi.fn(async () => ({ text: "notify" })),
}));

import { approveDevicePairing, listDevicePairing, runPluginCommandWithTimeout } from "./api.js";
import registerDevicePair from "./index.js";
import { formatPendingRequests } from "./notify.js";

type ApproveDevicePairingResolved = Awaited<ReturnType<typeof approveDevicePairing>>;
type RegisterPairOptions = Partial<Pick<OpenClawPluginApi, "config" | "runtime" | "pluginConfig">>;
type Gateway = NonNullable<OpenClawPluginApi["config"]["gateway"]>;

const gatewayAuth = { mode: "token" as const, token: "gateway-token" };
function gatewayOptions(gateway: Gateway): RegisterPairOptions {
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
    ...LIMITED_SETUP_REQUEST.profile,
    scopes: ["operator.admin", ...LIMITED_SETUP_REQUEST.profile.scopes],
    purpose: "mobile-full",
  },
};
const PAIRING_REQUIRED = "⚠️ This command requires operator.pairing.";
const TALK_SECRETS_REQUIRED =
  "⚠️ Setup code handoff includes Talk secrets and requires operator.talk.secrets.";
const SECURE_URL_REQUIRED = "Tailscale and public mobile pairing require a secure gateway URL";

function registerPairCommand(params: RegisterPairOptions = {}) {
  const registerCommand = vi.fn<(command: OpenClawPluginCommandDefinition) => void>();
  registerDevicePair.register(
    createTestPluginApi({
      config: params.config ?? { gateway: { auth: gatewayAuth } },
      pluginConfig: { publicUrl: "wss://gateway.example.test", ...params.pluginConfig },
      runtime: (params.runtime ?? {}) as OpenClawPluginApi["runtime"],
      registerCommand,
    }),
  );
  return registerCommand.mock.calls[0]![0];
}

function createCommandContext(params: Partial<PluginCommandContext> = {}): PluginCommandContext {
  const args = params.args ?? "qr";
  return {
    channel: "webchat",
    isAuthorizedSender: true,
    commandBody: `/pair ${args}`.trim(),
    args,
    gatewayClientScopes: INTERNAL_SETUP_SCOPES,
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

async function runPairText(...args: Parameters<typeof runPair>) {
  const { text } = await runPair(...args);
  expect(text).toEqual(expect.any(String));
  return text!;
}

function expectFragments(text: string | undefined, ...fragments: string[]) {
  for (const fragment of fragments) {
    expect(text).toContain(fragment);
  }
}

function decodeSetupCode(text: string) {
  const code = text.match(/Setup code:\n([A-Za-z0-9_-]+)/u)?.[1];
  if (!code) {
    throw new Error("Missing setup code in /pair reply");
  }
  return JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
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

const device = {
  deviceId: "victim-phone",
  publicKey: "victim-public-key",
  displayName: "Victim Phone",
  platform: "ios",
};
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

describe("device-pair /pair qr", () => {
  it("returns an inline QR image for webchat surfaces", async () => {
    const command = registerPairCommand();
    expect(command.acceptsArgs).toBe(true);
    expect(command.requiredScopes).toEqual(["operator.pairing"]);
    expect(command.clientPresentation).toEqual({
      when: "no-arguments",
      action: { kind: "device-pairing" },
    });
    const result = await command.handler(
      createCommandContext({ channel: "webchat", gatewayClientScopes: ["operator.admin"] }),
    );
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledWith(FULL_SETUP_REQUEST);
    expect(result.channelData?.openclawPairingQr).toEqual({
      setupCode: expect.any(String),
      expiresAtMs: expect.any(Number),
    });
    expect(result.sensitiveMedia).toBe(true);
    expect(result.mediaUrl).toBeUndefined();
    expectFragments(
      result.text,
      "- Security: single-use bootstrap token",
      "**Important:** Run `/pair cleanup` after pairing finishes.",
      "If this QR code leaks, run `/pair cleanup` immediately.",
    );
    expect(result.text).not.toContain("![OpenClaw pairing QR]");
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
    const text = await runPairText(
      { channel, ...context },
      { runtime: createChannelRuntime(channel, sendMessage) },
    );
    const payload = sendMessage.mock.calls[0]![0];
    expectFragments(
      payload.text,
      "IMPORTANT: After pairing finishes, run /pair cleanup.",
      "If this QR code leaks, run /pair cleanup immediately.",
    );
    const mediaUrl = payload.mediaUrl!;
    expect(payload).toMatchObject({
      to: target,
      mediaLocalRoots: [path.dirname(mediaUrl)],
      ...opts,
    });
    expect(sentPng).toBe("fakepng");
    await expect(fs.access(mediaUrl)).rejects.toMatchObject({ code: "ENOENT" });
    expect(text).toContain("QR code sent above.");
  });

  it("reissues the bootstrap token after QR delivery failure before falling back", async () => {
    pluginApiMocks.issueDeviceBootstrapToken
      .mockResolvedValueOnce({ token: "first-token", expiresAtMs: Date.now() + 10 * 60_000 })
      .mockResolvedValueOnce({ token: "second-token", expiresAtMs: Date.now() + 10 * 60_000 });
    const sendMessage = vi.fn().mockRejectedValue(new Error("upload failed"));
    const text = await runPairText(
      { channel: "discord", senderId: "123" },
      { runtime: createChannelRuntime("discord", sendMessage) },
    );

    expect(pluginApiMocks.revokeDeviceBootstrapToken).toHaveBeenCalledWith({
      token: "first-token",
    });
    expect(decodeSetupCode(text)).toMatchObject({ bootstrapToken: "second-token" });
    expect(text).toContain("If this code leaks or you are done, run /pair cleanup");
  });

  it("requires QR channel senders to be own entries", async () => {
    const send = vi.fn();
    const text = await runPairText(
      { channel: "__proto__", senderId: "prototype-channel" },
      { runtime: createChannelRuntime("__proto__", send) },
    );
    expect(pluginApiMocks.writeQrPngTempFile).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(pluginApiMocks.revokeDeviceBootstrapToken).not.toHaveBeenCalled();
    expect(text).toContain("QR image delivery is not available on this channel");
    expect(decodeSetupCode(text)).toMatchObject({ bootstrapToken: "boot-token" });
    expect(text).not.toContain("```");
  });

  it("supports invalidating unused setup codes", async () => {
    const result = await runPair({ args: "cleanup", gatewayClientScopes: INTERNAL_PAIRING_SCOPES });
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
  const pub = (publicUrl: string, gateway: Gateway = {}): RegisterPairOptions => ({
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
  type SetupRow = {
    options: RegisterPairOptions;
    context: Partial<PluginCommandContext>;
    text: string | string[];
    issued: 0 | 1 | typeof LIMITED_SETUP_REQUEST | typeof FULL_SETUP_REQUEST;
    prepare?: () => void;
    absent?: string;
  };
  it.each`
    label                                       | options                                                                               | context                                                                                                   | text                                                                                                 | issued                   | prepare        | absent
    ${"trusted admin"}                          | ${trustedProxy}                                                                       | ${{ gatewayClientScopes: ["operator.admin"] }}                                                            | ${["Auth: trusted-proxy"]}                                                                           | ${FULL_SETUP_REQUEST}    | ${undefined}   | ${undefined}
    ${"trusted owner"}                          | ${trustedProxy}                                                                       | ${{ channel: "discord", gatewayClientScopes: undefined, senderIsOwner: true }}                            | ${["Auth: trusted-proxy"]}                                                                           | ${FULL_SETUP_REQUEST}    | ${undefined}   | ${undefined}
    ${"QR owner with no Talk scope"}            | ${{}}                                                                                 | ${{ args: "qr", channel: "telegram", senderIsOwner: true, gatewayClientScopes: INTERNAL_PAIRING_SCOPES }} | ${TALK_SECRETS_REQUIRED}                                                                             | ${0}                     | ${undefined}   | ${undefined}
    ${"cleanup with no scopes"}                 | ${{}}                                                                                 | ${{ args: "cleanup", gatewayClientScopes: undefined }}                                                    | ${PAIRING_REQUIRED}                                                                                  | ${0}                     | ${undefined}   | ${undefined}
    ${"approval read-only"}                     | ${{}}                                                                                 | ${{ args: "approve latest", gatewayClientScopes: ["operator.write"] }}                                    | ${PAIRING_REQUIRED}                                                                                  | ${0}                     | ${undefined}   | ${undefined}
    ${"approval no scopes"}                     | ${{}}                                                                                 | ${{ args: "approve latest", gatewayClientScopes: undefined }}                                             | ${PAIRING_REQUIRED}                                                                                  | ${0}                     | ${undefined}   | ${undefined}
    ${"approval non-owner"}                     | ${{}}                                                                                 | ${{ args: "approve latest", channel: "telegram", gatewayClientScopes: undefined, senderIsOwner: false }}  | ${PAIRING_REQUIRED}                                                                                  | ${0}                     | ${undefined}   | ${undefined}
    ${"unauthenticated gateway"}                | ${gatewayOptions({ auth: { mode: "none" } })}                                         | ${{}}                                                                                                     | ${["Gateway auth is not configured"]}                                                                | ${0}                     | ${undefined}   | ${undefined}
    ${"external token owner"}                   | ${{}}                                                                                 | ${{ channel: "telegram", gatewayClientScopes: undefined, senderIsOwner: true }}                           | ${["Pairing setup code generated."]}                                                                 | ${FULL_SETUP_REQUEST}    | ${undefined}   | ${undefined}
    ${"bare secure URL"}                        | ${pub("gateway.example.test:18789/setup", { tls: { enabled: true } })}                | ${{ gatewayClientScopes: ["operator.admin"] }}                                                            | ${["Gateway: wss://gateway.example.test:18789"]}                                                     | ${1}                     | ${undefined}   | ${undefined}
    ${"path-qualified public URL"}              | ${pub("https://pair.example/extra")}                                                  | ${{}}                                                                                                     | ${["Gateway: wss://pair.example"]}                                                                   | ${1}                     | ${undefined}   | ${undefined}
    ${"path-qualified remote URL"}              | ${gatewayOptions({ remote: { url: "https://pair.example/extra" } })}                  | ${{}}                                                                                                     | ${["Gateway: wss://pair.example"]}                                                                   | ${1}                     | ${undefined}   | ${undefined}
    ${"loopback"}                               | ${pub("ws://127.0.0.1:18789")}                                                        | ${{}}                                                                                                     | ${["Gateway: ws://127.0.0.1:18789"]}                                                                 | ${1}                     | ${undefined}   | ${undefined}
    ${"mdns"}                                   | ${pub("ws://openclaw.local:18789")}                                                   | ${{}}                                                                                                     | ${["Gateway: ws://openclaw.local:18789"]}                                                            | ${1}                     | ${undefined}   | ${undefined}
    ${"IPv6 ULA"}                               | ${pub("ws://[fc00::1]:18789")}                                                        | ${{}}                                                                                                     | ${["Gateway: ws://[fc00::1]:18789"]}                                                                 | ${1}                     | ${undefined}   | ${undefined}
    ${"IPv6 link-local lower"}                  | ${pub("ws://[fe80::1]:18789")}                                                        | ${{}}                                                                                                     | ${["Gateway: ws://[fe80::1]:18789"]}                                                                 | ${1}                     | ${undefined}   | ${undefined}
    ${"IPv6 link-local upper"}                  | ${pub("ws://[febf::1]:18789")}                                                        | ${{}}                                                                                                     | ${["Gateway: ws://[febf::1]:18789"]}                                                                 | ${1}                     | ${undefined}   | ${undefined}
    ${"Tailscale Serve"}                        | ${gatewayOptions({ tailscale: { mode: "serve" } })}                                   | ${{}}                                                                                                     | ${["Gateway: wss://gateway.tailnet.ts.net"]}                                                         | ${1}                     | ${discoverDns} | ${undefined}
    ${"publicOrigin"}                           | ${gatewayOptions({ bind: "loopback", publicOrigin: "https://gateway.example.test" })} | ${{}}                                                                                                     | ${["Gateway: wss://gateway.example.test"]}                                                           | ${1}                     | ${undefined}   | ${undefined}
    ${"limited secure caller"}                  | ${{}}                                                                                 | ${{}}                                                                                                     | ${["Access: limited"]}                                                                               | ${LIMITED_SETUP_REQUEST} | ${undefined}   | ${"Plaintext ws:// was limited for safety"}
    ${"private LAN admin"}                      | ${pub("ws://192.168.1.20:18789")}                                                     | ${{ gatewayClientScopes: ["operator.admin"] }}                                                            | ${["Gateway: ws://192.168.1.20:18789", "Access: limited", "Plaintext ws:// was limited for safety"]} | ${LIMITED_SETUP_REQUEST} | ${undefined}   | ${undefined}
    ${"custom bind"}                            | ${gatewayOptions({ bind: "custom", customBindHost: "192.168.139.3" })}                | ${{}}                                                                                                     | ${["Gateway: ws://192.168.139.3:18789"]}                                                             | ${1}                     | ${undefined}   | ${"Fallback:"}
    ${"reject ws://0.0.0.0:18789"}              | ${pub("ws://0.0.0.0:18789")}                                                          | ${{}}                                                                                                     | ${[SECURE_URL_REQUIRED]}                                                                             | ${0}                     | ${undefined}   | ${undefined}
    ${"reject ws://[::]:18789"}                 | ${pub("ws://[::]:18789")}                                                             | ${{}}                                                                                                     | ${[SECURE_URL_REQUIRED]}                                                                             | ${0}                     | ${undefined}   | ${undefined}
    ${"reject ws://gateway.example.test:18789"} | ${pub("ws://gateway.example.test:18789")}                                             | ${{}}                                                                                                     | ${[SECURE_URL_REQUIRED]}                                                                             | ${0}                     | ${undefined}   | ${undefined}
    ${"reject ws://[2001:db8::1]:18789"}        | ${pub("ws://[2001:db8::1]:18789")}                                                    | ${{}}                                                                                                     | ${[SECURE_URL_REQUIRED]}                                                                             | ${0}                     | ${undefined}   | ${undefined}
    ${"reject ws://[fe7f::1]:18789"}            | ${pub("ws://[fe7f::1]:18789")}                                                        | ${{}}                                                                                                     | ${[SECURE_URL_REQUIRED]}                                                                             | ${0}                     | ${undefined}   | ${undefined}
    ${"reject ws://[fec0::1]:18789"}            | ${pub("ws://[fec0::1]:18789")}                                                        | ${{}}                                                                                                     | ${[SECURE_URL_REQUIRED]}                                                                             | ${0}                     | ${undefined}   | ${undefined}
    ${"invalid http://localhost:notaport"}      | ${pub("http://localhost:notaport")}                                                   | ${{}}                                                                                                     | ${"Error: Configured publicUrl is invalid."}                                                         | ${0}                     | ${undefined}   | ${undefined}
  `("$label", async ({ options, context, text, issued, prepare, absent }: SetupRow) => {
    prepare?.();
    const result = await runPair({ args: "", ...context }, options);
    if (typeof text === "string") {
      expect(result).toEqual({ text });
    } else {
      expectFragments(result.text, ...text);
      const gateway = text.find((part) => part.startsWith("Gateway: "));
      if (gateway) {
        expect(decodeSetupCode(result.text ?? "")).toMatchObject({
          url: gateway.slice("Gateway: ".length),
          bootstrapToken: "boot-token",
        });
      }
    }
    expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledTimes(issued === 0 ? 0 : 1);
    if (typeof issued === "object") {
      expect(pluginApiMocks.issueDeviceBootstrapToken).toHaveBeenCalledExactlyOnceWith(issued);
    }
    if (issued === 0) {
      expect([
        vi.mocked(listDevicePairing).mock.calls,
        vi.mocked(approveDevicePairing).mock.calls,
        pluginApiMocks.clearDeviceBootstrapTokens.mock.calls,
      ]).toEqual([[], [], []]);
    }
    if (absent) {
      expect(result.text).not.toContain(absent);
    }
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
});

it.each<{
  request: Parameters<typeof formatPendingRequests>[0][number];
  fragments: string[];
}>`
  request                                                                                                                                                                           | fragments
  ${{ requestId: "req-1", deviceId: "device-1", displayName: "dev one", platform: "ios", role: "operator", scopes: ["operator.admin", "operator.read"], remoteIp: "198.51.100.2" }} | ${["Pending device pairing requests:", "name=dev one", "platform=ios", "role=operator", "scopes=operator.admin, operator.read", "ip=198.51.100.2"]}
  ${{ requestId: "req-2", deviceId: "device-2", roles: ["node", "operator"], scopes: [] }}                                                                                          | ${["role=node, operator", "scopes=none"]}
`("formats pending request $request.requestId", ({ request, fragments }) => {
  expectFragments(formatPendingRequests([request]), ...fragments);
});

describe("device-pair /pair approve", () => {
  const approved: ApproveDevicePairingResolved = {
    status: "approved",
    requestId: "req-1",
    device: { ...device, createdAtMs: 1, approvedAtMs: 2 },
  };
  const forbidden: ApproveDevicePairingResolved = {
    status: "forbidden",
    reason: "caller-missing-scope",
    scope: "operator.admin",
  };
  it.each`
    name                                                                    | context                                                                                       | approved     | expectedCall               | expectedText
    ${"allows internal gateway callers with operator.pairing"}              | ${{ channel: "webchat", gatewayClientScopes: INTERNAL_PAIRING_SCOPES }}                       | ${approved}  | ${INTERNAL_PAIRING_SCOPES} | ${"✅ Paired Victim Phone (ios)."}
    ${"allows command owners to approve from non-gateway command surfaces"} | ${{ channel: "telegram", gatewayClientScopes: undefined, senderIsOwner: true }}               | ${approved}  | ${["operator.pairing"]}    | ${"✅ Paired Victim Phone (ios)."}
    ${"preserves gateway caller scopes for command-owner approvals"}        | ${{ channel: "telegram", gatewayClientScopes: INTERNAL_PAIRING_SCOPES, senderIsOwner: true }} | ${approved}  | ${INTERNAL_PAIRING_SCOPES} | ${"✅ Paired Victim Phone (ios)."}
    ${"rejects approvals that request scopes above the caller session"}     | ${{ channel: "webchat", gatewayClientScopes: INTERNAL_PAIRING_SCOPES }}                       | ${forbidden} | ${INTERNAL_PAIRING_SCOPES} | ${"⚠️ This command requires operator.admin to approve this pairing request."}
  `("$name", async ({ context, approved: outcome, expectedCall, expectedText }) => {
    vi.mocked(listDevicePairing).mockResolvedValueOnce({
      pending: [{ ...device, requestId: "req-1", ts: 1 }],
      paired: [],
    });
    vi.mocked(approveDevicePairing).mockResolvedValueOnce(outcome);
    const result = await runPair({ ...context, args: "approve latest" });
    expect(approveDevicePairing).toHaveBeenCalledWith("req-1", {
      callerScopes: expectedCall,
    });
    expect(result).toEqual({ text: expectedText });
  });
});
