import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import type { CacheTrace } from "../../cache-trace.js";
import type { TranscriptPolicy } from "../../transcript-policy.js";
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

vi.mock("../../transcript-policy.js", () => ({
  shouldAllowProviderOwnedThinkingReplay: vi.fn(() => false),
}));

vi.mock("../../../plugins/provider-model-compat.js", () => ({
  resolveToolCallArgumentsEncoding: vi.fn(() => "default"),
}));

vi.mock("../../pi-embedded-helpers.js", () => ({
  downgradeOpenAIFunctionCallReasoningPairs: vi.fn((m) => m),
  downgradeOpenAIReasoningBlocks: vi.fn((m) => m),
}));

import { resolveToolCallArgumentsEncoding } from "../../../plugins/provider-model-compat.js";
import {
  downgradeOpenAIFunctionCallReasoningPairs,
  downgradeOpenAIReasoningBlocks,
} from "../../pi-embedded-helpers.js";
import { dropReasoningFromHistory, dropThinkingBlocks } from "../thinking.js";
import { applyAttemptStreamWrappers } from "./attempt-stream-wrappers.js";
import {
  shouldRepairMalformedToolCallArguments,
  wrapStreamFnDecodeXaiToolCallArguments,
  wrapStreamFnRepairMalformedToolCallArguments,
} from "./attempt.tool-call-argument-repair.js";
import { sanitizeReplayToolCallIdsForStream } from "./attempt.tool-call-normalization.js";

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
      cacheTrace: (overrides.cacheTrace ?? null) as CacheTrace | null,
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
      anthropicPayloadLogger: (overrides.anthropicPayloadLogger ??
        null) as AnthropicPayloadLogger | null,
      shouldReturnYieldAbortedResponse: overrides.shouldReturnYieldAbortedResponse ?? (() => false),
    },
  };
}

async function invokeWrappedStream(params: ReturnType<typeof buildParams>["params"]) {
  await params.activeSession.agent.streamFn(
    params.model,
    { messages: [{ role: "assistant", content: "hello" }] } as never,
    {} as never,
  );
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
        wrapStreamFn: vi.fn((s) => {
          wrapperCalls.events.push("cacheTrace");
          return s;
        }),
      };
      const anthropicPayloadLogger = {
        wrapStreamFn: vi.fn((s) => {
          wrapperCalls.events.push("anthropicPayloadLogger");
          return s;
        }),
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
          toolCallIdMode: "strict",
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
        wrapStreamFn: vi.fn((s) => {
          wrapperCalls.events.push("cacheTrace");
          return s;
        }),
      };
      const { params } = buildParams({ cacheTrace });
      applyAttemptStreamWrappers(params);
      expect(wrapperCalls.events[0]).toBe("cacheTrace");
      expect(cacheTrace.wrapStreamFn).toHaveBeenCalledTimes(1);
    });

    it("applies dropThinkingBlocks wrapper when transcriptPolicy.dropThinkingBlocks is true", async () => {
      const { params } = buildParams({
        transcriptPolicy: { dropThinkingBlocks: true } as Partial<TranscriptPolicy>,
      });
      applyAttemptStreamWrappers(params);
      await invokeWrappedStream(params);
      expect(dropThinkingBlocks).toHaveBeenCalledTimes(1);
      expect(dropReasoningFromHistory).not.toHaveBeenCalled();
    });

    it("applies dropThinkingBlocks wrapper when only dropReasoningFromHistory is true", async () => {
      const { params } = buildParams({
        transcriptPolicy: { dropReasoningFromHistory: true } as Partial<TranscriptPolicy>,
      });
      applyAttemptStreamWrappers(params);
      await invokeWrappedStream(params);
      expect(dropReasoningFromHistory).toHaveBeenCalledTimes(1);
      expect(dropThinkingBlocks).not.toHaveBeenCalled();
    });

    it("skips dropThinkingBlocks wrapper when both flags are false", async () => {
      const { params } = buildParams();
      applyAttemptStreamWrappers(params);
      await invokeWrappedStream(params);
      expect(dropThinkingBlocks).not.toHaveBeenCalled();
      expect(dropReasoningFromHistory).not.toHaveBeenCalled();
    });

    it("applies sanitizeReplayToolCallIds wrapper only when all three conditions hold", async () => {
      // sanitizeToolCallIds=true, mode set, isOpenAIResponsesApi=false
      const { params: paramsAllTrue } = buildParams({
        transcriptPolicy: {
          sanitizeToolCallIds: true,
          toolCallIdMode: "strict",
        } as Partial<TranscriptPolicy>,
        isOpenAIResponsesApi: false,
      });
      applyAttemptStreamWrappers(paramsAllTrue);
      await invokeWrappedStream(paramsAllTrue);
      expect(sanitizeReplayToolCallIdsForStream).toHaveBeenCalledTimes(1);

      // isOpenAIResponsesApi=true blocks the sanitizer
      vi.clearAllMocks();
      const { params: paramsOpenAI } = buildParams({
        transcriptPolicy: {
          sanitizeToolCallIds: true,
          toolCallIdMode: "strict",
        } as Partial<TranscriptPolicy>,
        isOpenAIResponsesApi: true,
      });
      applyAttemptStreamWrappers(paramsOpenAI);
      await invokeWrappedStream(paramsOpenAI);
      expect(sanitizeReplayToolCallIdsForStream).not.toHaveBeenCalled();
      expect(downgradeOpenAIReasoningBlocks).toHaveBeenCalledTimes(1);
      expect(downgradeOpenAIFunctionCallReasoningPairs).toHaveBeenCalledTimes(1);
    });

    it("applies downgradeOpenAIResponses wrapper when isOpenAIResponsesApi is true", async () => {
      const { params } = buildParams({ isOpenAIResponsesApi: true });
      applyAttemptStreamWrappers(params);
      await invokeWrappedStream(params);
      expect(downgradeOpenAIReasoningBlocks).toHaveBeenCalledTimes(1);
      expect(downgradeOpenAIFunctionCallReasoningPairs).toHaveBeenCalledTimes(1);
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
        wrapStreamFn: vi.fn((s) => {
          wrapperCalls.events.push("anthropicPayloadLogger");
          return s;
        }),
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
        wrapStreamFn: vi.fn((s) => {
          wrapperCalls.events.push("cacheTrace");
          return s;
        }),
      };
      const { params } = buildParams({ cacheTrace });
      applyAttemptStreamWrappers(params);
      // Last event is the OUTERMOST wrapper (called first when streaming).
      expect(wrapperCalls.events.at(-1)).toBe("handleSensitiveStopReason");
    });
  });
});
