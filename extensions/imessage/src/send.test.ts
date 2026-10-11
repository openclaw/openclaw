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

type ApprovalReactionsModule = typeof import("./approval-reactions.js");
type ClientModule = typeof import("./client.js");
type ErrorRuntimeModule = typeof import("openclaw/plugin-sdk/error-runtime");
type PersistedEchoCacheModule = typeof import("./monitor/persisted-echo-cache.js");
type ReplyCacheModule = typeof import("./monitor-reply-cache.js");
type SendModule = typeof import("./send.js");
let clearIMessageApprovalReactionTargetsForTest: ApprovalReactionsModule["clearIMessageApprovalReactionTargetsForTest"];
let IMessageRpcRequestError: ClientModule["IMessageRpcRequestError"];
let PlatformMessageNotDispatchedError: ErrorRuntimeModule["PlatformMessageNotDispatchedError"];
let resolveIMessageApprovalReactionTargetWithPersistence: ApprovalReactionsModule["resolveIMessageApprovalReactionTargetWithPersistence"];
let hasPersistedIMessageEcho: PersistedEchoCacheModule["hasPersistedIMessageEcho"];
let findLatestIMessageEntryForChat: ReplyCacheModule["findLatestIMessageEntryForChat"];
let rememberIMessageReplyCache: ReplyCacheModule["rememberIMessageReplyCache"];
let sendMessageIMessage: SendModule["sendMessageIMessage"];

async function loadFreshSendModule(): Promise<void> {
  ({ findLatestIMessageEntryForChat, rememberIMessageReplyCache } =
    await loadFreshIMessageReplyCacheForTest({ reuseDatabase: true }));
  ({ IMessageRpcRequestError } = await import("./client.js"));
  ({ PlatformMessageNotDispatchedError } = await import("openclaw/plugin-sdk/error-runtime"));
  ({
    clearIMessageApprovalReactionTargetsForTest,
    resolveIMessageApprovalReactionTargetWithPersistence,
  } = await import("./approval-reactions.js"));
  ({ hasPersistedIMessageEcho } = await import("./monitor/persisted-echo-cache.js"));
  ({ sendMessageIMessage } = await import("./send.js"));
}

const IMESSAGE_TEST_CFG = {
  channels: {
    imessage: {
      accounts: {
        default: {},
      },
    },
  },
};

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

