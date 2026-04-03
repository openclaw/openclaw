import type { HistoryEntry, PluginRuntime } from "../runtime-api.js";
import { vi } from "vitest";
import { createPluginRuntimeMock } from "../../../../test/helpers/plugins/plugin-runtime-mock.js";
import {
  _resetBlueBubblesShortIdState,
  clearBlueBubblesWebhookSecurityStateForTest,
} from "../monitor.js";
import { setBlueBubblesRuntime } from "../runtime.js";

type BlueBubblesHistoryFetchResult = {
  entries: HistoryEntry[];
  resolved: boolean;
};

export type DispatchReplyParams = Parameters<
  PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"]
>[0];

export const EMPTY_DISPATCH_RESULT = {
  queuedFinal: false,
  counts: { tool: 0, block: 0, final: 0 },
} as const;

type BlueBubblesMonitorTestRuntimeMocks = {
  enqueueSystemEvent: unknown;
  chunkMarkdownText: unknown;
  chunkByNewline: unknown;
  chunkMarkdownTextWithMode: unknown;
  chunkTextWithMode: unknown;
  resolveChunkMode: unknown;
  hasControlCommand: unknown;
  dispatchReplyWithBufferedBlockDispatcher: unknown;
  formatAgentEnvelope: unknown;
  formatInboundEnvelope: unknown;
  resolveEnvelopeFormatOptions: unknown;
  resolveAgentRoute: unknown;
  buildPairingReply: unknown;
  readAllowFromStore: unknown;
  upsertPairingRequest: unknown;
  saveMediaBuffer: unknown;
  resolveStorePath: unknown;
  readSessionUpdatedAt: unknown;
  buildMentionRegexes: unknown;
  matchesMentionPatterns: unknown;
  matchesMentionWithExplicit: unknown;
  resolveGroupPolicy: unknown;
  resolveRequireMention: unknown;
  resolveCommandAuthorizedFromAuthorizers: unknown;
};

export function createBlueBubblesMonitorTestRuntime(
  mocks: BlueBubblesMonitorTestRuntimeMocks,
): PluginRuntime {
  return createPluginRuntimeMock({
    system: {
      enqueueSystemEvent: mocks.enqueueSystemEvent as PluginRuntime["system"]["enqueueSystemEvent"],
    },
    channel: {
      text: {
        chunkMarkdownText:
          mocks.chunkMarkdownText as PluginRuntime["channel"]["text"]["chunkMarkdownText"],
        chunkByNewline: mocks.chunkByNewline as PluginRuntime["channel"]["text"]["chunkByNewline"],
        chunkMarkdownTextWithMode:
          mocks.chunkMarkdownTextWithMode as PluginRuntime["channel"]["text"]["chunkMarkdownTextWithMode"],
        chunkTextWithMode:
          mocks.chunkTextWithMode as PluginRuntime["channel"]["text"]["chunkTextWithMode"],
        resolveChunkMode:
          mocks.resolveChunkMode as PluginRuntime["channel"]["text"]["resolveChunkMode"],
        hasControlCommand:
          mocks.hasControlCommand as PluginRuntime["channel"]["text"]["hasControlCommand"],
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher:
          mocks.dispatchReplyWithBufferedBlockDispatcher as PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"],
        formatAgentEnvelope:
          mocks.formatAgentEnvelope as PluginRuntime["channel"]["reply"]["formatAgentEnvelope"],
        formatInboundEnvelope:
          mocks.formatInboundEnvelope as PluginRuntime["channel"]["reply"]["formatInboundEnvelope"],
        resolveEnvelopeFormatOptions:
          mocks.resolveEnvelopeFormatOptions as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
      },
      routing: {
        resolveAgentRoute:
          mocks.resolveAgentRoute as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
      },
      pairing: {
        buildPairingReply:
          mocks.buildPairingReply as PluginRuntime["channel"]["pairing"]["buildPairingReply"],
        readAllowFromStore:
          mocks.readAllowFromStore as PluginRuntime["channel"]["pairing"]["readAllowFromStore"],
        upsertPairingRequest:
          mocks.upsertPairingRequest as PluginRuntime["channel"]["pairing"]["upsertPairingRequest"],
      },
      media: {
        saveMediaBuffer:
          mocks.saveMediaBuffer as PluginRuntime["channel"]["media"]["saveMediaBuffer"],
      },
      session: {
        resolveStorePath:
          mocks.resolveStorePath as PluginRuntime["channel"]["session"]["resolveStorePath"],
        readSessionUpdatedAt:
          mocks.readSessionUpdatedAt as PluginRuntime["channel"]["session"]["readSessionUpdatedAt"],
      },
      mentions: {
        buildMentionRegexes:
          mocks.buildMentionRegexes as PluginRuntime["channel"]["mentions"]["buildMentionRegexes"],
        matchesMentionPatterns:
          mocks.matchesMentionPatterns as PluginRuntime["channel"]["mentions"]["matchesMentionPatterns"],
        matchesMentionWithExplicit:
          mocks.matchesMentionWithExplicit as PluginRuntime["channel"]["mentions"]["matchesMentionWithExplicit"],
      },
      groups: {
        resolveGroupPolicy:
          mocks.resolveGroupPolicy as PluginRuntime["channel"]["groups"]["resolveGroupPolicy"],
        resolveRequireMention:
          mocks.resolveRequireMention as PluginRuntime["channel"]["groups"]["resolveRequireMention"],
      },
      commands: {
        resolveCommandAuthorizedFromAuthorizers:
          mocks.resolveCommandAuthorizedFromAuthorizers as PluginRuntime["channel"]["commands"]["resolveCommandAuthorizedFromAuthorizers"],
      },
    },
  });
}

export function resetBlueBubblesMonitorTestState(params: {
  createRuntime: () => PluginRuntime;
  fetchHistoryMock: { mockResolvedValue: (value: BlueBubblesHistoryFetchResult) => unknown };
  readAllowFromStoreMock: { mockResolvedValue: (value: string[]) => unknown };
  upsertPairingRequestMock: {
    mockResolvedValue: (value: { code: string; created: boolean }) => unknown;
  };
  resolveRequireMentionMock: { mockReturnValue: (value: boolean) => unknown };
  hasControlCommandMock: { mockReturnValue: (value: boolean) => unknown };
  resolveCommandAuthorizedFromAuthorizersMock: { mockReturnValue: (value: boolean) => unknown };
  buildMentionRegexesMock: { mockReturnValue: (value: RegExp[]) => unknown };
  extraReset?: () => void;
}) {
  vi.clearAllMocks();
  _resetBlueBubblesShortIdState();
  clearBlueBubblesWebhookSecurityStateForTest();
  params.extraReset?.();
  params.fetchHistoryMock.mockResolvedValue({ entries: [], resolved: true });
  params.readAllowFromStoreMock.mockResolvedValue([]);
  params.upsertPairingRequestMock.mockResolvedValue({ code: "TESTCODE", created: true });
  params.resolveRequireMentionMock.mockReturnValue(false);
  params.hasControlCommandMock.mockReturnValue(false);
  params.resolveCommandAuthorizedFromAuthorizersMock.mockReturnValue(false);
  params.buildMentionRegexesMock.mockReturnValue([/\bbert\b/i]);
  setBlueBubblesRuntime(params.createRuntime());
}
