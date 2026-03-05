import { describe, it, expect } from "vitest";
import { buildEmbeddedRunPayloads } from "./payloads.js";

describe("buildEmbeddedRunPayloads null handling", () => {
  it("should handle undefined assistantTexts without throwing", () => {
    expect(() => {
      buildEmbeddedRunPayloads({
        assistantTexts: undefined as unknown as string[],
        toolMetas: [],
        lastAssistant: undefined,
        config: undefined,
        sessionKey: "test-session",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        verboseLevel: "off",
        reasoningLevel: "off",
        toolResultFormat: "markdown",
        suppressToolErrorWarnings: false,
        inlineToolResultsAllowed: false,
        didSendViaMessagingTool: false,
      });
    }).not.toThrow();
  });

  it("should handle undefined toolMetas without throwing", () => {
    expect(() => {
      buildEmbeddedRunPayloads({
        assistantTexts: [],
        toolMetas: undefined as unknown as Array<{ toolName: string; meta?: string }>,
        lastAssistant: undefined,
        config: undefined,
        sessionKey: "test-session",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        verboseLevel: "off",
        reasoningLevel: "off",
        toolResultFormat: "markdown",
        suppressToolErrorWarnings: false,
        inlineToolResultsAllowed: false,
        didSendViaMessagingTool: false,
      });
    }).not.toThrow();
  });

  it("should handle both undefined without throwing", () => {
    expect(() => {
      buildEmbeddedRunPayloads({
        assistantTexts: undefined as unknown as string[],
        toolMetas: undefined as unknown as Array<{ toolName: string; meta?: string }>,
        lastAssistant: undefined,
        config: undefined,
        sessionKey: "test-session",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        verboseLevel: "off",
        reasoningLevel: "off",
        toolResultFormat: "markdown",
        suppressToolErrorWarnings: false,
        inlineToolResultsAllowed: false,
        didSendViaMessagingTool: false,
      });
    }).not.toThrow();
  });

  it("should return empty array when both are undefined", () => {
    const result = buildEmbeddedRunPayloads({
      assistantTexts: undefined as unknown as string[],
      toolMetas: undefined as unknown as Array<{ toolName: string; meta?: string }>,
      lastAssistant: undefined,
      config: undefined,
      sessionKey: "test-session",
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      verboseLevel: "off",
      reasoningLevel: "off",
      toolResultFormat: "markdown",
      suppressToolErrorWarnings: false,
      inlineToolResultsAllowed: false,
      didSendViaMessagingTool: false,
    });
    expect(result).toEqual([]);
  });

  it("should handle null assistantTexts without throwing", () => {
    expect(() => {
      buildEmbeddedRunPayloads({
        assistantTexts: null as unknown as string[],
        toolMetas: [],
        lastAssistant: undefined,
        config: undefined,
        sessionKey: "test-session",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        verboseLevel: "off",
        reasoningLevel: "off",
        toolResultFormat: "markdown",
        suppressToolErrorWarnings: false,
        inlineToolResultsAllowed: false,
        didSendViaMessagingTool: false,
      });
    }).not.toThrow();
  });

  it("should handle null toolMetas without throwing", () => {
    expect(() => {
      buildEmbeddedRunPayloads({
        assistantTexts: [],
        toolMetas: null as unknown as Array<{ toolName: string; meta?: string }>,
        lastAssistant: undefined,
        config: undefined,
        sessionKey: "test-session",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        verboseLevel: "off",
        reasoningLevel: "off",
        toolResultFormat: "markdown",
        suppressToolErrorWarnings: false,
        inlineToolResultsAllowed: false,
        didSendViaMessagingTool: false,
      });
    }).not.toThrow();
  });

  it("should work normally with valid arrays", () => {
    const result = buildEmbeddedRunPayloads({
      assistantTexts: ["Hello, world!"],
      toolMetas: [{ toolName: "test_tool", meta: "test meta" }],
      lastAssistant: undefined,
      config: undefined,
      sessionKey: "test-session",
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      verboseLevel: "off",
      reasoningLevel: "off",
      toolResultFormat: "markdown",
      suppressToolErrorWarnings: false,
      inlineToolResultsAllowed: false,
      didSendViaMessagingTool: false,
    });
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Hello, world!");
  });
});
