import { buildExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginSetupWizardStatus,
  createTestWizardPrompter,
  type WizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSignalAccount } from "./accounts.js";
import { resolveSignalApprovalReactionTargetWithPersistence } from "./approval-reactions.js";
import { signalPlugin } from "./channel.js";
import * as clientModule from "./client-adapter.js";
import {
  looksLikeUuid,
  normalizeSignalAllowRecipient,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender,
} from "./identity.js";
import { probeSignal } from "./probe.js";
import { registerSignalReplyContext } from "./reply-authors.js";
import { signalDmPolicy } from "./setup-core.js";
import * as transportDetectionModule from "./transport-detection.js";

const reactionStores = await vi.hoisted(() => import("./approval-reactions.test-support.js"));

function signalConfig(signal: NonNullable<OpenClawConfig["channels"]>["signal"]): OpenClawConfig {
  return { channels: { signal } };
}

function approvalConfig(
  signal: NonNullable<OpenClawConfig["channels"]>["signal"] = {
    account: "+15550009999",
    allowFrom: [approvalTo],
  },
): OpenClawConfig {
  return {
    ...signalConfig(signal),
    approvals: {
      exec: {
        enabled: true,
        mode: "targets",
        targets: [{ channel: "signal", to: approvalTo }],
      },
    },
  };
}

const approvalTo = "+15551230000";
const groupTo = "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=";
const senderUuid = "123e4567-e89b-12d3-a456-426614174000";
const reactionHint = "React with:\n\n👍 Allow Once\n👎 Deny";
const { outbound, messaging, threading } = signalPlugin;
const sendText = required(outbound?.sendFormattedText);
const sendMedia = required(outbound?.sendFormattedMedia);
const probeAccount = required(signalPlugin.status?.probeAccount);
const baseUrl = "http://127.0.0.1:8080";
const phone = "+15551234567";
const aliases = { ops: `signal:${groupTo}`, me: phone, home: "signal:loop", loop: "home" };
const aliasConfig = signalConfig({ aliases, defaultTo: "signal:home" });
const approvalMetadata = {
  approvalId: "exec-1",
  approvalSlug: "exec-1",
  approvalKind: "exec" as const,
};

function required<T>(value: T | undefined | null): T {
  if (value == null) {
    throw new Error("Required Signal capability unavailable");
  }
  return value;
}

function approvalPayload(
  overrides: Partial<Parameters<typeof buildExecApprovalPendingReplyPayload>[0]>,
) {
  return buildExecApprovalPendingReplyPayload({
    approvalId: "exec-1",
    approvalSlug: "exec-1",
    allowedDecisions: ["allow-once", "deny"],
    command: "printf test",
    host: "gateway",
    ...overrides,
  });
}

function renderApproval(cfg: OpenClawConfig, payload: ReplyPayload, accountId = "default") {
  return required(outbound?.renderPresentation)({
    payload,
    presentation: payload.presentation ?? { blocks: [] },
    ctx: { cfg, to: approvalTo, text: payload.text ?? "", accountId, payload },
  });
}

function reactionTarget(
  messageId: string,
  overrides: Partial<Parameters<typeof resolveSignalApprovalReactionTargetWithPersistence>[0]> = {},
) {
  return resolveSignalApprovalReactionTargetWithPersistence({
    accountId: "default",
    conversationKey: approvalTo,
    messageId,
    reactionKey: "👍",
    targetAuthor: "+15550009999",
    ...overrides,
  });
}

function deliverApproval(cfg: OpenClawConfig, payload: ReplyPayload, accountId?: string) {
  return required(outbound?.afterDeliverPayload)({
    cfg,
    target: { channel: "signal", to: approvalTo, accountId },
    payload,
    results: [
      {
        channel: "signal",
        messageId: "1700000000099",
        ...(!accountId ? { meta: { signalVisibleText: payload.text } } : {}),
      },
    ],
  });
}

function textContext(overrides: Partial<Parameters<typeof sendText>[0]>) {
  const send = vi.fn().mockResolvedValue({ messageId: "signal-1" });
  return {
    send,
    ctx: { cfg: signalConfig({}), to: phone, text: "", deps: { signal: send }, ...overrides },
  };
}

function checkResult(ok = true, status = 200, error: string | null = null) {
  return vi.spyOn(clientModule, "signalCheck").mockResolvedValueOnce({ ok, status, error });
}

