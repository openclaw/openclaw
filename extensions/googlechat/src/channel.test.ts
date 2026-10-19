// Googlechat tests cover channel plugin behavior.
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import {
  createDirectoryTestRuntime,
  expectDirectorySurface,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { resolveGoogleChatAccount } from "./accounts.js";
import {
  googlechatDirectoryAdapter,
  googlechatMessageAdapter,
  googlechatOutboundAdapter,
  googlechatPairingTextAdapter,
  googlechatSecurityAdapter,
  googlechatThreadingAdapter,
} from "./channel.adapters.js";
import { normalizeGoogleChatTarget } from "./targets.js";

const sendGoogleChatMessageMock = vi.hoisted(() => vi.fn());
const resolveGoogleChatAccountMock = vi.mocked(resolveGoogleChatAccount);
const resolveGoogleChatOutboundSpaceMock = vi.hoisted(() => vi.fn());

function mockGoogleChatOutboundSpaceResolution() {
  resolveGoogleChatOutboundSpaceMock.mockImplementation(async ({ target }: { target: string }) => {
    const normalized = normalizeGoogleChatTarget(target);
    if (!normalized) {
      throw new Error("Missing Google Chat target.");
    }
    return normalized.toLowerCase().startsWith("users/")
      ? `spaces/DM-${normalized.slice("users/".length)}`
      : normalized.replace(/\/messages\/.+$/, "");
  });
}

vi.mock("./channel.runtime.js", () => ({
  googleChatChannelRuntime: { sendGoogleChatMessage: sendGoogleChatMessageMock },
}));

vi.mock("./accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accounts.js")>();
  return { ...actual, resolveGoogleChatAccount: vi.fn(actual.resolveGoogleChatAccount) };
});

vi.mock("./targets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./targets.js")>()),
  resolveGoogleChatOutboundSpace: (...args: unknown[]) =>
    resolveGoogleChatOutboundSpaceMock(...args),
}));

mockGoogleChatOutboundSpaceResolution();

afterEach(() => {
  vi.clearAllMocks();
  resolveGoogleChatAccountMock.mockReset();
  mockGoogleChatOutboundSpaceResolution();
});

afterAll(() => {
  vi.doUnmock("./channel.runtime.js");
  vi.doUnmock("./accounts.js");
  vi.doUnmock("./targets.js");
  vi.resetModules();
});

type ChatConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["googlechat"]>;
function chatConfig(googlechat: ChatConfig): OpenClawConfig {
  return { channels: { googlechat } };
}

function createGoogleChatCfg(): OpenClawConfig {
  return chatConfig({
    enabled: true,
    serviceAccount: {
      type: "service_account",
      client_email: "bot@example.com",
      private_key: "test-key", // pragma: allowlist secret
      token_uri: "https://oauth2.googleapis.com/token",
    },
  });
}

function requireMockArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

describe("googlechatPlugin outbound", () => {
  it("declares durable text and thread delivery with receipt proofs", async () => {
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
    });

    const cfg = createGoogleChatCfg();

    const proofs = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "googlechat",
      adapter: googlechatMessageAdapter,
      proofs: {
        text: async () => {
          const result = await googlechatMessageAdapter.send?.text?.({
            cfg,
            to: "spaces/AAA",
            text: "hello",
          });
          expect(result?.receipt.parts[0]?.kind).toBe("text");
          expect(result?.receipt.platformMessageIds).toEqual(["spaces/AAA/messages/msg-1"]);
        },
        thread: async () => {
          sendGoogleChatMessageMock.mockClear();
          await googlechatMessageAdapter.send?.text?.({
            cfg,
            to: "spaces/AAA",
            text: "threaded",
            threadId: "thread-1",
          });
          expect(requireMockArg(sendGoogleChatMessageMock)).toMatchObject({
            space: "spaces/AAA",
            thread: "thread-1",
          });
        },
        messageSendingHooks: () => {
          expect(googlechatMessageAdapter.send?.text).toBeTypeOf("function");
        },
      },
    });
    expect(proofs).toStrictEqual(
      (
        "text,media,poll,payload,silent,replyTo,thread,nativeQuote,messageSendingHooks," +
        "batch,reconcileUnknownSend,afterSendSuccess,afterCommit"
      )
        .split(",")
        .map((capability) => ({
          capability,
          status: ["text", "thread", "messageSendingHooks"].includes(capability)
            ? "verified"
            : "not_declared",
        })),
    );
  });

  it("renders and chunks outbound text without requiring Google Chat runtime initialization", () => {
    const chunker = googlechatOutboundAdapter.base.chunker;

    expect(chunker("**alpha** [docs](https://example.com)", 32_000)).toEqual([
      "*alpha* <https://example.com|docs>",
    ]);
  });
});