function getClientMocks(client: IMessageRpcClient): {
  request: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return client as unknown as {
    request: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
}

function createApprovalText(id = "approval-123"): string {
  return [
    "Exec approval required",
    `ID: ${id}`,
    "",
    `Reply with: /approve ${id} allow-once|deny`,
  ].join("\n");
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
    clearIMessageApprovalReactionTargetsForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await openClawState.cleanup();
  });

  function createOutboundMediaFile(filename: string, contents: Buffer): string {
    const sourcePath = openClawState.path(filename);
    fs.writeFileSync(sourcePath, contents);
    return sourcePath;
  }

  // Separate independent contracts so 81 RPC sends and the rejection corpus do not
  // share one deadline. Each case owns its executable logs and keeps the 30s limit.
  it("scrubs private markers before delivering fenced YAML over real iMessage RPC", async () => {
    const { cfg, deliver, readRequests } = createIMessageOutboundRpcFixture(
      openClawState,
      sendMessageIMessage,
    );
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
      {
        name: "quoted closed fence",
        text: ["> ```yaml", ...roles.map((role) => `> ${role}:`), "> safe quoted", "> ```"],
      },
      {
        name: "quoted unterminated fence",
        text: ["> ```yaml", ...roles.map((role) => `> ${role}:`), "> safe unterminated"],
      },
      {
        name: "nested quote",
        text: [...roles.map((role) => `> > ${role}:`), "> > safe nested"],
      },
      {
        name: "nested quoted emphasis",
        text: [...roles.map((role) => `> **${role}:**`), "> safe nested emphasis"],
      },
      { name: "heading", text: [...roles.map((role) => `# ${role}:`), "safe heading"] },
      { name: "strong", text: [...roles.map((role) => `**${role}:**`), "safe strong"] },
      { name: "emphasis", text: [...roles.map((role) => `_${role}:_`), "safe emphasis"] },
      {
        name: "strikethrough",
        text: [...roles.map((role) => `~~${role}:~~`), "safe strikethrough"],
      },
      {
        name: "multiline strong",
        text: [...roles.flatMap((role) => [`**${role}:`, "**", ""]), "safe multiline strong"],
      },
      {
        name: "multiline emphasis",
        text: [...roles.flatMap((role) => [`*${role}:`, "*", ""]), "safe multiline emphasis"],
      },
      {
        name: "reference link",
        text: [
          ...roles.map((role) => `[${role}:][${role}]`),
          "",
          ...roles.map((role) => `[${role}]: ${role}:`),
          "",
          "safe reference",
        ],
      },
      {
        name: "HTML entity",
        text: [
          ...roles.map((role) => `&#${role.charCodeAt(0)};${role.slice(1)}&#58;`),
          "safe entity",
        ],
      },
      {
        name: "HTML strong",
        text: [...roles.map((role) => `<strong>${role}:</strong>`), "safe HTML"],
      },
      {
        name: "protected inline code",
        text: [...roles.map((role) => `\`${role}:\``), "safe inline code"],
      },
      {
        name: "reply directive",
        text: [...roles.map((role) => `[[reply_to_current]]${role}:`), "safe directive"],
      },
      {
        name: "markdown table",
        text: ["| role |", "| --- |", ...roles.map((role) => `| ${role}: |`), "safe table"],
      },
      {
        name: "unterminated plain fence",
        text: ["```yaml", ...roles.map((role) => `${role}:`), "safe unclosed"],
      },
      {
        name: "private thinking text",
        text: ["<thinking>HIDDEN_RPC_THINKING</thinking>", "safe private thinking"],
      },
      {
        name: "private memory text",
        text: ["<relevant_memories>HIDDEN_RPC_MEMORY</relevant_memories>", "safe private memory"],
      },
      {
        name: "private adjacent tool response",
        text: [hiddenFunctionResponse, "safe tool response"],
      },
      {
        name: "private thinking inside fenced code",
        text: [
          "```xml",
          "<thinking>HIDDEN_RPC_FENCED_THINKING</thinking>",
          "```",
          "safe fenced thinking",
        ],
      },
      {
        name: "private memory inside fenced code",
        text: [
          "```xml",
          "<relevant-memories>HIDDEN_RPC_FENCED_MEMORY</relevant-memories>",
          "```",
          "safe fenced memory",
        ],
      },
    ];
    for (const testCase of disguisedCases) {
      await deliver(testCase.text.join("\n"));
    }

    await sendMessageIMessage(
      "chat_id:10",
      ["# assistant:", "**😀 styled**", "#+#+#", "assistant to=tool"].join("\n"),
      { config: cfg },
    );
    const requests = readRequests();
    expect(requests).toHaveLength(1 + disguisedCases.length + 1);
    expect(requests[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "send",
      params: { chat_id: 10 },
    });
    for (const role of roles) {
      expect(requests[0]?.params.text).toMatch(new RegExp(`^${role}:$`, "m"));
    }
    expectNoRoleMarkers(requests.slice(1));
    expectScrubbedRequests(requests);
    const styled = requests[1 + disguisedCases.length];
    const boldRange = styled?.params.formatting?.find((range) => range.styles.includes("bold"));
    expect(
      styled?.params.text.slice(
        boldRange?.start,
        (boldRange?.start ?? 0) + (boldRange?.length ?? 0),
      ),
    ).toBe("😀 styled");
  }, 30_000);

  it("preserves channel rendering and rejects hidden markup before local RPC dispatch", async () => {
    const {
      cfg,
      deliver,
      requestLogPath,
      countNativeRequests,
      readRequests,
      createChannelDelivery,
    } = createIMessageOutboundRpcFixture(openClawState, sendMessageIMessage);
    const { deliverThroughChannel } = createChannelDelivery();
    const channelYaml = ["```yaml", ...roles.map((role) => `${role}:`), "```"].join("\n");
    const channelYamlResult = await deliverThroughChannel(channelYaml);
    expect(channelYamlResult.sanitized).toContain("```yaml");
    const channelYamlRequest = JSON.parse(
      fs.readFileSync(requestLogPath, "utf8").trim().split("\n").at(-1) ?? "{}",
    ) as { params?: { text?: string } };
    for (const role of roles) {
      expect(channelYamlRequest.params?.text).toMatch(new RegExp(`^${role}:$`, "m"));
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
      const attributedRequest = JSON.parse(
        fs.readFileSync(requestLogPath, "utf8").trim().split("\n").at(-1) ?? "{}",
      ) as {
        params?: {
          text: string;
          formatting?: Array<{ start: number; length: number; styles: string[] }>;
        };
      };
      for (const [style, expected] of [
        ["bold", bold],
        ["strikethrough", strike],
      ] as const) {
        const range = attributedRequest.params?.formatting?.find((item) =>
          item.styles.includes(style),
        );
        expect(
          attributedRequest.params?.text.slice(
            range?.start,
            (range?.start ?? 0) + (range?.length ?? 0),
          ),
        ).toBe(expected);
      }
      channelContractRequestCount += attributedHtml.chunks.length;
    }

    const runtimeCompanion = `${privateRuntimeScaffolding}\nvisible runtime companion`;
    for (const sendPrivateRuntime of [
      () => sendMessageIMessage("chat_id:10", runtimeCompanion, { config: cfg }),
      () => deliver(runtimeCompanion),
      () => deliverThroughChannel(runtimeCompanion),
    ]) {
      const previousRequestCount = countNativeRequests();
      await sendPrivateRuntime();
      const runtimeRequests = fs
        .readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .slice(previousRequestCount)
        .map((line) => JSON.parse(line) as { params?: { text?: string } });
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
      const requestCount = countNativeRequests();
      await expect(deliverThroughChannel(`${hidden}\nsafe channel text`)).rejects.toThrow(
        "iMessage outbound hidden assistant content is not allowed",
      );
      expect(countNativeRequests()).toBe(requestCount);
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
      const requestCount = countNativeRequests();
      await expect(deliverThroughChannel(`${malformed}\nsafe channel text`)).rejects.toThrow(
        "iMessage outbound ambiguous nested HTML is not allowed",
      );
      expect(countNativeRequests()).toBe(requestCount);
    }
    for (const [context, splice] of [
      ["script", "<script>"],
      ["system-reminder", "<system-reminder>noise</system-reminder>"],
      ["spaced_system_reminder", "< system-reminder>noise< / system-reminder>"],
      ["previous_response", "<previous_response>noise</previous_response>"],
      ["spaced_previous_response", "< previous_response>noise< / previous_response>"],
      ["details", "<details><summary>noise</summary></details>"],
      ["spaced_details", "< details>< summary>noise< / summary>< / details>"],
      [
        "runtime_context",
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>noise<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      ],
    ] as const) {
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
          const requestCount = countNativeRequests();
          await expect(
            deliverThroughChannel(`${wrapper}\nsafe ${kind} ${context}`),
          ).rejects.toThrow("iMessage outbound ambiguous nested HTML is not allowed");
          expect(countNativeRequests()).toBe(requestCount);
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
        const requestCount = countNativeRequests();
        await expect(deliverThroughChannel(malformed)).rejects.toThrow(
          "iMessage outbound ambiguous nested HTML is not allowed",
        );
        expect(countNativeRequests()).toBe(requestCount);
      }
    }

    const requests = readRequests();
    expect(requests).toHaveLength(channelContractRequestCount);
    expectNoRoleMarkers(requests.slice(1));
    expectScrubbedRequests(requests);
  }, 30_000);

  it("scrubs private markers while preserving rich CLI action formatting", async () => {
    const { actionOptions, readActions } = createIMessageOutboundRpcFixture(
      openClawState,
      sendMessageIMessage,
    );
    const { imessageActionsRuntime } = await import("./actions.runtime.js");
    await imessageActionsRuntime.sendRichMessage({
      chatGuid: actionOptions.chatGuid,
      text: [
        "[Class][obj.__class__] **done**",
        "",
        "[obj.__class__]: https://example.org/python",
      ].join("\n"),
      options: actionOptions,
    });
    await imessageActionsRuntime.sendRichMessage({
      chatGuid: actionOptions.chatGuid,
      text: [
        "# user:",
        "**system:**",
        "&#97;ssistant&#58;",
        `us${rawSeparator}er:`,
        "<thinking>HIDDEN_ACTION_REPLY_THINKING</thinking>",
        hiddenFunctionResponse,
        privateRuntimeScaffolding,
        "**😀 reply styled**",
        "assistant to=tool",
      ].join("\n"),
      replyToMessageId: "reply-message-guid",
      options: actionOptions,
    });
    await imessageActionsRuntime.sendRichMessage({
      chatGuid: actionOptions.chatGuid,
      text: [
        "# system:",
        "<relevant_memories>HIDDEN_ACTION_EFFECT_MEMORY</relevant_memories>",
        hiddenFunctionResponse,
        privateRuntimeScaffolding,
        "effect visible",
        "assistant to=tool",
      ].join("\n"),
      effectId: "com.apple.MobileSMS.expressivesend.loud",
      options: actionOptions,
    });
    await imessageActionsRuntime.sendRichMessage({
      chatGuid: actionOptions.chatGuid,
      text: [
        fencedYaml,
        "```xml",
        "<thinking>HIDDEN_ACTION_ATTACHMENT_THINKING</thinking>",
        "<relevant_memories>HIDDEN_ACTION_ATTACHMENT_MEMORY</relevant_memories>",
        "```",
        privateRuntimeScaffolding,
        "**😀 attachment styled**",
        rawSeparator,
      ].join("\n"),
      attachment: { kind: "buffer", filename: "proof.txt", buffer: Uint8Array.from([1, 2]) },
      options: actionOptions,
    });
    await imessageActionsRuntime.sendRichMessage({
      chatGuid: actionOptions.chatGuid,
      text: "user:",
      attachment: { kind: "buffer", filename: "empty-proof.txt", buffer: Uint8Array.from([3]) },
      options: actionOptions,
    });

    const rawNewText = [
      "user:",
      "**literal edit styling**",
      "<thinking>HIDDEN_ACTION_EDIT_THINKING</thinking>",
      hiddenFunctionResponse,
      privateRuntimeScaffolding,
      "# system:",
      `as${rawSeparator}sistant:`,
      "visible edit",
    ].join("\n");
    const rawFallbackText = [
      "assistant:",
      fencedYaml,
      "**literal fallback styling**",
      "<relevant_memories>HIDDEN_ACTION_FALLBACK_MEMORY</relevant_memories>",
      hiddenFunctionResponse,
      privateRuntimeScaffolding,
      rawSeparator,
      "assistant to=tool",
    ].join("\n");
    await imessageActionsRuntime.editMessage({
      chatGuid: actionOptions.chatGuid,
      messageId: "edit-message-guid",
      text: rawNewText,
      backwardsCompatMessage: rawFallbackText,
      options: actionOptions,
    });

    const rawQuestion = [
      "user:",
      "# literal question heading",
      "**literal question styling**",
      "<thinking>HIDDEN_ACTION_QUESTION_THINKING</thinking>",
      hiddenFunctionResponse,
      privateRuntimeScaffolding,
      rawSeparator,
      "Which option?",
    ].join("\n");
    const rawChoices = [
      [
        "system:",
        "**Allow exactly**",
        "<relevant_memories>HIDDEN_ACTION_FIRST_OPTION_MEMORY</relevant_memories>",
        hiddenFunctionResponse,
        privateRuntimeScaffolding,
        rawSeparator,
      ].join("\n"),
      [
        "assistant:",
        fencedYaml,
        "_Deny exactly_",
        "<thinking>HIDDEN_ACTION_SECOND_OPTION_THINKING</thinking>",
        hiddenFunctionResponse,
        privateRuntimeScaffolding,
        "assistant to=tool",
      ].join("\n"),
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
      dunderReferenceAction,
      replyAction,
      effectAction,
      attachmentAction,
      emptyAttachmentAction,
      editAction,
      pollAction,
    ] = actions;
    if (
      !dunderReferenceAction ||
      !replyAction ||
      !effectAction ||
      !attachmentAction ||
      !emptyAttachmentAction ||
      !editAction ||
      !pollAction
    ) {
      throw new Error("Expected all seven native iMessage action subprocesses");
    }
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
    const replyBold = replyFormatting.find((range) => range.styles.includes("bold"));
    expect(
      replyText.slice(replyBold?.start, (replyBold?.start ?? 0) + (replyBold?.length ?? 0)),
    ).toBe("😀 reply styled");
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
      createIMessageOutboundRpcFixture(openClawState, sendMessageIMessage);
    const { deliverThroughChannel } = createChannelDelivery();
    const { imessageActionsRuntime } = await import("./actions.runtime.js");
    function createRawTextActions(source: string, replacementText: string) {
      return [
        [
          "edit",
          () =>
            imessageActionsRuntime.editMessage({
              chatGuid: actionOptions.chatGuid,
              messageId: "edit-message-guid",
              text: source,
              backwardsCompatMessage: "visible fallback",
              options: actionOptions,
            }),
        ],
        [
          "edit-fallback",
          () =>
            imessageActionsRuntime.editMessage({
              chatGuid: actionOptions.chatGuid,
              messageId: "edit-message-guid",
              text: replacementText,
              backwardsCompatMessage: source,
              options: actionOptions,
            }),
        ],
        [
          "poll-question",
          () =>
            imessageActionsRuntime.sendPoll({
              chatGuid: actionOptions.chatGuid,
              question: source,
              choices: ["first", "second"],
              options: actionOptions,
            }),
        ],
        [
          "poll-first-option",
          () =>
            imessageActionsRuntime.sendPoll({
              chatGuid: actionOptions.chatGuid,
              question: "visible question",
              choices: [source, "second"],
              options: actionOptions,
            }),
        ],
        [
          "poll-second-option",
          () =>
            imessageActionsRuntime.sendPoll({
              chatGuid: actionOptions.chatGuid,
              question: "visible question",
              choices: ["first", source],
              options: actionOptions,
            }),
        ],
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
          ["rpc", () => sendMessageIMessage("chat_id:10", source, { config: cfg })],
          ["monitor", () => deliver(source)],
          ["channel", () => deliverThroughChannel(source)],
          [
            "rich",
            () =>
              imessageActionsRuntime.sendRichMessage({
                chatGuid: actionOptions.chatGuid,
                text: source,
                options: actionOptions,
              }),
          ],
          ...createRawTextActions(source, "visible edit"),
        ] as const) {
          await expect(
            sendMalformed(),
            JSON.stringify({ malformed, wrapper, route }),
          ).rejects.toThrow("iMessage outbound runtime scaffolding is malformed");
        }
        expect(readActions()).toHaveLength(previousActionCount);
        expect(readRequests()).toHaveLength(previousRequestCount);
      }
    }
    for (const hidden of privateRuntimeBlocks) {
      const previousActionCount = readActions().length;
      const previousRequestCount = readRequests().length;
      await expect(sendMessageIMessage("chat_id:10", hidden, { config: cfg })).rejects.toThrow(
        "iMessage send requires text or media",
      );
      await expect(
        imessageActionsRuntime.sendRichMessage({
          chatGuid: actionOptions.chatGuid,
          text: hidden,
          options: actionOptions,
        }),
      ).rejects.toThrow("iMessage rich send requires text or an attachment after sanitization");
      for (const [text, backwardsCompatMessage] of [
        [hidden, "visible fallback"],
        ["visible edit", hidden],
      ] as const) {
        await expect(
          imessageActionsRuntime.editMessage({
            chatGuid: actionOptions.chatGuid,
            messageId: "edit-message-guid",
            text,
            backwardsCompatMessage,
            options: actionOptions,
          }),
        ).rejects.toThrow("iMessage edit requires non-empty text after sanitization");
      }
      for (const [questionText, choices] of [
        [hidden, ["first", "second"]],
        ["visible question", [hidden, "second"]],
        ["visible question", ["first", hidden]],
      ] as const) {
        await expect(
          imessageActionsRuntime.sendPoll({
            chatGuid: actionOptions.chatGuid,
            question: questionText,
            choices,
            options: actionOptions,
          }),
        ).rejects.toThrow(
          "iMessage poll requires a non-empty question and options after sanitization",
        );
      }
      expect(readActions()).toHaveLength(previousActionCount);
      expect(readRequests()).toHaveLength(previousRequestCount);
    }
    await expect(sendMessageIMessage("chat_id:10", "# user:", { config: cfg })).rejects.toThrow(
      "iMessage send requires text or media",
    );
    await expect(
      sendMessageIMessage("chat_id:10", ["```yaml", "user:", "```", forgedTokenEntity].join("\n"), {
        config: cfg,
      }),
    ).rejects.toThrow("iMessage outbound role protection failed");
    const splitForgedToken = "&#xE000;&#xE000;" + entitySeparator + "&#xE000;&#xE000;";
    await expect(
      sendMessageIMessage("chat_id:10", ["```yaml", "user:", "```", splitForgedToken].join("\n"), {
        config: cfg,
      }),
    ).rejects.toThrow("iMessage outbound role protection failed");
    await expect(
      sendMessageIMessage("chat_id:10", "`<thinking>HIDDEN_RPC_INLINE_THINKING</thinking>`", {
        config: cfg,
      }),
    ).rejects.toThrow("iMessage outbound hidden assistant content is not allowed");
    await expect(sendMessageIMessage("chat_id:10", roleTokenSwap, { config: cfg })).rejects.toThrow(
      "iMessage outbound role protection failed",
    );
    await expect(
      sendMessageIMessage(
        "chat_id:10",
        nestMarkdownFences("<thinking>HIDDEN_RPC_DEEPLY_NESTED</thinking>", 4),
        { config: cfg },
      ),
    ).rejects.toThrow("iMessage outbound hidden assistant content is not allowed");
    await expect(
      imessageActionsRuntime.sendRichMessage({
        chatGuid: actionOptions.chatGuid,
        text: [fencedYaml, forgedTokenEntity].join("\n"),
        options: actionOptions,
      }),
    ).rejects.toThrow("iMessage outbound role protection failed");
    await expect(
      imessageActionsRuntime.sendRichMessage({
        chatGuid: actionOptions.chatGuid,
        text: "`<relevant_memories>HIDDEN_ACTION_INLINE_MEMORY</relevant_memories>`",
        options: actionOptions,
      }),
    ).rejects.toThrow("iMessage outbound hidden assistant content is not allowed");
    await expect(
      imessageActionsRuntime.sendRichMessage({
        chatGuid: actionOptions.chatGuid,
        text: roleTokenSwap,
        options: actionOptions,
      }),
    ).rejects.toThrow("iMessage outbound role protection failed");
    await expect(
      imessageActionsRuntime.sendRichMessage({
        chatGuid: actionOptions.chatGuid,
        text: nestMarkdownFences("<relevant_memories>HIDDEN_RICH_NESTED</relevant_memories>", 4),
        options: actionOptions,
      }),
    ).rejects.toThrow("iMessage outbound hidden assistant content is not allowed");
    await expect(
      imessageActionsRuntime.sendRichMessage({
        chatGuid: actionOptions.chatGuid,
        text: "# user:",
        options: actionOptions,
      }),
    ).rejects.toThrow("iMessage rich send requires text or an attachment after sanitization");
    await expect(
      imessageActionsRuntime.editMessage({
        chatGuid: actionOptions.chatGuid,
        messageId: "edit-message-guid",
        text: "user:",
        options: actionOptions,
      }),
    ).rejects.toThrow("iMessage edit requires non-empty text after sanitization");
    await expect(
      imessageActionsRuntime.editMessage({
        chatGuid: actionOptions.chatGuid,
        messageId: "edit-message-guid",
        text: "safe edit",
        backwardsCompatMessage: "system:",
        options: actionOptions,
      }),
    ).rejects.toThrow("iMessage edit requires non-empty text after sanitization");
    for (const [questionText, choices] of [
      ["assistant:", ["first", "second"]],
      ["safe question", ["first", "system:"]],
    ] as const) {
      await expect(
        imessageActionsRuntime.sendPoll({
          chatGuid: actionOptions.chatGuid,
          question: questionText,
          choices,
          options: actionOptions,
        }),
      ).rejects.toThrow(
        "iMessage poll requires a non-empty question and options after sanitization",
      );
    }
    await expect(
      imessageActionsRuntime.sendPoll({
        chatGuid: actionOptions.chatGuid,
        question: "Choose one",
        choices: ["Allow", `Al${rawSeparator}low`],
        options: actionOptions,
      }),
    ).rejects.toThrow("iMessage poll options must remain distinct after sanitization");

    for (const [, sendSwappedRole] of createRawTextActions(roleTokenSwap, "visible replacement")) {
      await expect(sendSwappedRole()).rejects.toThrow("iMessage outbound role protection failed");
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
            await expect(sendHiddenCode()).rejects.toThrow(
              "iMessage outbound hidden assistant content is not allowed",
            );
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
      const observed = sendMessageIMessage("chat_id:42", "close proof", {
        config: IMESSAGE_TEST_CFG,
        createClient: async () => rpc,
      }).then(
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
        await Promise.race([
          closing.promise,
          observed.then((result) => {
            throw new Error("iMessage send settled before owned RPC close started", {
              cause: result,
            });
          }),
        ]);
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
              receipt: {
                platformMessageIds: ["p:0/close-proof"],
              },
            },
          });
        }
      } finally {
        releaseClose.resolve();
        await observed;
      }
    },
  );

  it.each([
    { ownership: "owned", outcome: "accepted" },
    { ownership: "borrowed", outcome: "accepted" },
  ] as const)(
    "keeps $ownership client custody when options change during an $outcome request",
    async (scenario) => {
      const started = createDeferred<void>();
      const response = createDeferred<Record<string, unknown>>();
      const rpc = createClient({ guid: "p:0/captured-owner" });
      const mocks = vi.mocked(rpc);
      mocks.request.mockImplementation(() => {
        started.resolve();
        return response.promise;
      });
      const options: Parameters<typeof sendMessageIMessage>[2] = {
        config: IMESSAGE_TEST_CFG,
        ...(scenario.ownership === "borrowed"
          ? { client: rpc }
          : { createClient: async () => rpc }),
      };
      const observed = sendMessageIMessage("chat_id:42", "captured ownership", options).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          started.promise,
          observed.then((result) => {
            throw new Error("iMessage send settled before its RPC request started", {
              cause: result,
            });
          }),
        ]);
        options.client = scenario.ownership === "owned" ? rpc : undefined;
        response.resolve({ guid: "p:0/captured-owner" });
        await expect(observed).resolves.toMatchObject({
          value: { messageId: "p:0/captured-owner" },
        });
        expect(mocks.request.mock.calls).toHaveLength(1);
        expect(mocks.stop.mock.calls).toHaveLength(scenario.ownership === "owned" ? 1 : 0);
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
    const sending = sendMessageIMessage("chat_guid:fixture-chat", "", {
      config: { channels: { imessage: { accounts: { default: { cliPath, dbPath } } } } },
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
      [
        "send-attachment",
        "--chat",
        "fixture-chat",
        "--file",
        mediaPath,
        "--transport",
        "auto",
        "--db",
        dbPath,
        "--json",
      ],
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
    const send = sendMessageIMessage("+15551234567", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
    }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await Promise.race([
        writeStarted.promise,
        send.then(() => {
          throw new Error("Send settled before pending echo persistence");
        }),
      ]);
      expect(getClientMocks(client).request).not.toHaveBeenCalled();
      writeGate.resolve();
      await Promise.race([
        deleteStarted.promise,
        send.then(() => {
          throw new Error("Send settled before pending echo rollback");
        }),
      ]);
      expect(settled).toBe(false);
      deleteGate.resolve();
      expect(await send).toEqual(new Error("recipient is not registered"));
      expect(
        await hasPersistedIMessageEcho({
          scope: "default:imessage:+15551234567",
          text: "hello",
          includePendingText: true,
        }),
      ).toBe(false);
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
    const rejection = await sendMessageIMessage("chat_id:42", "", {
      config: {
        channels: { imessage: { accounts: { default: { remoteHost: "work@messages-b" } } } },
      },
      mediaUrl: "/gateway/photo.png",
      resolveAttachmentImpl: async () => ({ path: "/gateway/photo.png" }),
      createClient: async () => client,
      withRemoteFile: async (params) => await params.use("/tmp/openclaw-imessage-safe/photo.png"),
    }).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(rejection).toMatchObject({ message: rpcError.message, cause: rpcError });
    expect(getClientMocks(client).request).toHaveBeenCalledOnce();
    expect(getClientMocks(client).request).toHaveBeenCalledWith(
      "send.attachment",
      expect.objectContaining({ file: "/tmp/openclaw-imessage-safe/photo.png" }),
      expect.any(Object),
    );
    expect(getClientMocks(client).stop).toHaveBeenCalledOnce();
  });

  it("keeps a missing retry-safe flag ambiguous", async () => {
    const rpcError = new IMessageRpcRequestError("Delivery outcome remains ambiguous", -32001, {
      disposition: "not_started",
    });
    const client = createRejectingClient(rpcError);

    const rejection = await sendMessageIMessage("chat_id:42", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
    }).catch((error: unknown) => error);

    expect(rejection).toBe(rpcError);
    expect(rejection).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
  });

  it("drops disabled reply metadata from an attachment send", async () => {
    const client = createClient({ guid: "p:0/plain-guid" });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/plain-guid" });
    const result = await sendMessageIMessage("chat_guid:chat-1", "", {
      config: {
        channels: { imessage: { actions: { reply: false }, accounts: { default: {} } } },
      },
      client,
      replyToId: "p:0/reply-guid",
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({
        path: "/tmp/image.png",
        contentType: "image/png",
      }),
      runCliJson,
    });
    expect(result.messageId).toBe("p:0/plain-guid");
    expect(result.receipt.replyToId).toBeUndefined();
    expect(result.receipt.parts[0]?.replyToId).toBeUndefined();
    expect(runCliJson.mock.calls).toEqual([
      [["send-attachment", "--chat", "chat-1", "--file", "/tmp/image.png", "--transport", "auto"]],
    ]);
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it("rejects an unbound delegated reply before media or provider access", async () => {
    const client = createClient({ guid: "should-not-send" });
    const resolveAttachment = vi.fn(async () => ({
      path: "/tmp/image.png",
      contentType: "image/png",
    }));

    await expect(
      sendMessageIMessage("chat_id:42", "caption", {
        config: {
          channels: {
            imessage: {
              remoteHost: "qa@example.invalid",
              accounts: { default: {} },
            },
          },
        },
        client,
        conversationReadOrigin: "delegated",
        mediaUrl: "/tmp/image.png",
        replyToId: "unbound-reply-guid",
        resolveAttachmentImpl: resolveAttachment,
      }),
    ).rejects.toThrow("require a current same-account conversation binding");

    expect(resolveAttachment).not.toHaveBeenCalled();
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

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
      await rememberIMessageReplyCache({
        accountId: "default",
        messageId: replyToId,
        ...binding,
        timestamp: Date.now(),
      });
      await expect(
        sendMessageIMessage(target, "hello", {
          config: {
            channels: { imessage: { remoteHost: "qa@example.invalid", accounts: { default: {} } } },
          },
          client,
          service,
          conversationReadOrigin: "delegated",
          replyToId,
        }),
      ).resolves.toMatchObject({ messageId: "p:0/imsg-bound" });
      expect(getClientMocks(client).request).toHaveBeenCalledWith(
        "send",
        expect.objectContaining({ ...rpcTarget, reply_to: replyToId }),
        expect.any(Object),
      );
    },
  );

  it("rejects a delegated reply when an auto handle has no concrete service", async () => {
    const client = createClient({ guid: "should-not-send" });
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "ambiguous-service-guid",
      chatGuid: "SMS;-;+15550004567",
      chatIdentifier: "+15550004567",
      timestamp: Date.now(),
    });

    await expect(
      sendMessageIMessage("+15550004567", "hello", {
        config: {
          channels: {
            imessage: {
              remoteHost: "qa@example.invalid",
              accounts: { default: {} },
            },
          },
        },
        client,
        conversationReadOrigin: "delegated",
        replyToId: "ambiguous-service-guid",
      }),
    ).rejects.toThrow("require a current same-account conversation binding");

    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it("keeps named-account remote transport identity isolated", async () => {
    const client = createClient({ guid: "p:0/imsg-account-isolation" });
    const createClientForAccount = vi.fn(async () => client);

    await sendMessageIMessage("chat_id:42", "hello", {
      config: {
        channels: {
          imessage: {
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
          },
        },
      },
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

    const result = await sendMessageIMessage("imessage:+15550004567", "", {
      config: {
        channels: {
          imessage: {
            accounts: {
              default: {
                remoteHost: "work@messages-b",
              },
            },
          },
        },
      },
      mediaUrl: "/gateway/photo.png",
      resolveAttachmentImpl: async () => ({ path: "/gateway/photo.png" }),
      createClient: createClientForAccount,
      withRemoteFile: withRemoteFile as never,
    });

    expect(withRemoteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteHost: "work@messages-b",
        localPath: "/gateway/photo.png",
      }),
    );
    expect(getClientMocks(client).request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        to: "+15550004567",
        file: "/tmp/openclaw-imessage-safe/photo.png",
        service: "imessage",
      }),
      expect.any(Object),
    );
    expect(getClientMocks(client).request).not.toHaveBeenCalledWith(
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

  it("keeps a non-SSH wrapper on the local attachment path", async () => {
    const cliPath = createOutboundMediaFile(
      "imsg-local-wrapper",
      Buffer.from('#!/bin/sh\nexec /opt/homebrew/bin/imsg "$@"\n'),
    );
    const runCliJson = vi
      .fn()
      .mockResolvedValueOnce({ guid: "iMessage;+;chat0000" })
      .mockResolvedValueOnce({ guid: "p:0/local-media" });
    const withRemoteFile = vi.fn();

    await sendMessageIMessage("chat_id:42", "", {
      config: { channels: { imessage: { cliPath } } },
      mediaUrl: "/gateway/photo.png",
      resolveAttachmentImpl: async () => ({ path: "/gateway/photo.png" }),
      runCliJson,
      withRemoteFile: withRemoteFile as never,
    });

    expect(runCliJson).toHaveBeenCalledWith(
      expect.arrayContaining(["send-attachment", "--file", "/gateway/photo.png"]),
    );
    expect(withRemoteFile).not.toHaveBeenCalled();
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
      sendMessageIMessage("chat_id:42", "", {
        config: { channels: { imessage: { cliPath } } },
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

    const send = sendMessageIMessage("chat_id:42", "hello", {
      config: {
        channels: {
          imessage: {
            ...IMESSAGE_TEST_CFG.channels.imessage,
            probeTimeoutMs: 10_000,
          },
        },
      },
      client,
    });
    await requestStarted.promise;
    await vi.advanceTimersByTimeAsync(delayedFallbackMs);

    await expect(send).resolves.toMatchObject({ messageId: "p:0/imsg-delayed-fallback" });
    expect(getClientMocks(client).request).toHaveBeenCalledTimes(1);
    expect(getClientMocks(client).request).toHaveBeenCalledWith(
      "send",
      expect.any(Object),
      expect.objectContaining({ timeoutMs: 180_000 }),
    );
  });

  it("sends native voice as a threaded reply", async () => {
    const replyToId = "p:0/reply-guid";
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageGuid: "p:0/voice-guid" });

    const result = await sendMessageIMessage("chat_guid:chat-1", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/voice.caf",
      audioAsVoice: true,
      conversationReadOrigin: "direct-operator",
      replyToId,
      resolveAttachmentImpl: async () => ({ path: "/tmp/voice.caf", contentType: "audio/x-caf" }),
      runCliJson,
    });

    expect(result.messageId).toBe("p:0/voice-guid");
    expect(result.guid).toBe("p:0/voice-guid");
    expect(result.receipt.replyToId).toBe(replyToId);
    expect(runCliJson.mock.calls).toEqual([
      [
        [
          "send-attachment",
          "--chat",
          "chat-1",
          "--file",
          "/tmp/voice.caf",
          "--audio",
          "--reply-to",
          replyToId,
          "--transport",
          "auto",
        ],
      ],
    ]);
    expect(result.receipt.platformMessageIds).toEqual(["p:0/voice-guid"]);
    expect(result.receipt.parts.map((part) => part.kind)).toEqual(["voice"]);
    expect(client["request"]).not.toHaveBeenCalled();
  });

  it("rejects threaded AppleScript voice notes without downgrading native audio", async () => {
    const replyToId = "p:0/reply-guid";
    const client = createClient({ guid: "should-not-send" });
    const runCliJson = vi.fn();

    await expect(
      sendMessageIMessage("chat_guid:chat-1", "", {
        config: { channels: { imessage: { sendTransport: "applescript" } } },
        client,
        conversationReadOrigin: "direct-operator",
        mediaUrl: "/tmp/voice.caf",
        audioAsVoice: true,
        replyToId,
        resolveAttachmentImpl: async () => ({
          path: "/tmp/voice.caf",
          contentType: "audio/x-caf",
        }),
        runCliJson,
      }),
    ).rejects.toThrow("voice messages require bridge transport");

    expect(runCliJson).not.toHaveBeenCalled();
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it.each([
    {
      target: "chat_guid:chat-1",
      error: "unknown command send-attachment",
      command: [
        "send-attachment",
        "--chat",
        "chat-1",
        "--file",
        "/tmp/image.png",
        "--transport",
        "auto",
      ],
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

      const result = await sendMessageIMessage(target, "", {
        config: IMESSAGE_TEST_CFG,
        client,
        mediaUrl: "/tmp/image.png",
        resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
        runCliJson,
      });

      expect(result.messageId).toBe("12345");
      expect(runCliJson.mock.calls).toEqual([[command]]);
      expect(client["request"]).toHaveBeenCalledWith(
        "send",
        expect.objectContaining({
          ...rpcTarget,
          file: "/tmp/image.png",
          text: "",
        }),
        expect.any(Object),
      );
    },
  );

  it("preserves configured iMessage service for bare-handle media", async () => {
    const { service, config, chatGuid, wireService, chatIdentifier } = {
      service: undefined,
      config: { channels: { imessage: { accounts: { default: { service: "imessage" } } } } },
      chatGuid: "any;-;+15550004567",
      wireService: "iMessage",
      chatIdentifier: "iMessage;-;+15550004567",
    } as const;
    const effectiveService = service ?? "imessage";
    const messageId = `p:0/${effectiveService}-media-guid`;
    const client = createClient({ guid: messageId, chat_guid: chatGuid, service: wireService });
    const runCliJson = vi.fn();
    const result = await sendMessageIMessage("+15550004567", "", {
      config,
      client,
      service,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });
    expect(runCliJson).not.toHaveBeenCalled();
    expect(getClientMocks(client).request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        to: "+15550004567",
        file: "/tmp/image.png",
        service: effectiveService,
      }),
      expect.any(Object),
    );
    expect(result).toMatchObject({ messageId, chatGuid, service: effectiveService });
    expect(
      findLatestIMessageEntryForChat({
        accountId: "default",
        ...(chatIdentifier ? { chatIdentifier } : { chatGuid }),
      }),
    ).toEqual(expect.objectContaining({ messageId, chatGuid, isFromMe: true }));
  });

  it("preserves explicit bridge delivery for a new service-qualified media chat", async () => {
    const client = createClient({ guid: "should-not-send" });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageGuid: "p:0/bridge-media-guid" });

    await sendMessageIMessage("imessage:+15550004567", "", {
      config: { channels: { imessage: { sendTransport: "bridge" } } },
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(runCliJson).toHaveBeenCalledWith([
      "send-attachment",
      "--chat",
      "iMessage;-;+15550004567",
      "--file",
      "/tmp/image.png",
      "--transport",
      "dylib",
    ]);
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it("keeps an unqualified phone number on the canonical RPC media path", async () => {
    const { target, rpcTarget } = {
      target: "555-000-4567",
      rpcTarget: { to: "555-000-4567", region: "US" },
    };
    const client = createClient({ guid: "p:0/media-guid" });
    const runCliJson = vi.fn();

    const result = await sendMessageIMessage(target, "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      region: "US",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(runCliJson).not.toHaveBeenCalled();
    expect(getClientMocks(client).request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        file: "/tmp/image.png",
        ...rpcTarget,
      }),
      expect.any(Object),
    );
    expect(result.messageId).toBe("p:0/media-guid");
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

    const result = await sendMessageIMessage("chat_id:42", "caption", {
      config: IMESSAGE_TEST_CFG,
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

  it("does not persist caption text when the caption follow-up send fails", async () => {
    const captionError = new Error("caption failed");
    const client = createRejectingClient(captionError);
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageGuid: "p:0/dm-media-guid" });
    const onDeliveryResult = vi.fn();

    let observedError: unknown;
    try {
      await sendMessageIMessage("+15550004567", "caption", {
        config: IMESSAGE_TEST_CFG,
        client,
        mediaUrl: "/tmp/image.png",
        resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
        runCliJson,
        onDeliveryResult,
      });
    } catch (error) {
      observedError = error;
    }

    expect(isChannelPartialDeliveryError(observedError)).toBe(true);
    expect(observedError).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      cause: captionError,
      sentBeforeError: true,
      visibleReplySent: true,
      deliveryResult: {
        content: "",
        messageIds: ["p:0/dm-media-guid"],
        receipt: {
          primaryPlatformMessageId: "p:0/dm-media-guid",
          platformMessageIds: ["p:0/dm-media-guid"],
          parts: [expect.objectContaining({ kind: "media" })],
        },
        visibleReplySent: true,
      },
    });
    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: "",
        messageId: "p:0/dm-media-guid",
        messageIds: ["p:0/dm-media-guid"],
        visibleReplySent: true,
        receipt: expect.objectContaining({
          platformMessageIds: ["p:0/dm-media-guid"],
        }),
      }),
    );
    const scope = "default:imessage:+15550004567";
    expect(await hasPersistedIMessageEcho({ scope, text: "caption" })).toBe(false);
    expect(
      await hasPersistedIMessageEcho({ scope, media: { contentType: "image/png", kind: "image" } }),
    ).toBe(true);
    expect(await hasPersistedIMessageEcho({ scope, messageId: "p:0/dm-media-guid" })).toBe(true);
  });

  it("stops before a caption when accepted attachment custody cannot be recorded", async () => {
    const custodyError = new Error("accepted attachment custody failed");
    const client = createClient({ guid: "p:0/caption-guid" });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/dm-media-guid" });
    const onDeliveryResult = vi.fn(async () => {
      throw custodyError;
    });

    await expect(
      sendMessageIMessage("+15550004567", "caption", {
        config: IMESSAGE_TEST_CFG,
        client,
        mediaUrl: "/tmp/image.png",
        resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
        runCliJson,
        onDeliveryResult,
      }),
    ).rejects.toBe(custodyError);

    expect(isChannelPartialDeliveryError(custodyError)).toBe(false);
    expect(runCliJson).toHaveBeenCalledOnce();
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: "",
        messageId: "p:0/dm-media-guid",
        messageIds: ["p:0/dm-media-guid"],
        receipt: expect.objectContaining({
          platformMessageIds: ["p:0/dm-media-guid"],
        }),
        visibleReplySent: true,
      }),
    );
  });

  it.each([
    {
      target: "+15550004567",
      attachment: { success: true },
      mediaId: undefined,
      ownsClient: false,
      rpcTarget: { to: "+15550004567" },
    },
    {
      target: "+15550004567",
      attachment: { messageId: "p:0/dm-media-guid" },
      mediaId: "p:0/dm-media-guid",
      ownsClient: true,
      rpcTarget: { to: "+15550004567" },
    },
  ])(
    "combines caption receipts for $target, media ID $mediaId, owned client $ownsClient",
    async ({ target, attachment, mediaId, ownsClient, rpcTarget }) => {
      const client = createClient({ guid: "p:0/caption-guid" });
      const createClientImpl = vi.fn(async () => client);
      const runCliJson = vi.fn().mockResolvedValueOnce(attachment);
      const result = await sendMessageIMessage(target, "caption", {
        config: IMESSAGE_TEST_CFG,
        ...(ownsClient ? { createClient: createClientImpl } : { client }),
        mediaUrl: "/tmp/image.png",
        resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
        runCliJson,
      });
      if (target === "chat_guid:chat-1") {
        expect(runCliJson.mock.calls).toEqual([
          [
            [
              "send-attachment",
              "--chat",
              "chat-1",
              "--file",
              "/tmp/image.png",
              "--transport",
              "auto",
            ],
          ],
        ]);
      }
      expect(getClientMocks(client).request).toHaveBeenCalledWith(
        "send",
        expect.objectContaining({ ...rpcTarget, text: "caption" }),
        expect.any(Object),
      );
      expect(createClientImpl).toHaveBeenCalledTimes(ownsClient ? 1 : 0);
      expect(getClientMocks(client).stop).toHaveBeenCalledTimes(ownsClient ? 1 : 0);
      expect(result.messageId).toBe(mediaId ?? "p:0/caption-guid");
      expect(result.sentText).toBe("caption");
      expect(result.receipt.platformMessageIds).toEqual(
        mediaId ? [mediaId, "p:0/caption-guid"] : ["p:0/caption-guid"],
      );
      expect(result.receipt.parts.map((part) => part.kind)).toEqual(
        mediaId ? ["media", "text"] : ["text"],
      );
    },
  );

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

    const send = sendMessageIMessage("+15551234567", "slow hello", {
      config: IMESSAGE_TEST_CFG,
      client,
    });
    await requestStarted.promise;

    vi.setSystemTime(new Date("2026-06-04T00:01:01Z"));
    expect(
      await hasPersistedIMessageEcho({
        scope: "default:imessage:+15551234567",
        text: "slow hello",
        includePendingText: true,
      }),
    ).toBe(true);

    response.resolve({ guid: "p:0/imsg-slow" });
    await expect(send).resolves.toMatchObject({ messageId: "p:0/imsg-slow" });
  });

  it("awaits approval binding completion before returning a send receipt", async () => {
    const reactions = await import("./approval-reactions.js");
    const persisted =
      createDeferred<
        Awaited<ReturnType<ApprovalReactionsModule["registerIMessageApprovalReactionTarget"]>>
      >();
    const started = createDeferred<void>();
    vi.spyOn(reactions, "registerIMessageApprovalReactionTarget").mockImplementation(() => {
      started.resolve();
      return persisted.promise;
    });
    let completed = false;
    const send = sendMessageIMessage("chat_id:42", createApprovalText(), {
      config: IMESSAGE_TEST_CFG,
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

  it("uses the default local chat.db for absolute CLI path timeout recovery", async () => {
    const cliPath = "/opt/homebrew/bin/imsg";
    vi.stubEnv("HOME", "/Users/me");
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/default-db-guid");
    const approvalText = createApprovalText("approval-default");

    const result = await sendMessageIMessage("chat_id:42", approvalText, {
      config: IMESSAGE_TEST_CFG,
      approvalPrompt: createApprovalPrompt("approval-default"),
      client,
      cliPath,
      runCliJson,
      resolveSentMessageGuidImpl,
    });

    expect(result.messageId).toBe("p:0/default-db-guid");
    expect(runCliJson).not.toHaveBeenCalled();
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: "/Users/me/Library/Messages/chat.db",
      target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
      text: expect.stringContaining("ID: approval-default"),
      sentAfterMs: expect.any(Number),
    });
  });

  it("does not recover SSH wrapper receipts from local chat.db", async () => {
    vi.stubEnv("HOME", "/Users/me");
    const cliPath = createOutboundMediaFile(
      "imsg",
      Buffer.from('#!/bin/sh\nexec ssh -T gateway-host imsg "$@"\n'),
    );
    await resolveIMessageRemoteHost({ cliPath });
    vi.useFakeTimers({ now: 1_000 });
    const { client, requestStarted } = createTimedOutSendClient();
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => null);
    const rejection = expect(
      sendMessageIMessage("chat_id:42", createApprovalText("approval-remote"), {
        config: IMESSAGE_TEST_CFG,
        approvalPrompt: createApprovalPrompt("approval-remote"),
        client,
        cliPath,
        runCliJson,
        resolveSentMessageGuidImpl,
      }),
    ).rejects.toThrow("imsg rpc timeout (send)");
    await requestStarted;
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(runCliJson).not.toHaveBeenCalled();
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: undefined,
      target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
      text: expect.stringContaining("ID: approval-remote"),
      sentAfterMs: expect.any(Number),
    });
  });

  it("throws the rpc timeout without resending when sent-row recovery misses", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const { client, requestStarted } = createTimedOutSendClient();
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => null);
    const rejection = expect(
      sendMessageIMessage("chat_id:42", "hello", {
        config: IMESSAGE_TEST_CFG,
        createClient: async () => client,
        runCliJson,
        dbPath: "/Users/me/Library/Messages/chat.db",
        resolveSentMessageGuidImpl,
      }),
    ).rejects.toThrow("imsg rpc timeout (send)");
    await requestStarted;
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;

    expect(getClientMocks(client).stop).toHaveBeenCalledTimes(1);
    expect(runCliJson).not.toHaveBeenCalled();
  });

  it("recovers approval tapback GUIDs when RPC returns an unknown placeholder", async () => {
    const { response, messageId } = {
      response: { messageId: "unknown", status: "sent" },
      messageId: "unknown",
    };
    const client = createClient(response);
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/recovered-guid");
    const approvalText = createApprovalText();

    const result = await sendMessageIMessage("chat_id:42", approvalText, {
      config: IMESSAGE_TEST_CFG,
      approvalPrompt: createApprovalPrompt(),
      client,
      dbPath: "/Users/me/Library/Messages/chat.db",
      resolveSentMessageGuidImpl,
    });

    expect(result.messageId).toBe(messageId);
    expect(result.guid).toBe("p:0/recovered-guid");
    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
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
    const approvalText = createApprovalText();

    const result = await sendMessageIMessage("chat_id:42", approvalText, {
      config: IMESSAGE_TEST_CFG,
      approvalPrompt: createApprovalPrompt(),
      client,
    });

    // Fake timers are intentionally not advanced: entering the polling loop
    // would leave this awaited send pending and fail the test by timeout.
    expect(result.messageId).toBe("ok");
    expect(result.guid).toBeUndefined();
  });

  it("rejects attachment failure from provider JSON", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn(async () => ({ success: false, error: "attachment delivery failed" }));
    const send = sendMessageIMessage("chat_guid:chat-1", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      runCliJson,
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
    });
    await expect(send).rejects.toThrow("attachment delivery failed");
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
