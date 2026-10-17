import fs from "node:fs";
import path from "node:path";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IMessageRpcClient } from "./client.js";
import { resolveIMessageRemoteHost } from "./remote-host.js";
import {
  createIMessageOutboundRpcFixture,
  entitySeparator,
  expectNoRoleMarkers,
  expectScrubbedRequests,
  fencedYaml,
  hiddenFunctionResponse,
  nestMarkdownFences,
  privateRuntimeBlocks,
  privateRuntimeScaffolding,
  rawSeparator,
  roles,
} from "./test-support/outbound-rpc.test-support.js";
import { loadFreshIMessageReplyCacheForTest } from "./test-support/runtime.js";

type SendModule = typeof import("./send.js");
type SendOptions = Parameters<SendModule["sendMessageIMessage"]>[2];
type ChannelConfig = NonNullable<NonNullable<SendOptions["config"]["channels"]>["imessage"]>;
const config = (imessage: ChannelConfig) => ({ channels: { imessage } });
type ApprovalReactionsModule = typeof import("./approval-reactions.js");
let approvals: ApprovalReactionsModule;
let echoes: typeof import("./monitor/persisted-echo-cache.js");
let cache: typeof import("./monitor-reply-cache.js");
let transport: SendModule;
let IMessageRpcRequestError: typeof import("./client.js").IMessageRpcRequestError;
let PlatformMessageNotDispatchedError: typeof import("openclaw/plugin-sdk/error-runtime").PlatformMessageNotDispatchedError;

async function loadFreshSendModule() {
  cache = await loadFreshIMessageReplyCacheForTest({ reuseDatabase: true });
  ({ IMessageRpcRequestError } = await import("./client.js"));
  ({ PlatformMessageNotDispatchedError } = await import("openclaw/plugin-sdk/error-runtime"));
  approvals = await import("./approval-reactions.js");
  echoes = await import("./monitor/persisted-echo-cache.js");
  transport = await import("./send.js");
}

const outboundErrors = {
  hidden: "iMessage outbound hidden assistant content is not allowed",
  nested: "iMessage outbound ambiguous nested HTML is not allowed",
  malformed: "iMessage outbound runtime markup is malformed",
  role: "iMessage outbound role protection failed",
  empty: "iMessage send requires text or media",
  rich: "iMessage rich send requires text or an attachment after sanitization",
  edit: "iMessage edit requires non-empty text after sanitization",
  poll: "iMessage poll requires a non-empty question and options after sanitization",
};

const IMESSAGE_TEST_CFG = { channels: { imessage: { accounts: { default: {} } } } };

function createClient(result: Record<string, unknown>): IMessageRpcClient {
  return {
    request: vi.fn(async () => result),
    stop: vi.fn(async () => {}),
  } as unknown as IMessageRpcClient;
}

function createRejectingClient(error: Error, onRequest?: () => void): IMessageRpcClient {
  return {
    request: vi.fn(async () => {
      onRequest?.();
      await Promise.resolve();
      throw error;
    }),
    stop: vi.fn(async () => {}),
  } as unknown as IMessageRpcClient;
}

function createTimedOutSendClient() {
  const requestStarted = createDeferred<void>();
  return {
    client: createRejectingClient(new Error("imsg rpc timeout (send)"), requestStarted.resolve),
    requestStarted: requestStarted.promise,
  };
}

function beforeSettlement(gate: Promise<unknown>, send: Promise<unknown>, label: string) {
  return Promise.race([
    gate,
    send.then((cause) => {
      throw new Error(`Send settled before ${label}`, { cause });
    }),
  ]);
}

function expectStyledText(
  params:
    | { text: string; formatting?: Array<{ start: number; length: number; styles: string[] }> }
    | undefined,
  style: string,
  expected: string,
) {
  const range = params?.formatting?.find((item) => item.styles.includes(style));
  expect(params?.text.slice(range?.start, (range?.start ?? 0) + (range?.length ?? 0))).toBe(
    expected,
  );
}

function createApprovalText(id = "approval-123"): string {
  return `Exec approval required\nID: ${id}\n\nReply with: /approve ${id} allow-once|deny`;
}

function createApprovalPrompt(id = "approval-123") {
  return {
    approvalId: id,
    approvalKind: "exec" as const,
    allowedDecisions: ["allow-once", "deny"] as const,
  };
}

