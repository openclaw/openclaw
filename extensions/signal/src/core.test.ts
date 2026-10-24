import assert from "node:assert/strict";
import { buildExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  createMessageReceiptFromOutboundResults,
  verifyChannelMessageAdapterCapabilityProofs,
} from "openclaw/plugin-sdk/channel-outbound";
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
  isSignalSenderAllowed,
  looksLikeUuid,
  normalizeSignalAllowRecipient,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender,
} from "./identity.js";
import { probeSignal } from "./probe.js";
import {
  registerSignalReplyContext,
  resolveSignalReplyContextWithPersistence,
} from "./reply-authors.js";
import { buildSignalSetupPatch, signalDmPolicy } from "./setup-core.js";
import * as transportDetectionModule from "./transport-detection.js";

const reactionStores = vi.hoisted(() => new Set<{ clearForTest(): void }>());

vi.mock("openclaw/plugin-sdk/approval-reaction-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/approval-reaction-runtime")>();
  return {
    ...actual,
    createApprovalReactionTargetStore: <TTarget>(
      params: Parameters<typeof actual.createApprovalReactionTargetStore<TTarget>>[0],
    ) => {
      const store = actual.createApprovalReactionTargetStore<TTarget>(params);
      if (params.namespace === "signal.approval-reactions.v2") {
        reactionStores.add(store);
      }
      return store;
    },
  };
});

function signalConfig(signal: NonNullable<OpenClawConfig["channels"]>["signal"]): OpenClawConfig {
  return { channels: { signal } };
}