function probeConfigured(kind: "managed-native" | "container") {
  const cfg = signalConfig({ account: "+15550001111", transport: { kind, url: baseUrl } });
  return probeAccount({ cfg, account: resolveSignalAccount({ cfg }), timeoutMs: 1000 });
}

const getSignalSetupStatus = createPluginSetupWizardStatus(signalPlugin);

afterEach(() => {
  vi.restoreAllMocks();
});

it.each([
  [["123e4567e89b12d3a456426614174000"], true], // pragma: allowlist secret
  [["1234567890", "+15555551212"], false],
] as const)("recognizes UUID shapes for %j", (values, expected) => {
  for (const value of values) {
    expect(looksLikeUuid(value)).toBe(expected);
  }
});

it("falls back to sourceUuid when sourceNumber has no digits", () => {
  const sender = resolveSignalSender({
    sourceNumber: "not a phone number",
    sourceUuid: senderUuid,
  });
  expect(sender).toEqual({ kind: "uuid", raw: senderUuid });
  expect(resolveSignalRecipient(required(sender))).toBe(senderUuid);
  expect(resolveSignalPeerId(required(sender))).toBe(`uuid:${senderUuid}`);
});

it("normalizes noisy allowlist numbers and rejects digit-free entries", () => {
  expect(normalizeSignalAllowRecipient("signal:++1 (555) 000-1111")).toBe("+15550001111");
  expect(normalizeSignalAllowRecipient("signal:not a phone number")).toBeUndefined();
});
describe("probeSignal", () => {
  it.each([
    { transport: "managed-native", version: { version: "0.13.22" }, expected: "0.13.22" },
    { transport: "container", version: { versions: ["v1", "v2"], build: 42 }, expected: "v1, v2" },
  ] as const)(
    "probes $transport versions without an initialized runtime",
    async ({ transport, version, expected }) => {
      checkResult();
      vi.spyOn(clientModule, "signalRpcRequest").mockResolvedValueOnce(version);
      const result =
        transport === "container"
          ? await probeSignal(baseUrl, 1000, { transportKind: "container" })
          : await probeConfigured("managed-native");

      expect(result).toMatchObject({ ok: true, status: 200, error: null, version: expected });
    },
  );

  it.each([
    [false, 204, "Signal RPC returned malformed JSON"],
    [true, null, "Signal transport not reachable at http://127.0.0.1:8080"],
  ] as const)("returns detection=%s failures as probe data", async (auto, status, error) => {
    if (auto) {
      vi.spyOn(transportDetectionModule, "detectSignalTransport").mockRejectedValueOnce(
        new Error(error),
      );
    } else {
      checkResult(true, 204);
      vi.spyOn(clientModule, "signalRpcRequest").mockRejectedValueOnce(new Error(error));
    }
    const res = await probeSignal(baseUrl, 1000, auto ? { apiMode: "auto" } : {});
    expect(res).toMatchObject({ ok: false, status, error, version: null });
  });

  it("reports container accounts unhealthy when their receive WebSocket cannot upgrade", async () => {
    const error = "Signal container receive endpoint did not upgrade to WebSocket (HTTP 200)";
    const signalCheck = checkResult(false, 200, error);
    const signalRpcRequest = vi.spyOn(clientModule, "signalRpcRequest");

    const result = await probeConfigured("container");

    expect(signalCheck).toHaveBeenCalledWith(baseUrl, 1000, {
      transportKind: "container",
      account: "+15550001111",
    });
    expect(signalRpcRequest).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, status: 200, error, version: null });
  });

  it.each([false, true])("resolves setup status with default selection=%s", async (useDefault) => {
    const native = (cliPath: string) => ({
      transport: { kind: "managed-native" as const, cliPath },
    });
    const status = await getSignalSetupStatus({
      cfg: signalConfig({
        ...native("/tmp/root-signal-cli"),
        ...(useDefault ? { defaultAccount: "work" } : {}),
        accounts: useDefault
          ? { alerts: native("/tmp/alerts-signal-cli"), work: { account: "" } }
          : { work: native("/tmp/work-signal-cli") },
      }),
      accountOverrides: useDefault ? {} : { signal: "work" },
    });
    if (useDefault) {
      expect(status.configured).toBe(true);
    } else {
      expect(status.statusLines).toContain("signal-cli: missing (/tmp/work-signal-cli)");
    }
  });
});

