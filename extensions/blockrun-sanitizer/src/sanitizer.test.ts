/**
 * Unit tests for blockrun-sanitizer content sanitization logic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock runEmbeddedPiAgent before importing sanitizer
const mockRunEmbeddedPiAgent = vi.fn();

vi.mock("../../../src/agents/pi-embedded-runner.js", () => ({
  runEmbeddedPiAgent: mockRunEmbeddedPiAgent,
}));

import type {
  OpenClawPluginApi,
  PluginHookAfterExternalContentWrapEvent,
} from "../../../src/plugins/types.js";
import { sanitizeContent, type SanitizerConfig } from "./sanitizer.js";

function makeConfig(overrides?: Partial<SanitizerConfig>): SanitizerConfig {
  return {
    enabled: true,
    workerProvider: "blockrun",
    workerModel: "deepseek/deepseek-chat",
    maxContentLength: 10_000,
    timeoutMs: 15_000,
    blockOnDetection: false,
    ...overrides,
  };
}

function makeApi(): OpenClawPluginApi {
  return {
    id: "blockrun-sanitizer",
    name: "BlockRun Content Sanitizer",
    source: "test",
    config: { agents: { defaults: { workspace: "/tmp" } } } as never,
    pluginConfig: {},
    runtime: {} as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: (p: string) => p,
    on: vi.fn(),
  };
}

function makeEvent(
  overrides?: Partial<PluginHookAfterExternalContentWrapEvent>,
): PluginHookAfterExternalContentWrapEvent {
  return {
    wrappedContent:
      "<<<EXTERNAL_UNTRUSTED_CONTENT>>>\nSome article content\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>",
    rawContent: "Some article content about technology trends in 2026",
    source: "web_fetch",
    origin: "https://example.com/article",
    ...overrides,
  };
}

describe("sanitizeContent", () => {
  beforeEach(() => {
    mockRunEmbeddedPiAgent.mockReset();
  });

  it("skips content shorter than 50 chars", async () => {
    const result = await sanitizeContent(
      makeEvent({ rawContent: "short" }),
      makeConfig(),
      makeApi(),
    );
    expect(result).toBeUndefined();
    expect(mockRunEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("returns sanitized content for safe input", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValue({
      payloads: [
        {
          text: JSON.stringify({
            safe: true,
            summary: "Article about technology trends in 2026",
            injections: [],
          }),
        },
      ],
    });

    const result = await sanitizeContent(makeEvent(), makeConfig(), makeApi());

    expect(result).toBeDefined();
    expect(result?.block).toBeUndefined();
    expect(result?.sanitizedContent).toContain("<<<SANITIZED_EXTERNAL_CONTENT>>>");
    expect(result?.sanitizedContent).toContain("Article about technology trends in 2026");
    expect(result?.sanitizedContent).toContain("https://example.com/article");
    expect(result?.sanitizedContent).not.toContain("injection attempts");
  });

  it("returns sanitized content with injection warning when injections detected", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValue({
      payloads: [
        {
          text: JSON.stringify({
            safe: false,
            summary: "Article about tech",
            injections: ["Attempted to override system prompt"],
          }),
        },
      ],
    });

    const result = await sanitizeContent(makeEvent(), makeConfig(), makeApi());

    expect(result?.sanitizedContent).toContain("detected and removed potential injection attempts");
    expect(result?.sanitizedContent).toContain("Article about tech");
    expect(result?.block).toBeUndefined();
  });

  it("blocks content when blockOnDetection is true and injection detected", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValue({
      payloads: [
        {
          text: JSON.stringify({
            safe: false,
            summary: "",
            injections: ["Full injection attempt"],
          }),
        },
      ],
    });

    const result = await sanitizeContent(
      makeEvent(),
      makeConfig({ blockOnDetection: true }),
      makeApi(),
    );

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("Injection detected");
  });

  it("fails open when Worker LLM call throws", async () => {
    mockRunEmbeddedPiAgent.mockRejectedValue(new Error("timeout"));

    const api = makeApi();
    const result = await sanitizeContent(makeEvent(), makeConfig(), api);

    expect(result).toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("Worker LLM call failed"));
  });

  it("fails open when Worker returns empty response", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValue({ payloads: [] });

    const api = makeApi();
    const result = await sanitizeContent(makeEvent(), makeConfig(), api);

    expect(result).toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("empty response"));
  });

  it("fails open when Worker returns unparseable JSON", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValue({
      payloads: [{ text: "not valid json at all" }],
    });

    const api = makeApi();
    const result = await sanitizeContent(makeEvent(), makeConfig(), api);

    expect(result).toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("unparseable"));
  });

  it("handles markdown-fenced JSON from Worker", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValue({
      payloads: [
        {
          text: '```json\n{"safe": true, "summary": "Clean data", "injections": []}\n```',
        },
      ],
    });

    const result = await sanitizeContent(makeEvent(), makeConfig(), makeApi());

    expect(result?.sanitizedContent).toContain("Clean data");
  });

  it("truncates content to maxContentLength", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValue({
      payloads: [
        {
          text: JSON.stringify({ safe: true, summary: "Truncated", injections: [] }),
        },
      ],
    });

    const longContent = "x".repeat(20_000);
    await sanitizeContent(
      makeEvent({ rawContent: longContent }),
      makeConfig({ maxContentLength: 500 }),
      makeApi(),
    );

    const callArgs = mockRunEmbeddedPiAgent.mock.calls[0]?.[0] as { prompt?: string } | undefined;
    expect(callArgs?.prompt).toBeDefined();
    // The prompt should contain at most 500 chars of the raw content
    const inputSection = callArgs?.prompt?.split("---INPUT---")[1]?.split("---END INPUT---")[0];
    expect(inputSection).toBeDefined();
    expect((inputSection ?? "").trim().length).toBeLessThanOrEqual(500);
  });

  it("passes disableTools: true to Worker", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValue({
      payloads: [
        {
          text: JSON.stringify({ safe: true, summary: "ok", injections: [] }),
        },
      ],
    });

    await sanitizeContent(makeEvent(), makeConfig(), makeApi());

    const callArgs = mockRunEmbeddedPiAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.disableTools).toBe(true);
    expect(callArgs.provider).toBe("blockrun");
    expect(callArgs.model).toBe("deepseek/deepseek-chat");
  });
});
