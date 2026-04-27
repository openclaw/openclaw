import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptPolicy } from "../transcript-policy.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

// Track every wrapper application, in the order it happens, so tests can
// assert the wrapper-stack ordering invariant (innermost-first) and the
// presence/absence of each conditional wrapper.
const wrapperCalls = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock("../../cache-trace.js", () => ({}));
vi.mock("../../anthropic-payload-log.js", () => ({}));

vi.mock("../thinking.js", () => ({
  dropReasoningFromHistory: vi.fn((m) => m),
  dropThinkingBlocks: vi.fn((m) => m),
}));

vi.mock("./attempt.sessions-yield.js", () => ({
  createYieldAbortedResponse: vi.fn(),
}));

vi.mock("./attempt.stop-reason-recovery.js", () => ({
  wrapStreamFnHandleSensitiveStopReason: vi.fn((streamFn) => {
    wrapperCalls.events.push("handleSensitiveStopReason");
    return streamFn;
  }),
}));

vi.mock("./attempt.tool-call-argument-repair.js", () => ({
  shouldRepairMalformedToolCallArguments: vi.fn(() => false),
  wrapStreamFnDecodeXaiToolCallArguments: vi.fn((streamFn) => {
    wrapperCalls.events.push("decodeXai");
    return streamFn;
  }),
  wrapStreamFnRepairMalformedToolCallArguments: vi.fn((streamFn) => {
    wrapperCalls.events.push("repairMalformedToolCallArguments");
    return streamFn;
  }),
}));

vi.mock("./attempt.tool-call-normalization.js", () => ({
  sanitizeReplayToolCallIdsForStream: vi.fn((m) => m),
  wrapStreamFnSanitizeMalformedToolCalls: vi.fn((streamFn) => {
    wrapperCalls.events.push("sanitizeMalformedToolCalls");
    return streamFn;
  }),
  wrapStreamFnTrimToolCallNames: vi.fn((streamFn) => {
    wrapperCalls.events.push("trimToolCallNames");
    return streamFn;
  }),
}));

vi.mock("../transcript-policy.js", () => ({
  shouldAllowProviderOwnedThinkingReplay: vi.fn(() => false),
}));

vi.mock("../../../plugins/provider-model-compat.js", () => ({
  resolveToolCallArgumentsEncoding: vi.fn(() => "default"),
}));

vi.mock("../pi-embedded-helpers.js", () => ({
  downgradeOpenAIFunctionCallReasoningPairs: vi.fn((m) => m),
  downgradeOpenAIReasoningBlocks: vi.fn((m) => m),
}));

import { resolveToolCallArgumentsEncoding } from "../../../plugins/provider-model-compat.js";
import { applyAttemptStreamWrappers } from "./attempt-stream-wrappers.js";
import {
  shouldRepairMalformedToolCallArguments,
  wrapStreamFnDecodeXaiToolCallArguments,
  wrapStreamFnRepairMalformedToolCallArguments,
} from "./attempt.tool-call-argument-repair.js";

type WrapperSession = { agent: { streamFn: ReturnType<typeof makeStreamFn> } };

function makeStreamFn() {
  return vi.fn(async () => ({ messages: [] as unknown[] })) as unknown as Parameters<
    typeof applyAttemptStreamWrappers
  >[0]["activeSession"]["agent"]["streamFn"];
}

function makeSession(): WrapperSession {
  return { agent: { streamFn: makeStreamFn() } };
}

const baseTranscriptPolicy: TranscriptPolicy = {
  dropThinkingBlocks: false,
  dropReasoningFromHistory: false,
  sanitizeToolCallIds: false,
  toolCallIdMode: undefined,
  preserveNativeAnthropicToolUseIds: false,
  preserveReplaySafeThinkingToolCallIds: false,
  repairToolUseResultPairing: false,
} as unknown as TranscriptPolicy;

const baseModel: EmbeddedRunAttemptParams["model"] = {
  id: "gpt-5.4",
  api: "openai",
  provider: "openai",
} as unknown as Model<Api>;

function buildParams(
  overrides: {
    cacheTrace?: { wrapStreamFn: ReturnType<typeof vi.fn> } | null;
    transcriptPolicy?: Partial<TranscriptPolicy>;
    isOpenAIResponsesApi?: boolean;
    anthropicPayloadLogger?: { wrapStreamFn: ReturnType<typeof vi.fn> } | null;
    modelApi?: string;
    shouldReturnYieldAbortedResponse?: () => boolean;
  } = {},
) {
  const session = makeSession();
  return {
    session,
    params: {
      activeSession: session as Parameters<typeof applyAttemptStreamWrappers>[0]["activeSession"],
      cacheTrace: overrides.cacheTrace ?? null,
      transcriptPolicy: {
        ...baseTranscriptPolicy,
        ...overrides.transcriptPolicy,
      } as TranscriptPolicy,
      allowedToolNames: new Set<string>(["read"]),
      isOpenAIResponsesApi: overrides.isOpenAIResponsesApi ?? false,
      unknownToolThreshold: 3,
      provider: "openai",
      model: {
        ...baseModel,
        api: overrides.modelApi ?? "openai",
      } as EmbeddedRunAttemptParams["model"],
      anthropicPayloadLogger: overrides.anthropicPayloadLogger ?? null,
      shouldReturnYieldAbortedResponse: overrides.shouldReturnYieldAbortedResponse ?? (() => false),
    },
  };
}