it("sends the pairing approval from the approved account", async () => {
  const account = (number: string, name: string) => ({
    account: number,
    transport: { kind: "external-native" as const, url: `http://${name}.test` },
  });
  const cfg = signalConfig({
    defaultAccount: "alpha",
    accounts: {
      alpha: account("+15550000001", "alpha"),
      beta: account("+15550000002", "beta"),
    },
  });

  const signalRpcRequest = vi
    .spyOn(clientModule, "signalRpcRequest")
    .mockResolvedValue({ timestamp: 1_700_000_000_000 } as never);
  await signalPlugin.pairing!.notifyApproval!({ cfg, id: "+15551234567", accountId: "beta" });
  expect(signalRpcRequest.mock.calls[0]?.[1]).toMatchObject({ account: "+15550000002" });
  expect(signalRpcRequest.mock.calls[0]?.[2]).toMatchObject({ baseUrl: "http://beta.test" });
});

describe("signal outbound", () => {
  it.each([
    ["signal:ops", "group", { to: groupTo, kind: "group", display: "ops", source: "directory" }],
    ["signal:home", "user", null],
  ] as const)("resolves %s for messaging and outbound delivery", async (input, kind, expected) => {
    const resolved = await messaging?.targetResolver?.resolveTarget?.({
      cfg: aliasConfig,
      input,
      normalized: input.slice("signal:".length),
      preferredKind: kind,
    });

    expect(resolved).toEqual(expected);
    const target = required(
      outbound?.resolveTarget?.({ cfg: aliasConfig, to: input, accountId: "default" }),
    );
    if (expected) {
      expect(target).toEqual({ ok: true, to: groupTo });
      const route = await messaging?.resolveOutboundSessionRoute?.({
        cfg: aliasConfig,
        agentId: "main",
        target: input,
        resolvedTarget: { ...required(resolved), source: required(resolved?.source) },
      });
      expect(route?.to).toBe(groupTo);
      expect(route?.baseSessionKey).toContain(`signal:${groupTo}`);
    } else {
      expect(
        signalPlugin.config.resolveDefaultTo?.({ cfg: aliasConfig, accountId: "default" }),
      ).toBe(input);
      expect(target.ok).toBe(false);
      if (!target.ok) {
        expect(target.error.message).toBe(
          'Signal alias "home" resolves recursively through "home".',
        );
      }
    }
  });

  it.each([
    ["formatted", "text"],
    ["formatted", "media"],
    ["durable", "text"],
    ["durable", "media"],
  ] as const)("delivers %s %s with canonical aliases and quotes", async (mode, kind) => {
    const mediaUrl = "file:///tmp/signal-proof.png";
    const replyToId = "1700000000001";
    await registerSignalReplyContext({ to: groupTo, replyToId, author: phone, body: "original" });
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ channel: "signal", messageId: "signal-1" }],
      kind,
    });
    const sent = { messageId: "signal-1", receipt };
    const send = vi.fn().mockResolvedValue(sent);
    const ctx = {
      cfg: aliasConfig,
      to: "signal:ops",
      text: "hello",
      deps: { signal: send },
      replyToId,
    };
    const methods =
      mode === "formatted"
        ? { text: sendText, media: sendMedia }
        : {
            text: required(signalPlugin.message?.send?.text),
            media: required(signalPlugin.message?.send?.media),
          };
    const result =
      kind === "media" ? await methods.media({ ...ctx, mediaUrl }) : await methods.text(ctx);
    if (mode === "durable") {
      expect(result).toEqual(sent);
    }
    expect(send).toHaveBeenCalledWith(
      groupTo,
      "hello",
      expect.objectContaining({
        replyToId,
        replyToAuthor: phone,
        replyToBody: "original",
        ...(kind === "media" ? { mediaUrl } : {}),
      }),
    );
  });

  const listText =
    "Intro here.\n\n- item one aaaa\n- item two bbbb\n- item three cc\n- item four dddd";
  it.each([
    [
      "newline",
      60,
      listText,
      ["Intro here.", "• item one aaaa\n• item two bbbb\n• item three cc", "• item four dddd"],
    ],
    [
      "length",
      60,
      listText,
      ["Intro here.\n\n• item one aaaa\n• item two bbbb", "• item three cc\n• item four dddd"],
    ],
    [
      "newline",
      25,
      "[one](https://a.example)\n\nTwo three four",
      ["one (https://a.example)", "Two three four"],
    ],
  ] as const)("uses %s chunking at limit %s", async (mode, limit, text, expected) => {
    const { ctx, send } = textContext({
      cfg: signalConfig({ textChunkLimit: limit, streaming: { chunkMode: mode } }),
      text,
    });
    await sendText(ctx);
    expect(send.mock.calls.map((call) => call[1])).toEqual(expected);
  });

  it("retains code blank lines and chunk-local styles in newline mode", async () => {
    const { ctx, send } = textContext({
      cfg: signalConfig({ textChunkLimit: 6, streaming: { chunkMode: "newline" } }),
      text: "**Intro**\n\n```\naaa\n\nbbb\n```\n\n*End*",
    });
    await sendText(ctx);
    const messages = send.mock.calls.map((call) => [call[1], call[2].textStyles] as const);
    expect([messages[0], messages.at(-1)]).toEqual([
      ["Intro", [{ start: 0, length: 5, style: "BOLD" }]],
      ["End", [{ start: 0, length: 3, style: "ITALIC" }]],
    ]);
    const code = messages.slice(1, -1);
    expect(code.map(([text]) => text.trim()).join("")).toBe("aaa\n\nbbb");
    for (const [text, styles] of code) {
      expect(text.length).toBeLessThanOrEqual(6);
      expect(styles).toEqual([{ start: 0, length: text.length, style: "MONOSPACE" }]);
    }
  });

  it.each([
    { formatting: undefined, expected: ["One\n\nTwo", "Three"] },
    { formatting: { chunkMode: "length" as const }, expected: ["One", "Two", "Three"] },
  ])(
    "resolves account chunking and formatting overrides: $formatting",
    async ({ formatting, expected }) => {
      const { ctx, send } = textContext({
        cfg: signalConfig({
          textChunkLimit: 8,
          streaming: { chunkMode: "length" },
          accounts: { work: { streaming: { chunkMode: "newline" } } },
        }),
        accountId: "work",
        formatting,
        text: "One\n\nTwo\n\nThree",
      });
      await sendText(ctx);
      expect(send.mock.calls.map((call) => call[1])).toEqual(expected);
    },
  );

  it("reports a formatted Signal chunk before a later chunk fails", async () => {
    const onDeliveryResult = vi.fn();
    const { ctx, send } = textContext({
      cfg: signalConfig({ replyToMode: "first" }),
      text: "a".repeat(5000),
      replyToId: "1700000000004",
      replyToIdSource: "implicit",
      onDeliveryResult,
    });
    send
      .mockReset()
      .mockResolvedValueOnce({ messageId: "signal-1" })
      .mockRejectedValueOnce(new Error("second Signal chunk failed"));
    await expect(sendText(ctx)).rejects.toThrow("second Signal chunk failed");

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[2]).not.toHaveProperty("replyToId");
    expect(onDeliveryResult).toHaveBeenCalledTimes(1);
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "signal", messageId: "signal-1" }),
    );
  });

  it("resolves account and chat-type scoped reply-to modes through plugin threading", () => {
    const resolveReplyToMode = required(threading?.resolveReplyToMode);

    const cfg = signalConfig({
      replyToMode: "first",
      replyToModeByChatType: { direct: "all", group: "off" },
      accounts: {
        Work: {
          replyToMode: "off",
          replyToModeByChatType: { group: "all" },
        },
      },
    });

    expect(resolveReplyToMode({ cfg, accountId: "work", chatType: "group" })).toBe("all");
    expect(resolveReplyToMode({ cfg, accountId: "work", chatType: "direct" })).toBe("off");
    expect(resolveReplyToMode({ cfg, accountId: "default", chatType: "direct" })).toBe("all");
    expect(resolveReplyToMode({ cfg, accountId: "default", chatType: "group" })).toBe("off");
    expect(resolveReplyToMode({ cfg, accountId: "default" })).toBe("first");
  });

  it("builds same-conversation reply context for message tool sends", () => {
    const buildToolContext = required(threading?.buildToolContext);

    const hasRepliedRef = { value: false };
    const context = required(
      buildToolContext({
        cfg: signalConfig({ replyToModeByChatType: { direct: "first" } }),
        accountId: "default",
        context: {
          Channel: "signal",
          To: "signal:+15550001111",
          ChatType: "direct",
          CurrentMessageId: "1783831798122",
          ReplyToId: "1783831798000",
        },
        hasRepliedRef,
      }),
    );

    expect(context.currentMessageId).toBe("1783831798000");
    expect(
      threading?.matchesToolContextTarget?.({
        target: "+15550001111",
        toolContext: context,
      }),
    ).toBe(true);
  });

  it("preserves the local approval prompt suppressor through attached-result composition", () => {
    const suppressor = required(outbound?.shouldSuppressLocalPayloadPrompt);
    const execApproval = { ...approvalMetadata, sessionKey: "agent:main:signal:+15551230000" };
    const suppressed = suppressor({
      cfg: {
        ...signalConfig({ enabled: true, allowFrom: [approvalTo] }),
        approvals: { exec: { enabled: true } },
      },
      accountId: "default",
      payload: { text: "Approval required.", channelData: { execApproval } },
      hint: {
        kind: "approval-pending",
        approvalKind: "exec",
        nativeRouteActive: true,
      },
    });
    expect(suppressed).toBe(true);
  });

  it.each([false, true])(
    "binds structured approval reactions (default account=%s)",
    async (useDefault) => {
      reactionStores.clearSignalApprovalReactionStoresForTest();
      const sessionKey = "agent:main:signal:direct:+15551230000";
      const cfg = useDefault
        ? approvalConfig({
            defaultAccount: "work",
            accounts: { work: { accountUuid: senderUuid, allowFrom: [approvalTo] } },
          })
        : approvalConfig();
      const payload: ReplyPayload = useDefault
        ? {
            text: "Exec approval required\nID: exec-1",
            channelData: {
              execApproval: { ...approvalMetadata, allowedDecisions: ["allow-once", "deny"] },
            },
          }
        : approvalPayload({ agentId: "main", sessionKey });
      const accountId = useDefault ? "work" : "default";
      const rendered = required(await renderApproval(cfg, payload, accountId));
      expect(rendered.text).toContain(reactionHint);
      await deliverApproval(cfg, rendered, useDefault ? undefined : accountId);
      const target = await reactionTarget(
        "1700000000099",
        useDefault ? { accountId, targetAuthor: undefined, targetAuthorUuid: senderUuid } : {},
      );
      if (useDefault) {
        expect(target).toMatchObject({ approvalId: "exec-1", decision: "allow-once" });
        await expect(reactionTarget("1700000000099")).resolves.toBeNull();
      } else {
        expect(target).toEqual({
          approvalId: "exec-1",
          approvalKind: "exec",
          decision: "allow-once",
          route: { deliveryMode: "target", to: approvalTo, accountId, agentId: "main", sessionKey },
        });
        const quoted = {
          text: "The docs show this example:\nExec approval required\nID: exec-1\n\nReply with: /approve exec-1 allow-once|deny",
          presentation: payload.presentation,
        };
        expect(await renderApproval(cfg, quoted)).toBeNull();
      }
      reactionStores.clearSignalApprovalReactionStoresForTest();
    },
  );
});