function approvalConfig(): OpenClawConfig {
  return {
    ...signalConfig({ account: "+15550009999", allowFrom: [approvalTo] }),
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
const { outbound, messaging, threading, directory } = signalPlugin;
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

function renderApproval(
  cfg: OpenClawConfig,
  payload: ReplyPayload,
  accountId = "default",
  presentation = payload.presentation!,
  renderedPayload = payload,
) {
  return required(outbound?.renderPresentation)({
    payload: renderedPayload,
    presentation,
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

function successfulSend(kind: "text" | "media") {
  return vi.fn(async () => ({
    messageId: "signal-1",
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "signal", messageId: "signal-1" }],
      kind,
    }),
  }));
}

const getSignalSetupStatus = createPluginSetupWizardStatus(signalPlugin);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("looksLikeUuid", () => {
  it.each([
    [["123e4567e89b12d3a456426614174000"], true], // pragma: allowlist secret
    [["1234567890", "+15555551212"], false],
  ] as const)("recognizes UUID shapes for %j", (values, expected) => {
    for (const value of values) {
      expect(looksLikeUuid(value)).toBe(expected);
    }
  });
});

describe("signal sender identity", () => {
  it("keeps IPv6 bind hosts on the managed transport", () => {
    expect(buildSignalSetupPatch({ httpHost: "::1", httpPort: "9090" })).toMatchObject({
      transport: { kind: "managed-native", httpHost: "::1", httpPort: 9090 },
    });
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
});

describe("isSignalSenderAllowed", () => {
  const uuid = "f4d0fe67-3b38-446d-828e-317c285ffa75";
  const e164 = "+34688329273";

  it.each([
    [[`uuid:${uuid}`], true],
    [["+15550009999", "uuid:00000000-0000-0000-0000-000000000000"], false],
  ] as const)("matches a phone-primary sender against %j", (entries, allowed) => {
    const sender = required(resolveSignalSender({ sourceNumber: e164, sourceUuid: uuid }));
    for (const entry of entries) {
      expect(isSignalSenderAllowed(sender, [entry])).toBe(allowed);
    }
  });
});

describe("probeSignal", () => {
  it.each([
    { transport: "managed-native", version: { version: "0.13.22" }, expected: "0.13.22" },
    { transport: "container", version: { versions: ["v1", "v2"], build: 42 }, expected: "v1, v2" },
  ] as const)(
    "probes $transport versions without an initialized runtime",
    async ({ transport, version, expected }) => {
      vi.spyOn(clientModule, "signalCheck").mockResolvedValueOnce({
        ok: true,
        status: 200,
        error: null,
      });
      vi.spyOn(clientModule, "signalRpcRequest").mockResolvedValueOnce(version);
      const cfg = signalConfig({ transport: { kind: "managed-native" } });
      const result =
        transport === "container"
          ? await probeSignal("http://127.0.0.1:8080", 1000, { transportKind: "container" })
          : await signalPlugin.status!.probeAccount!({
              cfg,
              account: resolveSignalAccount({ cfg }),
              timeoutMs: 1000,
            });

      expect(result).toMatchObject({ ok: true, status: 200, error: null, version: expected });
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    },
  );

  it.each([
    {
      stage: "version RPC",
      status: 204,
      error: "Signal RPC returned malformed JSON",
    },
    {
      stage: "auto transport detection",
      status: null,
      error: "Signal transport not reachable at http://127.0.0.1:8080",
    },
  ])("returns $stage failures as probe data", async ({ stage, status, error }) => {
    const auto = stage === "auto transport detection";
    if (auto) {
      vi.spyOn(transportDetectionModule, "detectSignalTransport").mockRejectedValueOnce(
        new Error(error),
      );
    } else {
      vi.spyOn(clientModule, "signalCheck").mockResolvedValueOnce({
        ok: true,
        status: 204,
        error: null,
      });
      vi.spyOn(clientModule, "signalRpcRequest").mockRejectedValueOnce(new Error(error));
    }
    const res = await probeSignal("http://127.0.0.1:8080", 1000, auto ? { apiMode: "auto" } : {});
    expect(res).toMatchObject({ ok: false, status, error, version: null });
    if (auto) {
      expect(res.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("reports container accounts unhealthy when their receive WebSocket cannot upgrade", async () => {
    const signalCheck = vi.spyOn(clientModule, "signalCheck").mockResolvedValueOnce({
      ok: false,
      status: 200,
      error: "Signal container receive endpoint did not upgrade to WebSocket (HTTP 200)",
    });
    const signalRpcRequest = vi.spyOn(clientModule, "signalRpcRequest");

    const result = await signalPlugin.status!.probeAccount!({
      cfg: {} as never,
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        baseUrl: "http://127.0.0.1:8080",
        config: { account: "+15550001111" },
        transport: { kind: "container", url: "http://127.0.0.1:8080" },
      } as never,
      timeoutMs: 1000,
    });

    expect(signalCheck).toHaveBeenCalledWith("http://127.0.0.1:8080", 1000, {
      transportKind: "container",
      account: "+15550001111",
    });
    expect(signalRpcRequest).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      status: 200,
      error: "Signal container receive endpoint did not upgrade to WebSocket (HTTP 200)",
      version: null,
    });
  });

  it("setup status lines use the selected account cliPath", async () => {
    const status = await getSignalSetupStatus({
      cfg: signalConfig({
        transport: { kind: "managed-native", cliPath: "/tmp/root-signal-cli" },
        accounts: {
          work: { transport: { kind: "managed-native", cliPath: "/tmp/work-signal-cli" } },
        },
      }),
      accountOverrides: { signal: "work" },
    });

    expect(status.statusLines).toContain("signal-cli: missing (/tmp/work-signal-cli)");
  });

  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const status = await getSignalSetupStatus({
      cfg: signalConfig({
        defaultAccount: "work",
        transport: { kind: "managed-native", cliPath: "/tmp/root-signal-cli" },
        accounts: {
          alerts: { transport: { kind: "managed-native", cliPath: "/tmp/alerts-signal-cli" } },
          work: { account: "" },
        },
      }),
      accountOverrides: {},
    });

    expect(status.configured).toBe(true);
  });
});

it("sends the pairing approval from the approved account", async () => {
  const cfg = signalConfig({
    defaultAccount: "alpha",
    accounts: {
      alpha: {
        account: "+15550000001",
        transport: { kind: "external-native", url: "http://alpha.test" },
      },
      beta: {
        account: "+15550000002",
        transport: { kind: "external-native", url: "http://beta.test" },
      },
    },
  });

  const signalRpcRequest = vi
    .spyOn(clientModule, "signalRpcRequest")
    .mockResolvedValue({ timestamp: 1_700_000_000_000 } as never);
  await signalPlugin.pairing!.notifyApproval!({ cfg, id: "+15551234567", accountId: "beta" });
  expect(signalRpcRequest).toHaveBeenCalledTimes(1);
  expect(signalRpcRequest.mock.calls[0]?.[1]).toMatchObject({ account: "+15550000002" });
  expect(signalRpcRequest.mock.calls[0]?.[2]).toMatchObject({ baseUrl: "http://beta.test" });
});

describe("signal outbound", () => {
  it.each([
    [
      "signal:ops",
      { ops: `signal:${groupTo}` },
      "group",
      { to: groupTo, kind: "group", display: "ops", source: "directory" },
    ],
    ["signal:home", { home: "signal:me", me: "home" }, "user", null],
  ] as const)(
    "resolves %s through the message target resolver",
    async (input, aliases, kind, expected) => {
      const resolved = await messaging?.targetResolver?.resolveTarget?.({
        cfg: signalConfig({ aliases }),
        input,
        normalized: input.slice("signal:".length),
        preferredKind: kind,
      });

      expect(resolved).toEqual(expected);
    },
  );

  it("resolves aliases through sync outbound target resolution", () => {
    const resolved = outbound?.resolveTarget?.({
      cfg: signalConfig({ aliases: { me: "+15551234567" } }),
      to: "signal:me",
      accountId: "default",
    });

    expect(resolved).toEqual({ ok: true, to: "+15551234567" });
  });

  it.each(["text", "media"] as const)(
    "resolves aliases before formatted Signal %s sends",
    async (kind) => {
      const send = successfulSend(kind);
      const media = kind === "media" ? { mediaUrl: "file:///tmp/signal-proof.png" } : {};
      const ctx = {
        cfg: signalConfig({ aliases: { ops: groupTo } }),
        to: "signal:ops",
        text: "approval",
        deps: { signal: send },
      };
      if (kind === "media") {
        await outbound?.sendFormattedMedia?.({
          ...ctx,
          mediaUrl: "file:///tmp/signal-proof.png",
        });
      } else {
        await outbound?.sendFormattedText?.(ctx);
      }

      expect(send).toHaveBeenCalledWith(
        groupTo,
        "approval",
        expect.objectContaining({ cfg: expect.any(Object), ...media }),
      );
    },
  );

  it.each([
    {
      mode: "newline",
      expected: [
        "Intro here.",
        "• item one aaaa\n• item two bbbb\n• item three cc",
        "• item four dddd",
      ],
    },
    {
      mode: "length",
      expected: [
        "Intro here.\n\n• item one aaaa\n• item two bbbb",
        "• item three cc\n• item four dddd",
      ],
    },
  ] as const)("uses $mode chunking for formatted Signal sends", async ({ mode, expected }) => {
    const send = vi.fn().mockResolvedValue({ messageId: "signal-1" });
    await outbound?.sendFormattedText?.({
      cfg: signalConfig({ textChunkLimit: 60, streaming: { chunkMode: mode } }),
      to: "+15551234567",
      text: "Intro here.\n\n- item one aaaa\n- item two bbbb\n- item three cc\n- item four dddd",
      deps: { signal: send },
    });
    expect(send.mock.calls.map((call) => call[1])).toEqual(expected);
  });

  it("keeps paragraphs whole when rendered links expand their length", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "signal-1" });
    await outbound?.sendFormattedText?.({
      cfg: signalConfig({ textChunkLimit: 25, streaming: { chunkMode: "newline" } }),
      to: "+15551234567",
      text: "[one](https://a.example)\n\nTwo three four",
      deps: { signal: send },
    });
    expect(send.mock.calls.map((call) => call[1])).toEqual([
      "one (https://a.example)",
      "Two three four",
    ]);
  });

  it("retains code blank lines and chunk-local styles in newline mode", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "signal-1" });
    await outbound?.sendFormattedText?.({
      cfg: signalConfig({ textChunkLimit: 6, streaming: { chunkMode: "newline" } }),
      to: "+15551234567",
      text: "**Intro**\n\n```\naaa\n\nbbb\n```\n\n*End*",
      deps: { signal: send },
    });
    const messages = send.mock.calls.map((call) => ({ text: call[1], styles: call[2].textStyles }));
    expect(messages[0]).toEqual({
      text: "Intro",
      styles: [{ start: 0, length: 5, style: "BOLD" }],
    });
    expect(messages.at(-1)).toEqual({
      text: "End",
      styles: [{ start: 0, length: 3, style: "ITALIC" }],
    });
    const code = messages.slice(1, -1);
    expect(code.map(({ text }) => text.trim()).join("")).toBe("aaa\n\nbbb");
    for (const { text, styles } of code) {
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
      const send = vi.fn().mockResolvedValue({ messageId: "signal-1" });
      await outbound?.sendFormattedText?.({
        cfg: signalConfig({
          textChunkLimit: 8,
          streaming: { chunkMode: "length" },
          accounts: { work: { streaming: { chunkMode: "newline" } } },
        }),
        accountId: "work",
        formatting,
        to: "+15551234567",
        text: "One\n\nTwo\n\nThree",
        deps: { signal: send },
      });
      expect(send.mock.calls.map((call) => call[1])).toEqual(expected);
    },
  );

  it("reports a formatted Signal chunk before a later chunk fails", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "signal-1" })
      .mockRejectedValueOnce(new Error("second Signal chunk failed"));
    const onDeliveryResult = vi.fn();

    await expect(
      outbound?.sendFormattedText?.({
        cfg: signalConfig({ replyToMode: "first" }),
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
      expect.not.objectContaining({ replyToId: "1700000000004" }),
    );
    expect(onDeliveryResult).toHaveBeenCalledTimes(1);
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "signal", messageId: "signal-1" }),
    );
  });

  it("returns clear outbound errors for recursive defaultTo aliases", () => {
    const cfg = signalConfig({
      aliases: { home: "signal:me", me: "home" },
      defaultTo: "signal:home",
    });

    const defaultTo = signalPlugin.config.resolveDefaultTo?.({
      cfg,
      accountId: "default",
    });
    expect(defaultTo).toBe("signal:home");

    const resolved = outbound?.resolveTarget?.({
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
    const route = await messaging?.resolveOutboundSessionRoute?.({
      cfg: signalConfig({ aliases: { ops: groupTo } }),
      agentId: "main",
      target: "signal:ops",
      resolvedTarget: {
        to: groupTo,
        kind: "group",
        source: "directory",
      },
    });

    expect(route?.to).toBe(groupTo);
    expect(route?.baseSessionKey).toContain(`signal:${groupTo}`);
  });

  it("lists configured aliases through the Signal directory", async () => {
    const cfg = signalConfig({
      aliases: {
        me: "+15551234567",
        ops: groupTo,
      },
    });

    await expect(
      directory?.listPeers?.({ cfg, query: "me", runtime: {} as never }),
    ).resolves.toEqual([{ kind: "user", id: "+15551234567", name: "me" }]);
    await expect(
      directory?.listGroups?.({ cfg, query: "ops", runtime: {} as never }),
    ).resolves.toEqual([{ kind: "group", id: groupTo, name: "ops" }]);
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

    expect(context).toEqual({
      currentChannelId: "signal:+15550001111",
      currentChatType: "direct",
      currentMessagingTarget: "signal:+15550001111",
      currentMessageId: "1783831798000",
      replyToMode: "first",
      hasRepliedRef,
    });
    expect(
      threading?.matchesToolContextTarget?.({
        target: "+15550001111",
        toolContext: context,
      }),
    ).toBe(true);
  });

  it("sanitizes internal assistant scaffolding before outbound delivery", () => {
    const sanitizeText = required(outbound?.sanitizeText);

    expect(
      sanitizeText({
        text: "<think>private</think>Visible answer",
        payload: { text: "<think>private</think>Visible answer" },
      }),
    ).toBe("Visible answer");
  });

  it("preserves the local approval prompt suppressor through attached-result composition", () => {
    const suppressor = required(outbound?.shouldSuppressLocalPayloadPrompt);

    expect(
      suppressor({
        cfg: {
          ...signalConfig({ enabled: true, allowFrom: [approvalTo] }),
          approvals: { exec: { enabled: true } },
        },
        accountId: "default",
        payload: {
          text: "Approval required.",
          channelData: {
            execApproval: {
              ...approvalMetadata,
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

  it.each(["explicit account", "resolved default account"])(
    "registers delivered approval reactions under the %s",
    async (mode) => {
      reactionStores.forEach((store) => store.clearForTest());
      const useDefault = mode === "resolved default account";
      const cfg: OpenClawConfig = useDefault
        ? {
            ...signalConfig({
              defaultAccount: "work",
              accounts: { work: { accountUuid: senderUuid, allowFrom: [approvalTo] } },
            }),
            approvals: approvalConfig().approvals,
          }
        : approvalConfig();
      const messageId = useDefault ? "1700000000001" : "1700000000099";
      const payload: ReplyPayload = useDefault
        ? {
            text: "Exec approval required\nID: exec-1",
            channelData: {
              execApproval: {
                ...approvalMetadata,
                allowedDecisions: ["allow-once", "deny"],
              },
            },
          }
        : approvalPayload({
            approvalId: "exec-after-delivery",
            approvalSlug: "exec-aft",
            agentId: "main",
            sessionKey: "agent:main:signal:direct:+15551230000",
          });
      const rendered = useDefault
        ? ((await renderApproval(cfg, payload, "work", { blocks: [] })) ?? payload)
        : await renderApproval(cfg, payload);
      expect(rendered?.text).toContain(reactionHint);

      await outbound?.afterDeliverPayload?.({
        cfg,
        target: {
          channel: "signal",
          to: approvalTo,
          ...(!useDefault ? { accountId: "default" } : {}),
        },
        payload: rendered!,
        results: [
          {
            channel: "signal",
            messageId,
            ...(useDefault ? { meta: { signalVisibleText: rendered?.text } } : {}),
          },
        ],
      });

      if (useDefault) {
        await expect(
          reactionTarget(messageId, {
            accountId: "work",
            targetAuthor: undefined,
            targetAuthorUuid: senderUuid,
          }),
        ).resolves.toMatchObject({ approvalId: "exec-1", decision: "allow-once" });
        await expect(reactionTarget(messageId)).resolves.toBeNull();
        reactionStores.forEach((store) => store.clearForTest());
      } else {
        await expect(reactionTarget(messageId)).resolves.toEqual({
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
      }
    },
  );

  it("renders reaction hints only from structured approval payloads", async () => {
    const cfg = approvalConfig();
    const payload = approvalPayload({
      approvalId: "exec-rendered-approval",
      approvalSlug: "exec-ren",
    });
    const rendered = await renderApproval(cfg, payload);

    expect(rendered?.text).toContain(reactionHint);
    expect(
      await renderApproval(cfg, payload, "default", payload.presentation!, {
        text: [
          "The docs show this example:",
          "Exec approval required",
          "ID: exec-rendered-approval",
          "",
          "Reply with: /approve exec-rendered-approval allow-once|deny",
        ].join("\n"),
        presentation: payload.presentation,
      }),
    ).toBeNull();
  });

  it.each([
    {
      name: "resolves only proven direct reply authors",
      replyToId: "1700000000001",
      events: [
        { sourceTimestamp: 100 },
        { sourceTimestamp: 200, author: "+15550001111" },
        { sourceTimestamp: 300 },
      ],
      expected: { ambiguous: true },
    },
    {
      name: "keeps newer reply context when older events arrive out of order",
      replyToId: "1700000000002",
      events: [
        { body: "newer", sourceTimestamp: 200 },
        { body: "older", sourceTimestamp: 100 },
      ],
      expected: { author: "+15551234567", body: "newer" },
    },
  ])("$name", async ({ replyToId, events, expected }) => {
    const replyContext = { to: "signal:+15551234567", replyToId };
    for (const event of events) {
      await registerSignalReplyContext({ ...replyContext, author: "+15551234567", ...event });
    }
    await expect(resolveSignalReplyContextWithPersistence(replyContext)).resolves.toEqual(expected);
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
    assert(signalPlugin.message?.send);
    const sendMessage = signalPlugin.message.send;
    const to = "signal:+15555550123";
    const replyToId = "1700000000001";
    const mediaUrl = "https://example.com/image.png";
    const sendContext = { cfg: {} as OpenClawConfig, to, deps };
    const expectSend = (text: string, options = {}) => {
      expect(send).toHaveBeenCalledWith("+15555550123", text, {
        cfg: {},
        maxBytes: undefined,
        accountId: undefined,
        ...options,
      });
    };

    const proofResults = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "signal",
      adapter: signalPlugin.message!,
      proofs: {
        text: async () => {
          const result = await sendMessage.text?.({ ...sendContext, text: "hello" });
          expectSend("hello");
          expect(result?.receipt.platformMessageIds).toEqual(["signal-text-1"]);
        },
        media: async () => {
          const result = await sendMessage.media?.({ ...sendContext, text: "image", mediaUrl });
          expectSend("image", { mediaUrl });
          expect(result?.receipt.platformMessageIds).toEqual(["signal-media-1"]);
        },
        payload: () => {
          expect(outbound?.renderPresentation).toBeTypeOf("function");
          expect(outbound?.sendFormattedText).toBeTypeOf("function");
        },
        replyTo: async () => {
          await registerSignalReplyContext({
            to,
            replyToId,
            author: "+15555550123",
            body: "original message",
          });
          await sendMessage.text?.({ ...sendContext, text: "reply", replyToId });
          expect(send).toHaveBeenLastCalledWith(
            "+15555550123",
            "reply",
            expect.objectContaining({ replyToId }),
          );
        },
        messageSendingHooks: () => {
          expect(outbound?.shouldSuppressLocalPayloadPrompt).toBeTypeOf("function");
          expect(outbound?.renderPresentation).toBeTypeOf("function");
          expect(outbound?.afterDeliverPayload).toBeTypeOf("function");
        },
      },
    });

    expect(proofResults).toEqual([
      { capability: "text", status: "verified" },
      { capability: "media", status: "verified" },
      { capability: "poll", status: "not_declared" },
      { capability: "payload", status: "verified" },
      { capability: "silent", status: "not_declared" },
      { capability: "replyTo", status: "verified" },
      { capability: "thread", status: "not_declared" },
      { capability: "nativeQuote", status: "not_declared" },
      { capability: "messageSendingHooks", status: "verified" },
      { capability: "batch", status: "not_declared" },
      { capability: "reconcileUnknownSend", status: "not_declared" },
      { capability: "afterSendSuccess", status: "not_declared" },
      { capability: "afterCommit", status: "not_declared" },
    ]);
  });
});

describe("signal setup parsing", () => {
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
});