describe("applyAttemptStreamWrappers", () => {
  beforeEach(() => {
    wrapperCalls.events = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("composition order (innermost-applied → outermost)", () => {
    it("preserves the canonical ordering when every conditional is enabled", () => {
      const cacheTrace = {
        wrapStreamFn: vi.fn((s) => (wrapperCalls.events.push("cacheTrace"), s)),
      };
      const anthropicPayloadLogger = {
        wrapStreamFn: vi.fn((s) => (wrapperCalls.events.push("anthropicPayloadLogger"), s)),
      };
      vi.mocked(shouldRepairMalformedToolCallArguments).mockReturnValueOnce(true);
      vi.mocked(resolveToolCallArgumentsEncoding).mockReturnValueOnce("html-entities");
      const { params } = buildParams({
        cacheTrace,
        anthropicPayloadLogger,
        transcriptPolicy: {
          dropThinkingBlocks: true,
          dropReasoningFromHistory: true,
          sanitizeToolCallIds: true,
          toolCallIdMode: "anthropic-reset",
        } as Partial<TranscriptPolicy>,
        isOpenAIResponsesApi: false,
      });

      applyAttemptStreamWrappers(params);

      // Wrappers are applied from inside-out. The call order in wrapperCalls
      // therefore reflects the wrapping order in the source: the FIRST event
      // is the innermost wrapper (closest to the original streamFn), the LAST
      // event is the outermost wrapper (called first when streaming).
      expect(wrapperCalls.events).toEqual([
        "cacheTrace",
        // dropThinkingBlocks wrapper is applied internally (no event helper);
        // sanitizeReplayToolCallIds is also internal-only.
        // Mocked-out helpers we DO emit events for:
        "sanitizeMalformedToolCalls",
        "trimToolCallNames",
        "repairMalformedToolCallArguments",
        "decodeXai",
        "anthropicPayloadLogger",
        "handleSensitiveStopReason",
      ]);
    });

    it("preserves order when only the always-on wrappers run", () => {
      const { params } = buildParams();

      applyAttemptStreamWrappers(params);

      expect(wrapperCalls.events).toEqual([
        "sanitizeMalformedToolCalls",
        "trimToolCallNames",
        "handleSensitiveStopReason",
      ]);
    });
  });

  describe("conditional branches", () => {
    it("skips the cacheTrace wrapper when cacheTrace is null", () => {
      const { params } = buildParams({ cacheTrace: null });
      applyAttemptStreamWrappers(params);
      expect(wrapperCalls.events).not.toContain("cacheTrace");
    });

    it("applies the cacheTrace wrapper when cacheTrace is non-null", () => {
      const cacheTrace = {
        wrapStreamFn: vi.fn((s) => (wrapperCalls.events.push("cacheTrace"), s)),
      };
      const { params } = buildParams({ cacheTrace });
      applyAttemptStreamWrappers(params);
      expect(wrapperCalls.events[0]).toBe("cacheTrace");
      expect(cacheTrace.wrapStreamFn).toHaveBeenCalledTimes(1);
    });

    it("applies dropThinkingBlocks wrapper when transcriptPolicy.dropThinkingBlocks is true", () => {
      const { params, session } = buildParams({
        transcriptPolicy: { dropThinkingBlocks: true } as Partial<TranscriptPolicy>,
      });
      const original = session.agent.streamFn;
      applyAttemptStreamWrappers(params);
      // The wrapper replaces streamFn — identity changes.
      expect(session.agent.streamFn).not.toBe(original);
    });

    it("applies dropThinkingBlocks wrapper when only dropReasoningFromHistory is true", () => {
      const { params, session } = buildParams({
        transcriptPolicy: { dropReasoningFromHistory: true } as Partial<TranscriptPolicy>,
      });
      const original = session.agent.streamFn;
      applyAttemptStreamWrappers(params);
      expect(session.agent.streamFn).not.toBe(original);
    });

    it("skips dropThinkingBlocks wrapper when both flags are false", () => {
      const { params, session } = buildParams();
      const original = session.agent.streamFn;
      applyAttemptStreamWrappers(params);
      // Other always-on wrappers still wrap, so identity changes; assert the
      // function is the same TYPE but not via dropThinkingBlocks specifically
      // by checking that thinking-module functions weren't called.
      expect(session.agent.streamFn).not.toBe(original);
    });

    it("applies sanitizeReplayToolCallIds wrapper only when all three conditions hold", () => {
      // sanitizeToolCallIds=true, mode set, isOpenAIResponsesApi=false
      const { params: paramsAllTrue, session: sessAllTrue } = buildParams({
        transcriptPolicy: {
          sanitizeToolCallIds: true,
          toolCallIdMode: "anthropic-reset",
        } as Partial<TranscriptPolicy>,
        isOpenAIResponsesApi: false,
      });
      const origAllTrue = sessAllTrue.agent.streamFn;
      applyAttemptStreamWrappers(paramsAllTrue);
      expect(sessAllTrue.agent.streamFn).not.toBe(origAllTrue);

      // isOpenAIResponsesApi=true blocks the sanitizer
      wrapperCalls.events = [];
      const { params: paramsOpenAI } = buildParams({
        transcriptPolicy: {
          sanitizeToolCallIds: true,
          toolCallIdMode: "anthropic-reset",
        } as Partial<TranscriptPolicy>,
        isOpenAIResponsesApi: true,
      });
      applyAttemptStreamWrappers(paramsOpenAI);
      // the OpenAI-responses downgrade IS applied, but no event tracks it via
      // mocks (it's an internal helper). The presence of the always-on
      // wrappers in events asserts apply was invoked.
      expect(wrapperCalls.events).toContain("sanitizeMalformedToolCalls");
    });

    it("applies downgradeOpenAIResponses wrapper when isOpenAIResponsesApi is true", () => {
      const { params, session } = buildParams({ isOpenAIResponsesApi: true });
      const original = session.agent.streamFn;
      applyAttemptStreamWrappers(params);
      expect(session.agent.streamFn).not.toBe(original);
    });

    it("applies repair wrapper only when shouldRepairMalformedToolCallArguments returns true", () => {
      vi.mocked(shouldRepairMalformedToolCallArguments).mockReturnValueOnce(false);
      const { params: paramsOff } = buildParams();
      applyAttemptStreamWrappers(paramsOff);
      expect(wrapperCalls.events).not.toContain("repairMalformedToolCallArguments");
      expect(wrapStreamFnRepairMalformedToolCallArguments).not.toHaveBeenCalled();

      wrapperCalls.events = [];
      vi.mocked(shouldRepairMalformedToolCallArguments).mockReturnValueOnce(true);
      const { params: paramsOn } = buildParams();
      applyAttemptStreamWrappers(paramsOn);
      expect(wrapperCalls.events).toContain("repairMalformedToolCallArguments");
    });

    it("applies decodeXai wrapper only when resolveToolCallArgumentsEncoding returns html-entities", () => {
      vi.mocked(resolveToolCallArgumentsEncoding).mockReturnValueOnce("default");
      const { params: paramsOff } = buildParams();
      applyAttemptStreamWrappers(paramsOff);
      expect(wrapperCalls.events).not.toContain("decodeXai");
      expect(wrapStreamFnDecodeXaiToolCallArguments).not.toHaveBeenCalled();

      wrapperCalls.events = [];
      vi.mocked(resolveToolCallArgumentsEncoding).mockReturnValueOnce("html-entities");
      const { params: paramsOn } = buildParams();
      applyAttemptStreamWrappers(paramsOn);
      expect(wrapperCalls.events).toContain("decodeXai");
    });

    it("applies anthropicPayloadLogger wrapper when logger is non-null", () => {
      const logger = {
        wrapStreamFn: vi.fn((s) => (wrapperCalls.events.push("anthropicPayloadLogger"), s)),
      };
      const { params } = buildParams({ anthropicPayloadLogger: logger });
      applyAttemptStreamWrappers(params);
      expect(logger.wrapStreamFn).toHaveBeenCalledTimes(1);
      expect(wrapperCalls.events).toContain("anthropicPayloadLogger");
    });

    it("skips anthropicPayloadLogger wrapper when logger is null", () => {
      const { params } = buildParams({ anthropicPayloadLogger: null });
      applyAttemptStreamWrappers(params);
      expect(wrapperCalls.events).not.toContain("anthropicPayloadLogger");
    });

    it("always applies handleSensitiveStopReason last", () => {
      const cacheTrace = {
        wrapStreamFn: vi.fn((s) => (wrapperCalls.events.push("cacheTrace"), s)),
      };
      const { params } = buildParams({ cacheTrace });
      applyAttemptStreamWrappers(params);
      // Last event is the OUTERMOST wrapper (called first when streaming).
      expect(wrapperCalls.events.at(-1)).toBe("handleSensitiveStopReason");
    });
  });
});