describe("googlechatPlugin threading", () => {
  it("honors per-account replyToMode overrides", () => {
    const cfg = chatConfig({ replyToMode: "all", accounts: { work: { replyToMode: "first" } } });

    const mode = googlechatThreadingAdapter.scopedAccountReplyToMode;
    expect(mode.resolveReplyToMode(mode.resolveAccount(cfg, "work"))).toBe("first");
    expect(mode.resolveReplyToMode(mode.resolveAccount(cfg, "default"))).toBe("all");
  });

  it.each([
    ["uses the inbound thread resource", "spaces/AAA/threads/thread-1"],
    ["does not use message resources implicitly", undefined],
  ])("%s as the tool reply target", (_name, replyToId) => {
    const hasRepliedRef = replyToId ? { value: false } : undefined;
    const context = googlechatThreadingAdapter.buildToolContext({
      cfg: chatConfig({ replyToMode: "all" }),
      accountId: "default",
      hasRepliedRef,
      context: {
        To: "googlechat:spaces/AAA",
        CurrentMessageId: "spaces/AAA/messages/msg-1",
        ReplyToId: replyToId,
      },
    });
    expect(context).toMatchObject({
      currentChannelId: "spaces/AAA",
      currentMessageId: replyToId,
      currentThreadTs: replyToId,
      replyToMode: "all",
      hasRepliedRef,
    });
  });
});

const resolveTarget = googlechatOutboundAdapter.base.resolveTarget;

describe("googlechatPlugin outbound resolveTarget", () => {
  it("resolves email targets", () => {
    expect(resolveTarget({ to: "user@example.com" })).toEqual({
      ok: true,
      to: "users/user@example.com",
    });
  });

  it("errors on invalid targets", () => {
    expect(resolveTarget({ to: "   " })).toMatchObject({
      ok: false,
      error: {
        name: "MessageActionDeniedError",
        message: "Delivering to Google Chat requires target <spaces/{space}|users/{user}>",
        reasonCode: "message_target_missing",
        policyRef: "message-target:required",
      },
    });
  });
});

it("preserves accountId when sending pairing approvals", async () => {
  const cfg = chatConfig({
    enabled: true,
    accounts: {
      work: { serviceAccount: { type: "service_account" } },
    },
  });
  const account = {
    accountId: "work",
    enabled: true,
    config: {},
    credentialSource: "inline" as const,
  };
  resolveGoogleChatAccountMock.mockReturnValue(account);
  resolveGoogleChatOutboundSpaceMock.mockResolvedValue("spaces/WORK");
  sendGoogleChatMessageMock.mockResolvedValue({
    messageName: "spaces/WORK/messages/msg-1",
  });

  await googlechatPairingTextAdapter.notify({
    cfg: cfg as never,
    id: "user@example.com",
    message: googlechatPairingTextAdapter.message,
    accountId: "work",
  } as never);

  expect(resolveGoogleChatAccountMock).toHaveBeenCalledWith({
    cfg,
    accountId: "work",
  });
  const request = requireMockArg(sendGoogleChatMessageMock) as {
    account?: unknown;
    space?: string;
    text?: string;
  };
  expect(request.account).toBe(account);
  expect(request.space).toBe("spaces/WORK");
  expect(request.text).toBe(googlechatPairingTextAdapter.message);
});

it("lists peers and groups from config", async () => {
  const runtimeEnv = createDirectoryTestRuntime() as never;
  const cfg = chatConfig({
    serviceAccount: { client_email: "bot@example.com" },
    allowFrom: [" users/alice ", " googlechat:user:Bob@Example.com "],
    groups: {
      "spaces/AAA": {},
      "spaces/BBB": {},
    },
  });

  const directory = expectDirectorySurface(googlechatDirectoryAdapter);

  const request = {
    cfg,
    accountId: undefined,
    query: undefined,
    limit: undefined,
    runtime: runtimeEnv,
  };
  const peers = await directory.listPeers(request);
  expect(peers).toStrictEqual([
    { kind: "user", id: "users/alice" },
    { kind: "user", id: "users/bob@example.com" },
  ]);

  const groups = await directory.listGroups(request);
  expect(groups).toStrictEqual([
    { kind: "group", id: "spaces/AAA" },
    { kind: "group", id: "spaces/BBB" },
  ]);
});

it("normalizes prefixed DM allowlist entries to lowercase user ids", () => {
  const cfg = chatConfig({
    serviceAccount: { client_email: "bot@example.com" },
    dmPolicy: "allowlist",
    allowFrom: ["  googlechat:user:Bob@Example.com  "],
  });

  const account = resolveGoogleChatAccount({ cfg, accountId: "default" });

  expect(googlechatSecurityAdapter.dm.resolvePolicy(account)).toBe("allowlist");
  expect(googlechatSecurityAdapter.dm.resolveAllowFrom(account)).toEqual([
    "  googlechat:user:Bob@Example.com  ",
  ]);
  expect(googlechatSecurityAdapter.dm.normalizeEntry("  googlechat:user:Bob@Example.com  ")).toBe(
    "bob@example.com",
  );
  expect(googlechatPairingTextAdapter.normalizeAllowEntry("  users/Alice@Example.com  ")).toBe(
    "alice@example.com",
  );
});

it("strips internal tool-trace failure banners from outbound text (#90684)", () => {
  const sanitizeText = googlechatOutboundAdapter.base.sanitizeText;
  const text =
    "Visible answer.\n⚠️ 🛠️ `run openclaw definitely-not-a-real-subcommand (agent)` failed";
  const out = sanitizeText({ text });
  expect(out).toBe("Visible answer.");
});