it("validates and applies allowlist entries through the DM policy prompt", async () => {
  const text = vi.fn(async (params: Parameters<WizardPrompter["text"]>[0]) => {
    expect(params.validate?.("uuid:")).toBe("Invalid uuid entry");
    expect(params.validate?.("invalid")).toBe("Invalid entry: invalid");
    return "signal:+15555550123, 123e4567-e89b-12d3-a456-426614174000, *";
  }) as WizardPrompter["text"];
  const next = await signalDmPolicy.promptAllowFrom({
    cfg: signalConfig({}),
    prompter: createTestWizardPrompter({ text }),
  });

  expect(next.channels?.signal?.allowFrom).toEqual([
    "+15555550123",
    "uuid:123e4567-e89b-12d3-a456-426614174000",
    "*",
  ]);
});

it("uses defaultAccount for omitted DM policy reads and writes", () => {
  const cfg = signalConfig({
    dmPolicy: "disabled",
    defaultAccount: "work",
    allowFrom: ["+15555550123"],
    accounts: { work: { account: "+15555550999", dmPolicy: "allowlist" } },
  });
  expect(signalDmPolicy.getCurrent(cfg)).toBe("allowlist");
  expect(signalDmPolicy.resolveConfigKeys?.(cfg)).toEqual({
    policyKey: "channels.signal.accounts.work.dmPolicy",
    allowFromKey: "channels.signal.accounts.work.allowFrom",
  });
  const next = signalDmPolicy.setPolicy(cfg, "open");
  expect(next.channels?.signal).toMatchObject({
    dmPolicy: "disabled",
    allowFrom: ["+15555550123"],
    accounts: { work: { dmPolicy: "open", allowFrom: ["+15555550123", "*"] } },
  });
});