describe("sendMessageIMessage receipts", () => {
  let openClawState: OpenClawTestState;

  beforeEach(async () => {
    openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-imessage-send-",
    });
    await loadFreshSendModule();
  });

  afterEach(async () => {
    approvals.clearIMessageApprovalReactionTargetsForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await openClawState.cleanup();
  });

  function sendTo(target: string, text: string, options: Partial<SendOptions> = {}) {
    return transport.sendMessageIMessage(target, text, { config: IMESSAGE_TEST_CFG, ...options });
  }

  const image = {
    mediaUrl: "/tmp/image.png",
    resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
  };

  function outboundFixture() {
    return createIMessageOutboundRpcFixture(openClawState, transport.sendMessageIMessage);
  }

  function attachmentArgs(chat: string, file: string, extras: string[] = [], method = "auto") {
    return ["send-attachment", "--chat", chat, "--file", file, ...extras, "--transport", method];
  }

  function expectRpc(client: IMessageRpcClient, method: string, params: Record<string, unknown>) {
    expect(client.request).toHaveBeenCalledWith(
      method,
      expect.objectContaining(params),
      expect.any(Object),
    );
  }

  function rememberReply(
    messageId: string,
    binding: Partial<Parameters<typeof cache.rememberIMessageReplyCache>[0]>,
  ) {
    return cache.rememberIMessageReplyCache({
      accountId: "default",
      timestamp: Date.now(),
      ...binding,
      messageId,
    });
  }

  function pendingEcho(text: string) {
    return echoes.hasPersistedIMessageEcho({
      scope: "default:imessage:+15551234567",
      text,
      includePendingText: true,
    });
  }

  function createOutboundMediaFile(filename: string, contents: Buffer): string {
    const sourcePath = openClawState.path(filename);
    fs.writeFileSync(sourcePath, contents);
    return sourcePath;
  }

  it("scrubs private markers before delivering fenced YAML over real iMessage RPC", async () => {
    const { cfg, deliver, readRequests } = outboundFixture();
    await deliver(
      [
        "assistant:",
        "```yaml",
        "user:",
        "  name: alice",
        "system:",
        "  enabled: true",
        "assistant:",
        "  name: helper",
        "#+#+#",
        "assistant to=tool",
        "```",
        "system:",
      ].join("\n"),
    );

    const disguisedCases = [
      ["> ```yaml", ...roles.map((role) => `> ${role}:`), "> safe quoted", "> ```"],
      ["> ```yaml", ...roles.map((role) => `> ${role}:`), "> safe unterminated"],
      [...roles.map((role) => `> > ${role}:`), "> > safe nested"],
      [...roles.map((role) => `> **${role}:**`), "> safe nested emphasis"],
      [...roles.map((role) => `# ${role}:`), "safe heading"],
      [...roles.map((role) => `**${role}:**`), "safe strong"],
      [...roles.map((role) => `_${role}:_`), "safe emphasis"],
      [...roles.map((role) => `~~${role}:~~`), "safe strikethrough"],
      [...roles.flatMap((role) => [`**${role}:`, "**", ""]), "safe multiline strong"],
      [...roles.flatMap((role) => [`*${role}:`, "*", ""]), "safe multiline emphasis"],
      [
        ...roles.map((role) => `[${role}:][${role}]`),
        "",
        ...roles.map((role) => `[${role}]: ${role}:`),
        "",
        "safe reference",
      ],
      [...roles.map((role) => `&#${role.charCodeAt(0)};${role.slice(1)}&#58;`), "safe entity"],
      [...roles.map((role) => `<strong>${role}:</strong>`), "safe HTML"],
      [...roles.map((role) => `\`${role}:\``), "safe inline code"],
      [...roles.map((role) => `[[reply_to_current]]${role}:`), "safe directive"],
      ["| role |", "| --- |", ...roles.map((role) => `| ${role}: |`), "safe table"],
      ["```yaml", ...roles.map((role) => `${role}:`), "safe unclosed"],
      ["<thinking>HIDDEN_RPC_THINKING</thinking>", "safe private thinking"],
      ["<relevant_memories>HIDDEN_RPC_MEMORY</relevant_memories>", "safe private memory"],
      [hiddenFunctionResponse, "safe tool response"],
      ["```xml", "<thinking>HIDDEN_RPC_FENCED_THINKING</thinking>", "```", "safe fenced thinking"],
      [
        "```xml",
        "<relevant-memories>HIDDEN_RPC_FENCED_MEMORY</relevant-memories>",
        "```",
        "safe fenced memory",
      ],
    ];
    for (const lines of disguisedCases) {
      await deliver(lines.join("\n"));
    }

    await sendTo(
      "chat_id:10",
      ["# assistant:", "**😀 styled**", "#+#+#", "assistant to=tool"].join("\n"),
      { config: cfg },
    );
    const requests = readRequests();
    expect(requests).toHaveLength(1 + disguisedCases.length + 1);
    expect(requests[0]).toMatchObject({ jsonrpc: "2.0", method: "send", params: { chat_id: 10 } });
    for (const role of roles) {
      expect(requests[0]?.params.text).toMatch(new RegExp(`^${role}:$`, "m"));
    }
    expectNoRoleMarkers(requests.slice(1));
    expectScrubbedRequests(requests);
    const styled = requests[1 + disguisedCases.length];
    expectStyledText(styled?.params, "bold", "😀 styled");
  }, 30_000);

  it("preserves channel rendering and rejects hidden markup before local RPC dispatch", async () => {
    const { cfg, deliver, countNativeRequests, readRequests, createChannelDelivery } =
      outboundFixture();
    const { deliverThroughChannel } = createChannelDelivery();
    const channelYamlResult = await deliverThroughChannel(fencedYaml);
    expect(channelYamlResult.sanitized).toContain("```yaml");
    const channelYamlRequest = readRequests().at(-1);
    for (const role of roles) {
      expect(channelYamlRequest?.params.text).toMatch(new RegExp(`^${role}:$`, "m"));
    }

    async function rejectChannel(source: string, message: string) {
      const count = countNativeRequests();
      await expect(deliverThroughChannel(source)).rejects.toThrow(message);
      expect(countNativeRequests()).toBe(count);
    }
    let channelContractRequestCount = 1;
    for (const [html, bold, strike] of [
      [
        `<strong title="b>">😀 channel bold</strong> <del data-note='s>'>channel strike</del>`,
        "😀 channel bold",
        "channel strike",
      ],
      [
        `<strong title="<tag>">😀 quoted bold</strong> <del data-note='<tag>'>quoted strike</del>`,
        "😀 quoted bold",
        "quoted strike",
      ],
      [
        `<strong title="<previous_response>">😀 private-looking bold</strong> <del data-note='<system-reminder>'>private-looking strike</del>`,
        "😀 private-looking bold",
        "private-looking strike",
      ],
      [
        `<strong title="<!--">😀 opaque-looking bold</strong> <del data-note='<?'>opaque-looking strike</del>`,
        "😀 opaque-looking bold",
        "opaque-looking strike",
      ],
    ] as const) {
      const attributedHtml = await deliverThroughChannel(html);
      expect(attributedHtml.sanitized).toBe(`**${bold}** ~~${strike}~~`);
      const attributedRequest = readRequests().at(-1);
      for (const [style, expected] of Object.entries({ bold, strikethrough: strike })) {
        expectStyledText(attributedRequest?.params, style, expected);
      }
      channelContractRequestCount += attributedHtml.chunks.length;
    }

    const runtimeCompanion = `${privateRuntimeScaffolding}\nvisible runtime companion`;
    for (const sendPrivateRuntime of [
      () => sendTo("chat_id:10", runtimeCompanion, { config: cfg }),
      () => deliver(runtimeCompanion),
      () => deliverThroughChannel(runtimeCompanion),
    ]) {
      const previousRequestCount = countNativeRequests();
      await sendPrivateRuntime();
      const runtimeRequests = readRequests().slice(previousRequestCount);
      expect(runtimeRequests.length).toBeGreaterThan(0);
      expect(
        runtimeRequests.some((request) =>
          request.params?.text?.includes("visible runtime companion"),
        ),
      ).toBe(true);
      for (const request of runtimeRequests) {
        expect(request.params?.text).not.toContain("HIDDEN_RUNTIME_");
        expect(request.params?.text).not.toMatch(
          /system-reminder|previous_response|INTERNAL_CONTEXT/i,
        );
      }
      channelContractRequestCount += runtimeRequests.length;
    }

    for (const hidden of [
      "```xml\n<thinking>HIDDEN_CHANNEL_FENCED_THINKING</thinking>\n```",
      "`<thinking>HIDDEN_CHANNEL_INLINE_THINKING</thinking>`",
      "```xml\n<relevant_memories>HIDDEN_CHANNEL_FENCED_MEMORY</relevant_memories>\n```",
      "`<relevant-memories>HIDDEN_CHANNEL_INLINE_MEMORY</relevant-memories>`",
      nestMarkdownFences("<thinking>HIDDEN_CHANNEL_DEEPLY_NESTED_THINKING</thinking>", 4),
      nestMarkdownFences(
        "<relevant_memories>HIDDEN_CHANNEL_DEEPLY_NESTED_MEMORY</relevant_memories>",
        4,
      ),
      `\`\`\`xml\n${hiddenFunctionResponse}\n\`\`\``,
      nestMarkdownFences(hiddenFunctionResponse, 4),
    ]) {
      await rejectChannel(`${hidden}\nsafe channel text`, outboundErrors.hidden);
    }
    const malformedHiddenFunctionResponse = [
      '<<script>function_calls><<script>invoke name="exec">HIDDEN_CHANNEL_SYNTH_FUNCTION_CALL</<script>invoke></<script>function_calls><<script>function_response>',
      "HIDDEN_CHANNEL_SYNTH_FUNCTION_RESPONSE",
      "</<script>function_response>",
    ].join("\n");
    for (const malformed of [
      "<<script>thinking>HIDDEN_CHANNEL_SYNTH_THINKING</<script>thinking>",
      "<t<script>hinking>HIDDEN_CHANNEL_INNER_THINKING</t<script>hinking>",
      "<<script>relevant_memories>HIDDEN_CHANNEL_SYNTH_MEMORY</<script>relevant_memories>",
      "<<script>relevant-memories>HIDDEN_CHANNEL_SYNTH_HYPHEN_MEMORY</<script>relevant-memories>",
      "<thi<system-reminder>noise</system-reminder>nking>HIDDEN_CHANNEL_REMINDER_THINKING</thi<system-reminder>noise</system-reminder>nking>",
      "<relevant_<previous_response>noise</previous_response>memories>HIDDEN_CHANNEL_PREVIOUS_MEMORY</relevant_<previous_response>noise</previous_response>memories>",
      "<thi<details><summary>noise</summary></details>nking>HIDDEN_CHANNEL_DETAILS_THINKING</thi<details>nking>",
      malformedHiddenFunctionResponse,
    ]) {
      await rejectChannel(`${malformed}\nsafe channel text`, outboundErrors.nested);
    }
    for (const [context, splice] of Object.entries({
      script: "<script>",
      "system-reminder": "<system-reminder>noise</system-reminder>",
      spaced_system_reminder: "< system-reminder>noise< / system-reminder>",
      previous_response: "<previous_response>noise</previous_response>",
      spaced_previous_response: "< previous_response>noise< / previous_response>",
      details: "<details><summary>noise</summary></details>",
      spaced_details: "< details>< summary>noise< / summary>< / details>",
      runtime_context:
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>noise<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    })) {
      for (const [kind, malformed] of [
        ["thinking", `<thi${splice}nking>HIDDEN_CHANNEL_${context}_THINKING</thi${splice}nking>`],
        [
          "underscore memory",
          `<relevant_${splice}memories>HIDDEN_CHANNEL_${context}_MEMORY</relevant_${splice}memories>`,
        ],
        [
          "hyphen memory",
          `<relevant-${splice}memories>HIDDEN_CHANNEL_${context}_MEMORY</relevant-${splice}memories>`,
        ],
        [
          "tool response",
          [
            `<function_${splice}calls><invoke>HIDDEN_CHANNEL_${context}_CALL</invoke></function_${splice}calls>`,
            `<function_${splice}response>HIDDEN_CHANNEL_${context}_RESPONSE</function_${splice}response>`,
          ].join("\n"),
        ],
      ] as const) {
        for (const wrapper of [malformed, `\`${malformed}\``, `\`\`\`xml\n${malformed}\n\`\`\``]) {
          await rejectChannel(`${wrapper}\nsafe ${kind} ${context}`, outboundErrors.nested);
        }
      }
    }

    for (const splice of [
      "< system-reminder>noise< / system-reminder>",
      "< previous_response>noise< / previous_response>",
      "< details>< summary>noise< / summary>< / details>",
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>noise<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ]) {
      for (const name of [
        "thinking",
        "thought",
        "reasoning",
        "antml:thinking",
        "mm:thought",
        "relevant_memories",
        "relevant-memories",
        "function_calls",
        "function_response",
        "tool_calls",
        "tool_result",
      ]) {
        const malformed = `<${name}${splice}>HIDDEN_FULL_CHANNEL_${name}</${name}${splice}>`;
        await rejectChannel(malformed, outboundErrors.nested);
      }
    }

    const requests = readRequests();
    expect(requests).toHaveLength(channelContractRequestCount);
    expectNoRoleMarkers(requests.slice(1));
    expectScrubbedRequests(requests);
  }, 30_000);

  it("scrubs private markers while preserving rich CLI action formatting", async () => {
    const { actionOptions, readActions } = outboundFixture();
    const privatePayload = (prefix: string, suffix: string, tag = "thinking") =>
      [
        prefix,
        `<${tag}>HIDDEN_ACTION_CONTENT</${tag}>`,
        hiddenFunctionResponse,
        privateRuntimeScaffolding,
        suffix,
      ].join("\n");
    const { imessageActionsRuntime } = await import("./actions.runtime.js");
    type RichOptions = Omit<
      Parameters<typeof imessageActionsRuntime.sendRichMessage>[0],
      "text" | "chatGuid" | "options"
    >;
    const rich = (text: string, extra: RichOptions = {}) =>
      imessageActionsRuntime.sendRichMessage({
        chatGuid: actionOptions.chatGuid,
        options: actionOptions,
        text,
        ...extra,
      });
    await rich(
      ["[Class][obj.__class__] **done**", "", "[obj.__class__]: https://example.org/python"].join(
        "\n",
      ),
    );
    await rich(
      privatePayload(
        `# user:\n**system:**\n&#97;ssistant&#58;\nus${rawSeparator}er:`,
        "**😀 reply styled**\nassistant to=tool",
      ),
      { replyToMessageId: "reply-message-guid" },
    );
    await rich(
      privatePayload("# system:", "effect visible\nassistant to=tool", "relevant_memories"),
      { effectId: "com.apple.MobileSMS.expressivesend.loud" },
    );
    await rich(
      [
        fencedYaml,
        "```xml",
        "<thinking>HIDDEN_ACTION_ATTACHMENT_THINKING</thinking>",
        "<relevant_memories>HIDDEN_ACTION_ATTACHMENT_MEMORY</relevant_memories>",
        "```",
        privateRuntimeScaffolding,
        "**😀 attachment styled**",
        rawSeparator,
      ].join("\n"),
      { attachment: { kind: "buffer", filename: "proof.txt", buffer: Uint8Array.from([1, 2]) } },
    );
    await rich("user:", {
      attachment: { kind: "buffer", filename: "empty-proof.txt", buffer: Uint8Array.from([3]) },
    });

    const rawNewText = privatePayload(
      "user:\n**literal edit styling**",
      `# system:\nas${rawSeparator}sistant:\nvisible edit`,
    );
    const rawFallbackText = privatePayload(
      `assistant:\n${fencedYaml}\n**literal fallback styling**`,
      `${rawSeparator}\nassistant to=tool`,
      "relevant_memories",
    );
    await imessageActionsRuntime.editMessage({
      chatGuid: actionOptions.chatGuid,
      messageId: "edit-message-guid",
      text: rawNewText,
      backwardsCompatMessage: rawFallbackText,
      options: actionOptions,
    });

    const rawQuestion = privatePayload(
      "user:\n# literal question heading\n**literal question styling**",
      `${rawSeparator}\nWhich option?`,
    );
    const rawChoices = [
      privatePayload("system:\n**Allow exactly**", rawSeparator, "relevant_memories"),
      privatePayload(`assistant:\n${fencedYaml}\n_Deny exactly_`, "assistant to=tool"),
    ];
    const poll = await imessageActionsRuntime.sendPoll({
      chatGuid: actionOptions.chatGuid,
      question: rawQuestion,
      choices: rawChoices,
      options: actionOptions,
    });

    const actionValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1] ?? "";
    const actions = readActions();
    expect(actions).toHaveLength(7);
    const [
      dunderReferenceAction = [],
      replyAction = [],
      effectAction = [],
      attachmentAction = [],
      emptyAttachmentAction = [],
      editAction = [],
      pollAction = [],
    ] = actions;
    expect(actionValue(dunderReferenceAction, "--text")).toBe(
      "Class (https://example.org/python) done",
    );
    expect(JSON.parse(actionValue(dunderReferenceAction, "--format"))).toEqual([
      { start: 35, length: 4, styles: ["bold"] },
    ]);
    expect(replyAction).toContain("--reply-to");
    expect(actionValue(replyAction, "--reply-to")).toBe("reply-message-guid");
    expect(actionValue(effectAction, "--effect")).toBe("com.apple.MobileSMS.expressivesend.loud");
    expect(attachmentAction).toContain("--file");
    expect(attachmentAction).not.toContain("--format");
    expect(emptyAttachmentAction).toContain("--file");
    expect(actionValue(emptyAttachmentAction, "--text")).toBe("");

    const replyText = actionValue(replyAction, "--text");
    expect(replyText).not.toMatch(/^[ \t]*(?:user|system|assistant):[ \t]*$/gim);
    const replyFormatting = JSON.parse(actionValue(replyAction, "--format")) as Array<{
      start: number;
      length: number;
      styles: string[];
    }>;
    expectStyledText({ text: replyText, formatting: replyFormatting }, "bold", "😀 reply styled");
    const attachmentText = actionValue(attachmentAction, "--text");
    for (const role of roles) {
      expect(attachmentText).toMatch(new RegExp(`^${role}:$`, "m"));
    }

    const editedText = actionValue(editAction, "--new-text");
    const backwardsCompatText = actionValue(editAction, "--bc-text");
    expect(editedText).toContain("**literal edit styling**");
    expect(editedText).toContain("# system:");
    expect(editedText).not.toMatch(/^[ \t]*(?:user|system|assistant):[ \t]*$/gim);
    expect(backwardsCompatText).toContain(fencedYaml);
    expect(backwardsCompatText).toContain("**literal fallback styling**");

    const question = actionValue(pollAction, "--question");
    const pollChoices = pollAction.flatMap((arg, index) =>
      arg === "--option" ? [pollAction[index + 1] ?? ""] : [],
    );
    expect(question).toContain("# literal question heading");
    expect(question).toContain("**literal question styling**");
    expect(pollChoices[0]).toContain("**Allow exactly**");
    expect(pollChoices[1]).toContain(fencedYaml);
    expect(pollChoices[1]).toContain("_Deny exactly_");
    expect(poll.pollOptions.map((option) => option.text)).toEqual(
      pollChoices.map((choice) => choice.trim()),
    );

    for (const args of actions) {
      for (const flag of ["--text", "--new-text", "--bc-text", "--question", "--option"]) {
        for (let index = 0; index < args.length; index += 1) {
          if (args[index] !== flag) {
            continue;
          }
          const value = args[index + 1] ?? "";
          expect(value).not.toContain(rawSeparator);
          expect(value).not.toContain("HIDDEN_ACTION_");
          expect(value).not.toContain("HIDDEN_FUNCTION_");
          expect(value).not.toContain("HIDDEN_RUNTIME_");
          expect(value).not.toMatch(/system-reminder|previous_response|INTERNAL_CONTEXT/i);
          expect(value).not.toMatch(/<(?:thinking|relevant[-_]memories)\b/i);
          expect(value).not.toMatch(/assistant\s+to\s*=\s*\w+/i);
          expect(value).not.toMatch(/[\ue000-\uf8ff]/);
        }
      }
    }
  }, 30_000);

  it("rejects malformed, empty, and forged private content without native dispatch", async () => {
    const { cfg, actionOptions, deliver, readRequests, readActions, createChannelDelivery } =
      outboundFixture();
    const { deliverThroughChannel } = createChannelDelivery();
    const { imessageActionsRuntime } = await import("./actions.runtime.js");
    const actionBase = { chatGuid: actionOptions.chatGuid, options: actionOptions };
    const edit = (text: string, backwardsCompatMessage?: string) =>
      imessageActionsRuntime.editMessage({
        ...actionBase,
        messageId: "edit-message-guid",
        text,
        backwardsCompatMessage,
      });
    const poll = (question: string, choices: readonly string[] = ["first", "second"]) =>
      imessageActionsRuntime.sendPoll({ ...actionBase, question, choices });
    const rich = (text: string) => imessageActionsRuntime.sendRichMessage({ ...actionBase, text });
    function createRawTextActions(source: string, replacementText: string) {
      return [
        ["edit", () => edit(source, "visible fallback")],
        ["edit-fallback", () => edit(replacementText, source)],
        ["poll-question", () => poll(source)],
        ["poll-first-option", () => poll("visible question", [source, "second"])],
        ["poll-second-option", () => poll("visible question", ["first", source])],
      ] as const;
    }

    const forgedTokenEntity = "&#xE000;".repeat("user".length);
    const roleTokenSwap = [
      "```xml",
      "<thinking>",
      "user:",
      "</thinking>",
      "```",
      "&#xE000;&#xE000;&lt;relevant_memories&gt;HIDDEN_ROLE_SWAP&lt;/relevant_memories&gt;&#xE000;&#xE000;:",
    ].join("\n");
    for (const malformed of [
      "<system-reminder><system-reminder>inner</system-reminder>OUTER_PRIVATE_SECRET",
      "<system-reminder><previous_response>inner</previous_response>OUTER_PRIVATE_SECRET",
      "<previous_response><system-reminder />OUTER_PRIVATE_SECRET",
      "<system-reminder>`</system-reminder>`OUTER_PRIVATE_SECRET",
      "<system-reminder>`prefix </system-reminder> suffix`OUTER_PRIVATE_SECRET",
      "<system-reminder>``prefix </system-reminder> suffix``OUTER_PRIVATE_SECRET",
      "<system-reminder>`prefix </previous_response> suffix`OUTER_PRIVATE_SECRET",
      "<previous_response>```xml\n</system-reminder>\n```\nOUTER_PRIVATE_SECRET",
      "<system-reminder><plaintext></system-reminder>OUTER_PRIVATE_SECRET",
      "<previous_response><plaintext></previous_response>OUTER_PRIVATE_SECRET",
      "<system-reminder><PLAINTEXT /></system-reminder>OUTER_PRIVATE_SECRET",
      "<previous_response><PLAINTEXT /></previous_response>OUTER_PRIVATE_SECRET",
      "<system-reminder data-x=<previous_response>>OUTER_PRIVATE_SECRET",
      "<system-reminder <previous_response>>OUTER_PRIVATE_SECRET",
      "<previous_response data-x=<system-reminder>>OUTER_PRIVATE_SECRET",
      "</previous_response data-x=<system-reminder>>OUTER_PRIVATE_SECRET",
    ]) {
      for (const [wrapper, source] of [
        ["raw", malformed],
        ["inline", `\`${malformed}\``],
        ["fenced", `\`\`\`xml\n${malformed}\n\`\`\``],
        ["wide-fenced", `\`\`\`\`xml\n${malformed}\n\`\`\`\``],
      ] as const) {
        const previousActionCount = readActions().length;
        const previousRequestCount = readRequests().length;
        for (const [route, sendMalformed] of [
          ["rpc", () => sendTo("chat_id:10", source, { config: cfg })],
          ["monitor", () => deliver(source)],
          ["channel", () => deliverThroughChannel(source)],
          ["rich", () => rich(source)],
          ...createRawTextActions(source, "visible edit"),
        ] as const) {
          await expect(
            sendMalformed(),
            JSON.stringify({ malformed, wrapper, route }),
          ).rejects.toThrow(outboundErrors.malformed);
        }
        expect(readActions()).toHaveLength(previousActionCount);
        expect(readRequests()).toHaveLength(previousRequestCount);
      }
    }
    for (const hidden of privateRuntimeBlocks) {
      const previousActionCount = readActions().length;
      const previousRequestCount = readRequests().length;
      await expect(sendTo("chat_id:10", hidden, { config: cfg })).rejects.toThrow(
        outboundErrors.empty,
      );
      await expect(rich(hidden)).rejects.toThrow(outboundErrors.rich);
      for (const [text, backwardsCompatMessage] of [
        [hidden, "visible fallback"],
        ["visible edit", hidden],
      ] as const) {
        await expect(edit(text, backwardsCompatMessage)).rejects.toThrow(outboundErrors.edit);
      }
      for (const [questionText, choices] of [
        [hidden, ["first", "second"]],
        ["visible question", [hidden, "second"]],
        ["visible question", ["first", hidden]],
      ] as const) {
        await expect(poll(questionText, choices)).rejects.toThrow(outboundErrors.poll);
      }
      expect(readActions()).toHaveLength(previousActionCount);
      expect(readRequests()).toHaveLength(previousRequestCount);
    }
    await expect(sendTo("chat_id:10", "# user:", { config: cfg })).rejects.toThrow(
      outboundErrors.empty,
    );
    await expect(
      sendTo("chat_id:10", ["```yaml", "user:", "```", forgedTokenEntity].join("\n"), {
        config: cfg,
      }),
    ).rejects.toThrow(outboundErrors.role);
    const splitForgedToken = "&#xE000;&#xE000;" + entitySeparator + "&#xE000;&#xE000;";
    await expect(
      sendTo("chat_id:10", ["```yaml", "user:", "```", splitForgedToken].join("\n"), {
        config: cfg,
      }),
    ).rejects.toThrow(outboundErrors.role);
    await expect(
      sendTo("chat_id:10", "`<thinking>HIDDEN_RPC_INLINE_THINKING</thinking>`", { config: cfg }),
    ).rejects.toThrow(outboundErrors.hidden);
    await expect(sendTo("chat_id:10", roleTokenSwap, { config: cfg })).rejects.toThrow(
      outboundErrors.role,
    );
    await expect(
      sendTo("chat_id:10", nestMarkdownFences("<thinking>HIDDEN_RPC_DEEPLY_NESTED</thinking>", 4), {
        config: cfg,
      }),
    ).rejects.toThrow(outboundErrors.hidden);
    await expect(rich([fencedYaml, forgedTokenEntity].join("\n"))).rejects.toThrow(
      outboundErrors.role,
    );
    await expect(
      rich("`<relevant_memories>HIDDEN_ACTION_INLINE_MEMORY</relevant_memories>`"),
    ).rejects.toThrow(outboundErrors.hidden);
    await expect(rich(roleTokenSwap)).rejects.toThrow(outboundErrors.role);
    await expect(
      rich(nestMarkdownFences("<relevant_memories>HIDDEN_RICH_NESTED</relevant_memories>", 4)),
    ).rejects.toThrow(outboundErrors.hidden);
    await expect(rich("# user:")).rejects.toThrow(outboundErrors.rich);
    await expect(edit("user:")).rejects.toThrow(outboundErrors.edit);
    await expect(edit("safe edit", "system:")).rejects.toThrow(outboundErrors.edit);
    for (const [questionText, choices] of [
      ["assistant:", ["first", "second"]],
      ["safe question", ["first", "system:"]],
    ] as const) {
      await expect(poll(questionText, choices)).rejects.toThrow(outboundErrors.poll);
    }
    await expect(poll("Choose one", ["Allow", `Al${rawSeparator}low`])).rejects.toThrow(
      "iMessage poll options must remain distinct after sanitization",
    );

    for (const [, sendSwappedRole] of createRawTextActions(roleTokenSwap, "visible replacement")) {
      await expect(sendSwappedRole()).rejects.toThrow(outboundErrors.role);
    }

    for (const tag of ["thinking", "relevant_memories"] as const) {
      for (const hidden of [
        `<${tag}>HIDDEN_RAW_CODE_PAYLOAD</${tag}>`,
        `<${tag}>HIDDEN_UNTERMINATED_RAW_CODE_PAYLOAD`,
        ...(tag === "thinking" ? [hiddenFunctionResponse] : []),
      ]) {
        for (const wrapped of [
          `\`\`\`xml\n${hidden}\n\`\`\``,
          `\`${hidden}\``,
          nestMarkdownFences(hidden, 3),
        ]) {
          const actionsWithHiddenCode = createRawTextActions(wrapped, "visible replacement");
          for (const [, sendHiddenCode] of actionsWithHiddenCode) {
            await expect(sendHiddenCode()).rejects.toThrow(outboundErrors.hidden);
          }
        }
      }
    }
    expect(readActions()).toHaveLength(0);
    expect(readRequests()).toHaveLength(0);
  }, 30_000);

  it.each(["guid", "failure"] as const)(
    "awaits owned RPC close before settling a %s send",
    async (outcome) => {
      const requestError = new Error("synthetic request failure");
      const rpc = createClient({ guid: "p:0/close-proof" });
      const mocks = vi.mocked(rpc);
      if (outcome === "failure") {
        mocks.request.mockRejectedValue(requestError);
      }
      const closing = createDeferred<void>();
      const releaseClose = createDeferred<void>();
      mocks.stop.mockImplementation(() => {
        closing.resolve();
        return releaseClose.promise;
      });
      let settled = false;
      const observed = sendTo("chat_id:42", "close proof", { createClient: async () => rpc }).then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      try {
        await beforeSettlement(closing.promise, observed, "owned RPC close");
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).toBe(false);
        expect(mocks.request.mock.calls).toHaveLength(1);
        expect(mocks.stop.mock.calls).toHaveLength(1);
        releaseClose.resolve();
        if (outcome === "failure") {
          await expect(observed).resolves.toEqual({ error: requestError });
        } else {
          await expect(observed).resolves.toMatchObject({
            value: {
              messageId: "p:0/close-proof",
              receipt: { platformMessageIds: ["p:0/close-proof"] },
            },
          });
        }
      } finally {
        releaseClose.resolve();
        await observed;
      }
    },
  );

  it.each(["owned", "borrowed"] as const)(
    "keeps %s client custody when options change during an accepted request",
    async (ownership) => {
      const started = createDeferred<void>();
      const response = createDeferred<Record<string, unknown>>();
      const rpc = createClient({ guid: "p:0/captured-owner" });
      const mocks = vi.mocked(rpc);
      mocks.request.mockImplementation(() => {
        started.resolve();
        return response.promise;
      });
      const options: SendOptions = {
        config: IMESSAGE_TEST_CFG,
        ...(ownership === "borrowed" ? { client: rpc } : { createClient: async () => rpc }),
      };
      const observed = transport
        .sendMessageIMessage("chat_id:42", "captured ownership", options)
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      try {
        await beforeSettlement(started.promise, observed, "RPC request");
        options.client = ownership === "owned" ? rpc : undefined;
        response.resolve({ guid: "p:0/captured-owner" });
        await expect(observed).resolves.toMatchObject({
          value: { messageId: "p:0/captured-owner" },
        });
        expect(mocks.request.mock.calls).toHaveLength(1);
        expect(mocks.stop.mock.calls).toHaveLength(ownership === "owned" ? 1 : 0);
      } finally {
        response.resolve({ guid: "p:0/captured-owner" });
        await observed;
      }
    },
  );

  it("preserves the default CLI attachment rejection", async () => {
    const cliPath = openClawState.path("fake-attachment-cli");
    const logPath = openClawState.path("attachment-cli-argv.jsonl");
    const dbPath = openClawState.path("unused-chat.db");
    const mediaPath = createOutboundMediaFile("fixture.pdf", Buffer.from("%PDF-1.4\nsynthetic"));
    const response = { success: false, error: "synthetic CLI rejection" };
    fs.writeFileSync(
      cliPath,
      [
        "#!" + process.execPath,
        'const fs = require("node:fs");',
        `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        `process.stdout.write(${JSON.stringify(JSON.stringify(response) + "\n")});`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const createRpc = vi.fn(async () => createClient({ guid: "unexpected-rpc" }));
    const sending = sendTo("chat_guid:fixture-chat", "", {
      config: config({ accounts: { default: { cliPath, dbPath } } }),
      mediaUrl: mediaPath,
      resolveAttachmentImpl: async () => ({ path: mediaPath, contentType: "application/pdf" }),
      createClient: createRpc,
    });
    await expect(sending).rejects.toThrow("synthetic CLI rejection");
    expect(createRpc).not.toHaveBeenCalled();
    const calls = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([
      [...attachmentArgs("fixture-chat", mediaPath), "--db", dbPath, "--json"],
    ]);
  });

  it("joins pending echo persistence before sending and its rollback before rejecting", async () => {
    const { getIMessageRuntime } = await import("./runtime.js");
    const state = getIMessageRuntime().state;
    const openStore = state.openKeyedStoreV2.bind(state);
    const writeStarted = createDeferred<void>();
    const writeGate = createDeferred<void>();
    const deleteStarted = createDeferred<void>();
    const deleteGate = createDeferred<void>();
    const openSpy = vi
      .spyOn(state, "openKeyedStoreV2")
      .mockImplementation(<T>(options: OpenAsyncKeyedStoreOptions) => {
        const store = openStore<T>(options);
        if (options.namespace === "imessage.sent-echoes") {
          const register = store.register.bind(store);
          const remove = store.delete.bind(store);
          vi.spyOn(store, "register").mockImplementation(async (...args) => {
            writeStarted.resolve();
            await writeGate.promise;
            await register(...args);
          });
          vi.spyOn(store, "delete").mockImplementation(async (...args) => {
            deleteStarted.resolve();
            await deleteGate.promise;
            return await remove(...args);
          });
        }
        return store;
      });
    const client = createClient({ success: false, error: "recipient is not registered" });
    let settled = false;
    const send = sendTo("+15551234567", "hello", { client }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await beforeSettlement(writeStarted.promise, send, "pending echo persistence");
      expect(client.request).not.toHaveBeenCalled();
      writeGate.resolve();
      await beforeSettlement(deleteStarted.promise, send, "pending echo rollback");
      expect(settled).toBe(false);
      deleteGate.resolve();
      expect(await send).toEqual(new Error("recipient is not registered"));
      expect(await pendingEcho("hello")).toBe(false);
    } finally {
      writeGate.resolve();
      deleteGate.resolve();
      await send;
      openSpy.mockRestore();
    }
  });

  it("maps authoritative attachment pre-dispatch failure to retry-safe custody", async () => {
    const rpcError = new IMessageRpcRequestError("Delivery failed before dispatch", -32603, {
      retry_safe: true,
      disposition: "not_started",
      transport: "bridge_v2",
      operation: "send-attachment",
    });
    const client = createRejectingClient(rpcError);
    const rejection = await sendTo("chat_id:42", "", {
      config: config({ accounts: { default: { remoteHost: "work@messages-b" } } }),
      mediaUrl: "/gateway/photo.png",
      resolveAttachmentImpl: async () => ({ path: "/gateway/photo.png" }),
      createClient: async () => client,
      withRemoteFile: async (params) => await params.use("/tmp/openclaw-imessage-safe/photo.png"),
    }).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(rejection).toMatchObject({ message: rpcError.message, cause: rpcError });
    expect(client.request).toHaveBeenCalledOnce();
    expectRpc(client, "send.attachment", { file: "/tmp/openclaw-imessage-safe/photo.png" });
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it("keeps a missing retry-safe flag ambiguous", async () => {
    const rpcError = new IMessageRpcRequestError("Delivery outcome remains ambiguous", -32001, {
      disposition: "not_started",
    });
    const client = createRejectingClient(rpcError);

    const rejection = await sendTo("chat_id:42", "hello", {
      client,
    }).catch((error: unknown) => error);

    expect(rejection).toBe(rpcError);
    expect(rejection).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
  });

  it("drops disabled reply metadata from an attachment send", async () => {
    const client = createClient({ guid: "p:0/plain-guid" });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/plain-guid" });
    const result = await sendTo("chat_guid:chat-1", "", {
      config: config({ actions: { reply: false }, accounts: { default: {} } }),
      client,
      replyToId: "p:0/reply-guid",
      ...image,
      runCliJson,
    });
    expect(result.messageId).toBe("p:0/plain-guid");
    expect(result.receipt.replyToId).toBeUndefined();
    expect(result.receipt.parts[0]?.replyToId).toBeUndefined();
    expect(runCliJson.mock.calls).toEqual([[attachmentArgs("chat-1", "/tmp/image.png")]]);
    expect(client.request).not.toHaveBeenCalled();
  });

  it.each([
    { target: "chat_id:42", replyToId: "unbound-reply-guid", binding: undefined },
    {
      target: "+15550004567",
      replyToId: "ambiguous-service-guid",
      binding: { chatGuid: "SMS;-;+15550004567", chatIdentifier: "+15550004567" },
    },
  ])(
    "rejects an unbound or service-ambiguous delegated reply to $target",
    async ({ target, replyToId, binding }) => {
      const client = createClient({ guid: "should-not-send" });
      const resolveAttachment = vi.fn(image.resolveAttachmentImpl);
      if (binding) {
        await rememberReply(replyToId, binding);
      }
      await expect(
        sendTo(target, binding ? "hello" : "caption", {
          config: config({ remoteHost: "qa@example.invalid", accounts: { default: {} } }),
          client,
          conversationReadOrigin: "delegated",
          replyToId,
          ...(binding
            ? {}
            : { mediaUrl: image.mediaUrl, resolveAttachmentImpl: resolveAttachment }),
        }),
      ).rejects.toThrow("require a current same-account conversation binding");
      expect(resolveAttachment).not.toHaveBeenCalled();
      expect(client.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      target: "chat_id:42",
      replyToId: "bound-reply-guid",
      service: undefined,
      binding: { chatId: 42 },
      rpcTarget: { chat_id: 42 },
    },
    {
      target: "+15550004567",
      replyToId: "sms-reply-guid",
      service: "sms",
      binding: { chatGuid: "SMS;-;+15550004567", chatIdentifier: "+15550004567" },
      rpcTarget: { to: "+15550004567", service: "sms" },
    },
  ] as const)(
    "authorizes a delegated reply with a current binding for $target",
    async ({ target, replyToId, service, binding, rpcTarget }) => {
      const client = createClient({ guid: "p:0/imsg-bound" });
      await rememberReply(replyToId, binding);
      await expect(
        sendTo(target, "hello", {
          config: config({ remoteHost: "qa@example.invalid", accounts: { default: {} } }),
          client,
          service,
          conversationReadOrigin: "delegated",
          replyToId,
        }),
      ).resolves.toMatchObject({ messageId: "p:0/imsg-bound" });
      expectRpc(client, "send", { ...rpcTarget, reply_to: replyToId });
    },
  );

  it("keeps named-account remote transport identity isolated", async () => {
    const client = createClient({ guid: "p:0/imsg-account-isolation" });
    const createClientForAccount = vi.fn(async () => client);

    await sendTo("chat_id:42", "hello", {
      config: config({
        cliPath: "/gateway/default-imsg",
        dbPath: "/Users/default/Library/Messages/chat.db",
        remoteHost: "default@messages-a",
        accounts: {
          work: {
            cliPath: "/gateway/work-imsg",
            dbPath: "~/Library/Messages/chat.db",
            remoteHost: "work@messages-b",
          },
        },
      }),
      accountId: "work",
      createClient: createClientForAccount,
    });

    expect(createClientForAccount).toHaveBeenCalledWith({
      cliPath: "/gateway/work-imsg",
      dbPath: "~/Library/Messages/chat.db",
      remoteHost: "work@messages-b",
    });
    expect(createClientForAccount).not.toHaveBeenCalledWith(
      expect.objectContaining({ remoteHost: "default@messages-a" }),
    );
  });

  it("resolves service-qualified remote media through the canonical send RPC", async () => {
    const client = createClient({
      guid: "p:0/remote-resolved-media",
      chat_guid: "any;-;+15550004567",
      service: "iMessage",
    });
    const createClientForAccount = vi.fn(async () => client);
    const withRemoteFile = vi.fn(
      async (params: { use: (remotePath: string) => Promise<Record<string, unknown>> }) =>
        await params.use("/tmp/openclaw-imessage-safe/photo.png"),
    );

    const result = await sendTo("imessage:+15550004567", "", {
      config: config({ accounts: { default: { remoteHost: "work@messages-b" } } }),
      mediaUrl: "/gateway/photo.png",
      resolveAttachmentImpl: async () => ({ path: "/gateway/photo.png" }),
      createClient: createClientForAccount,
      withRemoteFile: withRemoteFile as never,
    });

    expect(withRemoteFile).toHaveBeenCalledWith(
      expect.objectContaining({ remoteHost: "work@messages-b", localPath: "/gateway/photo.png" }),
    );
    expectRpc(client, "send", {
      to: "+15550004567",
      file: "/tmp/openclaw-imessage-safe/photo.png",
      service: "imessage",
    });
    expect(client.request).not.toHaveBeenCalledWith(
      "send.attachment",
      expect.anything(),
      expect.anything(),
    );
    expect(result).toMatchObject({
      messageId: "p:0/remote-resolved-media",
      chatGuid: "any;-;+15550004567",
      service: "imessage",
    });
  });

  it("fails closed before staging media from an ambiguous proxy wrapper", async () => {
    const sshOperands = "-o ProxyCommand=jump@proxy bot@messages-mac";
    const cliPath = createOutboundMediaFile(
      "imsg-jump-wrapper",
      Buffer.from(`#!/bin/sh\nexec ssh ${sshOperands} imsg "$@"\n`),
    );
    const runCliJson = vi
      .fn()
      .mockResolvedValueOnce({ guid: "iMessage;+;chat0000" })
      .mockResolvedValueOnce({ guid: "p:0/local-media" });
    const withRemoteFile = vi.fn();

    await expect(
      sendTo("chat_id:42", "", {
        config: config({ cliPath }),
        mediaUrl: "/gateway/photo.png",
        resolveAttachmentImpl: async () => ({ path: "/gateway/photo.png" }),
        runCliJson,
        withRemoteFile: withRemoteFile as never,
      }),
    ).rejects.toThrow("configure channels.imessage.remoteHost explicitly");

    expect(runCliJson).not.toHaveBeenCalled();
    expect(withRemoteFile).not.toHaveBeenCalled();
  });

  it("floors a configured probe timeout so one delayed imsg fallback can resolve", async () => {
    vi.useFakeTimers();
    const delayedFallbackMs = 158_000;
    const requestStarted = createDeferred<void>();
    const client = {
      request: vi.fn(
        (_method: string, _params: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
          requestStarted.resolve();
          return new Promise<Record<string, unknown>>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("imsg rpc timeout (send)")),
              opts?.timeoutMs,
            );
            setTimeout(() => {
              clearTimeout(timeout);
              resolve({ guid: "p:0/imsg-delayed-fallback" });
            }, delayedFallbackMs);
          });
        },
      ),
      stop: vi.fn(async () => {}),
    } as unknown as IMessageRpcClient;

    const send = sendTo("chat_id:42", "hello", {
      config: config({ ...IMESSAGE_TEST_CFG.channels.imessage, probeTimeoutMs: 10_000 }),
      client,
    });
    await requestStarted.promise;
    await vi.advanceTimersByTimeAsync(delayedFallbackMs);

    await expect(send).resolves.toMatchObject({ messageId: "p:0/imsg-delayed-fallback" });
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith(
      "send",
      expect.any(Object),
      expect.objectContaining({ timeoutMs: 180_000 }),
    );
  });

  it("sends native voice as a threaded reply", async () => {
    const replyToId = "p:0/reply-guid";
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageGuid: "p:0/voice-guid" });

    const result = await sendTo("chat_guid:chat-1", "", {
      client,
      mediaUrl: "/tmp/voice.caf",
      audioAsVoice: true,
      conversationReadOrigin: "direct-operator",
      replyToId,
      resolveAttachmentImpl: async () => ({ path: "/tmp/voice.caf", contentType: "audio/x-caf" }),
      runCliJson,
    });

    expect(result).toMatchObject({
      messageId: "p:0/voice-guid",
      guid: "p:0/voice-guid",
      receipt: { replyToId, platformMessageIds: ["p:0/voice-guid"] },
    });
    expect(runCliJson.mock.calls).toEqual([
      [attachmentArgs("chat-1", "/tmp/voice.caf", ["--audio", "--reply-to", replyToId])],
    ]);
    expect(result.receipt.parts.map((part) => part.kind)).toEqual(["voice"]);
    expect(client["request"]).not.toHaveBeenCalled();
  });

  it("rejects threaded AppleScript voice notes without downgrading native audio", async () => {
    const replyToId = "p:0/reply-guid";
    const client = createClient({ guid: "should-not-send" });
    const runCliJson = vi.fn();

    await expect(
      sendTo("chat_guid:chat-1", "", {
        config: config({ sendTransport: "applescript" }),
        client,
        conversationReadOrigin: "direct-operator",
        mediaUrl: "/tmp/voice.caf",
        audioAsVoice: true,
        replyToId,
        resolveAttachmentImpl: async () => ({ path: "/tmp/voice.caf", contentType: "audio/x-caf" }),
        runCliJson,
      }),
    ).rejects.toThrow("voice messages require bridge transport");

    expect(runCliJson).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });

  it.each([
    {
      target: "chat_guid:chat-1",
      error: "unknown command send-attachment",
      command: attachmentArgs("chat-1", "/tmp/image.png"),
      rpcTarget: { chat_guid: "chat-1" },
    },
    {
      target: "chat_id:42",
      error: "private API bridge unavailable",
      command: ["group", "--chat-id", "42"],
      rpcTarget: { chat_id: 42 },
    },
  ])(
    "falls back to RPC when native attachment preparation fails for $target",
    async ({ target, error, command, rpcTarget }) => {
      const client = createClient({ message_id: 12345 });
      const runCliJson = vi.fn().mockRejectedValueOnce(new Error(error));

      const result = await sendTo(target, "", { client, ...image, runCliJson });

      expect(result.messageId).toBe("12345");
      expect(runCliJson.mock.calls).toEqual([[command]]);
      expectRpc(client, "send", { ...rpcTarget, file: "/tmp/image.png", text: "" });
    },
  );

  it("preserves explicit bridge delivery for a new service-qualified media chat", async () => {
    const client = createClient({ guid: "should-not-send" });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageGuid: "p:0/bridge-media-guid" });

    await sendTo("imessage:+15550004567", "", {
      config: config({ sendTransport: "bridge" }),
      client,
      ...image,
      runCliJson,
    });

    expect(runCliJson).toHaveBeenCalledWith(
      attachmentArgs("iMessage;-;+15550004567", "/tmp/image.png", [], "dylib"),
    );
    expect(client.request).not.toHaveBeenCalled();
  });

  it("preserves staged filenames across native RPC sends and their unthreaded retry", async () => {
    const filename = "threaded-review.pdf";
    const attachmentBytes = Buffer.from("actual native rpc provider bytes");
    const sourcePath = createOutboundMediaFile(filename, attachmentBytes);
    const deliveredPaths: string[] = [];
    const client = {
      request: vi.fn(async (_method: string, params: Record<string, unknown>) => {
        const attachmentPath = params.file as string;
        deliveredPaths.push(attachmentPath);
        expect(fs.readFileSync(attachmentPath)).toEqual(attachmentBytes);
        if (params.reply_to) {
          throw new Error(
            "reply_to requires bridge transport; AppleScript fallback cannot send threaded replies",
          );
        }
        return { guid: "p:0/provider-accepted-rpc" };
      }),
      stop: vi.fn(async () => {}),
    } as unknown as IMessageRpcClient;

    const result = await sendTo("chat_id:42", "caption", {
      client,
      conversationReadOrigin: "direct-operator",
      replyToId: "p:0/thread-root",
      mediaUrl: sourcePath,
      mediaLocalRoots: [openClawState.root],
    });

    expect(result.messageId).toBe("p:0/provider-accepted-rpc");
    expect(result.receipt.replyToId).toBeUndefined();
    expect(deliveredPaths.map((attachmentPath) => path.basename(attachmentPath))).toEqual([
      filename,
      filename,
    ]);
    expect(deliveredPaths.every((attachmentPath) => !fs.existsSync(attachmentPath))).toBe(true);
    expect(fs.readdirSync(openClawState.statePath("media", "outbound"))).toHaveLength(1);
  });

  it.each(["caption", "custody"] as const)(
    "preserves accepted attachment evidence after %s failure",
    async (phase) => {
      const failure = new Error(
        phase === "caption" ? "caption failed" : "accepted attachment custody failed",
      );
      const client =
        phase === "caption"
          ? createRejectingClient(failure)
          : createClient({ guid: "p:0/caption-guid" });
      const runCliJson = vi
        .fn()
        .mockResolvedValueOnce(
          phase === "caption"
            ? { messageGuid: "p:0/dm-media-guid" }
            : { messageId: "p:0/dm-media-guid" },
        );
      const onDeliveryResult = vi.fn(async () => {
        if (phase === "custody") {
          throw failure;
        }
      });
      const observed = await sendTo("+15550004567", "caption", {
        client,
        ...image,
        runCliJson,
        onDeliveryResult,
      }).catch((error: unknown) => error);
      expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          content: "",
          messageId: "p:0/dm-media-guid",
          messageIds: ["p:0/dm-media-guid"],
          receipt: expect.objectContaining({ platformMessageIds: ["p:0/dm-media-guid"] }),
          visibleReplySent: true,
        }),
      );
      if (phase === "custody") {
        expect(observed).toBe(failure);
        expect(isChannelPartialDeliveryError(failure)).toBe(false);
        expect(runCliJson).toHaveBeenCalledOnce();
        expect(client.request).not.toHaveBeenCalled();
      } else {
        expect(isChannelPartialDeliveryError(observed)).toBe(true);
        expect(observed).toMatchObject({
          code: "CHANNEL_PARTIAL_DELIVERY",
          cause: failure,
          sentBeforeError: true,
          visibleReplySent: true,
          deliveryResult: {
            content: "",
            messageIds: ["p:0/dm-media-guid"],
            visibleReplySent: true,
            receipt: {
              primaryPlatformMessageId: "p:0/dm-media-guid",
              platformMessageIds: ["p:0/dm-media-guid"],
              parts: [expect.objectContaining({ kind: "media" })],
            },
          },
        });
        const scope = "default:imessage:+15550004567";
        expect(await echoes.hasPersistedIMessageEcho({ scope, text: "caption" })).toBe(false);
        expect(
          await echoes.hasPersistedIMessageEcho({
            scope,
            media: { contentType: "image/png", kind: "image" },
          }),
        ).toBe(true);
        expect(
          await echoes.hasPersistedIMessageEcho({ scope, messageId: "p:0/dm-media-guid" }),
        ).toBe(true);
      }
    },
  );

  it.each([false, true])("combines caption receipts with owned client %s", async (ownsClient) => {
    const target = "+15550004567";
    const mediaId = ownsClient ? "p:0/dm-media-guid" : undefined;
    const attachment = mediaId ? { messageId: mediaId } : { success: true };
    const client = createClient({ guid: "p:0/caption-guid" });
    const createClientImpl = vi.fn(async () => client);
    const runCliJson = vi.fn().mockResolvedValueOnce(attachment);
    const result = await sendTo(target, "caption", {
      ...(ownsClient ? { createClient: createClientImpl } : { client }),
      ...image,
      runCliJson,
    });
    expectRpc(client, "send", { to: target, text: "caption" });
    expect(createClientImpl).toHaveBeenCalledTimes(ownsClient ? 1 : 0);
    expect(client.stop).toHaveBeenCalledTimes(ownsClient ? 1 : 0);
    expect(result).toMatchObject({ messageId: mediaId ?? "p:0/caption-guid", sentText: "caption" });
    expect(result.receipt.platformMessageIds).toEqual(
      mediaId ? [mediaId, "p:0/caption-guid"] : ["p:0/caption-guid"],
    );
    expect(result.receipt.parts.map((part) => part.kind)).toEqual(
      mediaId ? ["media", "text"] : ["text"],
    );
  });

  it("keeps the pending echo marker alive for slow default-timeout sends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-04T00:00:00Z"));
    const requestStarted = createDeferred<void>();
    const response = createDeferred<Record<string, unknown>>();
    const client = {
      request: vi.fn(() => {
        requestStarted.resolve();
        return response.promise;
      }),
      stop: vi.fn(async () => {}),
    } as unknown as IMessageRpcClient;

    const send = sendTo("+15551234567", "slow hello", { client });
    await requestStarted.promise;

    vi.setSystemTime(new Date("2026-06-04T00:01:01Z"));
    expect(await pendingEcho("slow hello")).toBe(true);

    response.resolve({ guid: "p:0/imsg-slow" });
    await expect(send).resolves.toMatchObject({ messageId: "p:0/imsg-slow" });
  });

  it("awaits approval binding completion before returning a send receipt", async () => {
    const persisted =
      createDeferred<
        Awaited<ReturnType<ApprovalReactionsModule["registerIMessageApprovalReactionTarget"]>>
      >();
    const started = createDeferred<void>();
    vi.spyOn(approvals, "registerIMessageApprovalReactionTarget").mockImplementation(() => {
      started.resolve();
      return persisted.promise;
    });
    let completed = false;
    const send = sendTo("chat_id:42", createApprovalText(), {
      client: createClient({ guid: "p:0/durable-approval" }),
      dbPath: openClawState.path("synthetic-chat.db"),
      approvalPrompt: createApprovalPrompt(),
    }).then((receipt) => {
      completed = true;
      return receipt;
    });
    try {
      await started.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(completed).toBe(false);
      persisted.resolve({
        approvalId: "approval-123",
        approvalKind: "exec",
        allowedDecisions: ["allow-once", "deny"],
      });
      await expect(send).resolves.toMatchObject({ guid: "p:0/durable-approval" });
    } finally {
      persisted.resolve(null);
      await Promise.allSettled([send]);
    }
  });

  it.each(["local", "remote"] as const)(
    "uses only the %s receipt database after an RPC timeout",
    async (host) => {
      const remote = host === "remote";
      vi.stubEnv("HOME", "/Users/me");
      const cliPath = remote
        ? createOutboundMediaFile(
            "imsg",
            Buffer.from('#!/bin/sh\nexec ssh -T gateway-host imsg "$@"\n'),
          )
        : "/opt/homebrew/bin/imsg";
      if (remote) {
        await resolveIMessageRemoteHost({ cliPath });
        vi.useFakeTimers({ now: 1_000 });
      }
      const { client, requestStarted } = createTimedOutSendClient();
      const runCliJson = vi.fn();
      const resolveSentMessageGuidImpl = vi.fn(async () => (remote ? null : "p:0/default-db-guid"));
      const id = remote ? "approval-remote" : "approval-default";
      const sending = sendTo("chat_id:42", createApprovalText(id), {
        approvalPrompt: createApprovalPrompt(id),
        client,
        cliPath,
        runCliJson,
        resolveSentMessageGuidImpl,
      });
      if (remote) {
        const rejection = expect(sending).rejects.toThrow("imsg rpc timeout (send)");
        await requestStarted;
        await vi.advanceTimersByTimeAsync(5_000);
        await rejection;
      } else {
        await expect(sending).resolves.toMatchObject({ messageId: "p:0/default-db-guid" });
      }
      expect(runCliJson).not.toHaveBeenCalled();
      expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith({
        dbPath: remote ? undefined : "/Users/me/Library/Messages/chat.db",
        target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
        text: expect.stringContaining(`ID: ${id}`),
        sentAfterMs: expect.any(Number),
      });
    },
  );

  it("recovers approval tapback GUIDs when RPC returns an unknown placeholder", async () => {
    const client = createClient({ messageId: "unknown", status: "sent" });
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/recovered-guid");

    const result = await sendTo("chat_id:42", createApprovalText(), {
      approvalPrompt: createApprovalPrompt(),
      client,
      dbPath: "/Users/me/Library/Messages/chat.db",
      resolveSentMessageGuidImpl,
    });

    expect(result).toMatchObject({ messageId: "unknown", guid: "p:0/recovered-guid" });
    await expect(
      approvals.resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { chatId: 42 },
        messageId: "p:0/recovered-guid",
        reactionKey: "👍",
      }),
    ).resolves.toEqual({
      approvalId: "approval-123",
      approvalKind: "exec",
      decision: "allow-once",
    });
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: "/Users/me/Library/Messages/chat.db",
      target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
      text: expect.stringContaining("ID: approval-123"),
      sentAfterMs: expect.any(Number),
    });
  });

  it("does not poll for approval prompt GUIDs when chat.db is unavailable", async () => {
    vi.useFakeTimers();
    const client = createClient({ status: "sent" });

    const result = await sendTo("chat_id:42", createApprovalText(), {
      approvalPrompt: createApprovalPrompt(),
      client,
    });

    // Fake timers are intentionally not advanced: entering the polling loop
    // would leave this awaited send pending and fail the test by timeout.
    expect(result.messageId).toBe("ok");
    expect(result.guid).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
