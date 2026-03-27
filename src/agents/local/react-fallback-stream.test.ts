import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as capabilitiesCache from "./capabilities-cache.js";
import * as capabilityProber from "./capability-prober.js";
import {
  injectReActPrompt,
  isUnsupportedToolError,
  parseReActResponse,
  wrapStreamFnWithReActFallback,
} from "./react-fallback-stream.js";

type StreamModel = Parameters<StreamFn>[0];
type StreamContext = Parameters<StreamFn>[1];

describe("ReAct Fallback Stream Core", () => {
  describe("Reasoning Sanitizer (<think> block stripping)", () => {
    it("strips complete think blocks for reasoning models", () => {
      const input =
        "<think>\nThis is internal thought.\nI should use a tool.\n</think>\nOkay, here is my response.";
      const result = parseReActResponse(input, true);
      expect(result.text).toBe("Okay, here is my response.");
    });

    it("strips unclosed think blocks for reasoning models (trailing stream cutoff)", () => {
      const input =
        "Here is my answer.\n<think>\nWait, I need to think more but the stream stops here";
      const result = parseReActResponse(input, true);
      expect(result.text).toBe("Here is my answer.");
    });

    it("does not strip think blocks if isReasoningModel is false", () => {
      const input = "<think>I am not a reasoning model</think>";
      const result = parseReActResponse(input, false);
      expect(result.text).toBe("<think>I am not a reasoning model</think>");
    });
  });

  describe("ReAct Action Parsing", () => {
    it("parses valid Action JSON blocks and strips them from output", () => {
      const input =
        'Thought: I need to calculate 2+2.\nAction: {"tool": "calculator", "args": {"expression": "2+2"}}\nWaiting for result.';
      const result = parseReActResponse(input, false);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("calculator");
      expect(result.toolCalls[0].arguments).toEqual({ expression: "2+2" });

      // Ensure the "Action: {...}" block is removed from the text
      expect(result.text).toContain("Thought: I need to calculate 2+2.");
      expect(result.text).toContain("Waiting for result.");
      expect(result.text).not.toContain("Action: {");
    });

    it("ignores malformed JSON inside Action blocks", () => {
      const input = 'Action: {"tool": "calc", "args": { BAD JSON';
      const result = parseReActResponse(input, false);

      expect(result.toolCalls).toHaveLength(0);
      expect(result.text).toContain("BAD JSON"); // Left in the text since it couldn't parse
    });

    it("handles braces inside strings correctly (regression for complex arguments)", () => {
      const input = 'Action: {"tool": "run_code", "args": {"code": "function() { return 42; }"}}';
      const result = parseReActResponse(input, false);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("run_code");
      expect(result.toolCalls[0].arguments).toEqual({ code: "function() { return 42; }" });
    });

    it("ignores apostrophes in natural language before the JSON block", () => {
      const input = `Action: I'll use {"tool": "read", "args": {"path": "README.md"}}`;
      const result = parseReActResponse(input, false);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("read");
      expect(result.toolCalls[0].arguments).toEqual({ path: "README.md" });
      expect(result.text).toBe("");
    });

    it("accepts OpenAI-style arguments as an alias for args", () => {
      const input = 'Action: {"tool": "read", "arguments": {"path": "README.md"}}';
      const result = parseReActResponse(input, false);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("read");
      expect(result.toolCalls[0].arguments).toEqual({ path: "README.md" });
      expect(result.text).toBe("");
    });

    it("handles multiple calls (if model hallucinates them, though we only typically execute the first)", () => {
      const input = 'Action: {"tool": "t1", "args": {}}\nAction: {"tool": "t2", "args": {}}';
      const result = parseReActResponse(input, false);

      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].name).toBe("t1");
      expect(result.toolCalls[1].name).toBe("t2");
      expect(result.text).toBe(""); // both stripped
    });
  });

  describe("Prompt Injection", () => {
    const tools = [{ name: "weather", description: "Get weather", parameters: { type: "object" } }];

    it("injects minimal profile correctly", () => {
      const prompt = injectReActPrompt("Base prompt.", tools, "minimal");
      expect(prompt).toContain("Base prompt.");
      expect(prompt).toContain("You have access to the following tools:");
      expect(prompt).not.toContain("You are an autonomous agent");
    });

    it("injects verbose profile correctly", () => {
      const prompt = injectReActPrompt(undefined, tools, "verbose");
      expect(prompt).toContain("You are an autonomous agent");
      expect(prompt).toContain("Thought: [Your internal reasoning");
    });

    it("does nothing if there are no tools", () => {
      const prompt = injectReActPrompt("Base", [], "verbose");
      expect(prompt).toBe("Base");
    });
  });

  describe("Unsupported Tool Error Detection", () => {
    it("matches common unsupported-tool variants case-insensitively", () => {
      expect(isUnsupportedToolError("model does not support tools")).toBe(true);
      expect(isUnsupportedToolError("Model Does Not Support Tools")).toBe(true);
      expect(isUnsupportedToolError("tool calling is not supported by this model")).toBe(true);
      expect(isUnsupportedToolError("TOOLS ARE NOT SUPPORTED HERE")).toBe(true);
      expect(isUnsupportedToolError("this model may not support tool use")).toBe(true);
    });

    it("does not match unrelated provider errors", () => {
      expect(isUnsupportedToolError("context window exceeded")).toBe(false);
      expect(isUnsupportedToolError("connection refused")).toBe(false);
    });
  });

  describe("Background Capability Probing", () => {
    const getModelCapabilitySpy = vi.spyOn(capabilitiesCache, "getModelCapability");
    const runBackgroundCapabilityProbeSpy = vi.spyOn(
      capabilityProber,
      "runBackgroundCapabilityProbe",
    );

    beforeEach(() => {
      vi.clearAllMocks();
      getModelCapabilitySpy.mockResolvedValue("unknown");
      runBackgroundCapabilityProbeSpy.mockResolvedValue();
    });

    function createNativeStreamFn(text: string): StreamFn {
      return () => {
        const stream = createAssistantMessageEventStream();
        setTimeout(() => {
          stream.push({
            type: "done",
            reason: "stop",
            message: {
              role: "assistant",
              content: [{ type: "text", text }],
              stopReason: "stop",
              api: "test",
              provider: "test",
              model: "test",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              timestamp: Date.now(),
            },
          });
          stream.end();
        }, 0);
        return Promise.resolve(stream);
      };
    }

    function createModel(provider: string): StreamModel {
      return { id: "tiny-llama:1b", api: "test", provider } as unknown as StreamModel;
    }

    function createContext(): StreamContext {
      return { tools: [] } as unknown as StreamContext;
    }

    it("does not queue a background probe when fallback is forced to react", async () => {
      const wrapped = wrapStreamFnWithReActFallback(createNativeStreamFn("hello"), {
        modelId: "tiny-llama:1b",
        providerId: "ollama",
        providerType: "ollama",
        toolFallback: "react",
        configDir: "/tmp/openclaw-react-probe-test",
      });

      const stream = await wrapped(createModel("ollama"), createContext(), {});
      for await (const _ of stream) {
        // consume
      }
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(runBackgroundCapabilityProbeSpy).not.toHaveBeenCalled();
    });

    it("queues a background probe in auto mode when capability is still unknown and the turn has no tools", async () => {
      const wrapped = wrapStreamFnWithReActFallback(createNativeStreamFn("hello"), {
        modelId: "tiny-llama:1b",
        providerId: "ollama",
        providerType: "ollama",
        toolFallback: "auto",
        configDir: "/tmp/openclaw-auto-probe-test",
      });

      const stream = await wrapped(createModel("ollama"), createContext(), {});
      for await (const _ of stream) {
        // consume
      }
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(runBackgroundCapabilityProbeSpy).toHaveBeenCalledTimes(1);
    });

    it("does not queue a background probe when fallback is explicitly disabled", async () => {
      const wrapped = wrapStreamFnWithReActFallback(createNativeStreamFn("hello"), {
        modelId: "tiny-llama:1b",
        providerId: "ollama",
        providerType: "ollama",
        toolFallback: "none",
        configDir: "/tmp/openclaw-none-probe-test",
      });

      const stream = await wrapped(createModel("ollama"), createContext(), {});
      for await (const _ of stream) {
        // consume
      }
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(runBackgroundCapabilityProbeSpy).not.toHaveBeenCalled();
    });

    it("forwards result-only terminal assistant messages through the fallback wrapper", async () => {
      const wrapped = wrapStreamFnWithReActFallback(
        (() =>
          Promise.resolve({
            async *[Symbol.asyncIterator]() {},
            result: async () => ({
              role: "assistant" as const,
              content: [{ type: "text" as const, text: "" }],
              stopReason: "aborted" as const,
              api: "test",
              provider: "ollama",
              model: "tiny-llama:1b",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              timestamp: Date.now(),
            }),
          }) as unknown as Awaited<ReturnType<StreamFn>>) as StreamFn,
        {
          modelId: "tiny-llama:1b",
          providerId: "ollama",
          providerType: "ollama",
          toolFallback: "react",
        },
      );

      const stream = await wrapped(
        createModel("ollama"),
        { tools: [{ name: "read", description: "Read a file" }] } as unknown as StreamContext,
        {},
      );

      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(0);
      const result = await stream.result();
      expect(result.stopReason).toBe("aborted");
      expect(result.content).toEqual([]);
    });
  });
});
