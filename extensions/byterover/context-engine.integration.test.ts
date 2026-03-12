import type { PluginLogger } from "openclaw/plugin-sdk/byterover";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BrvJsonResponse, BrvCurateResult, BrvQueryResult } from "./brv-process.js";
import { ByteRoverContextEngine } from "./context-engine.js";

// ---------------------------------------------------------------------------
// Mock brv-process so no real CLI is spawned
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  brvCurate: vi.fn<() => Promise<BrvJsonResponse<BrvCurateResult>>>(),
  brvQuery: vi.fn<() => Promise<BrvJsonResponse<BrvQueryResult>>>(),
}));

vi.mock("./brv-process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./brv-process.js")>();
  return {
    ...actual,
    brvCurate: mocks.brvCurate,
    brvQuery: mocks.brvQuery,
  };
});

function makeLogger(): PluginLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeCurateResponse(
  status: "completed" | "queued" = "queued",
): BrvJsonResponse<BrvCurateResult> {
  return {
    command: "curate",
    success: true,
    timestamp: new Date().toISOString(),
    data: { status, taskId: "task-123" },
  };
}

function makeQueryResponse(result: string): BrvJsonResponse<BrvQueryResult> {
  return {
    command: "query",
    success: true,
    timestamp: new Date().toISOString(),
    data: { status: "completed", result },
  };
}

// ---------------------------------------------------------------------------
// Integration tests — full engine lifecycle with mocked brv
// ---------------------------------------------------------------------------

describe("ByteRoverContextEngine integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // afterTurn → brvCurate
  // -------------------------------------------------------------------------

  describe("afterTurn → brvCurate", () => {
    it("calls brvCurate with serialized new messages and detach flag", async () => {
      mocks.brvCurate.mockResolvedValue(makeCurateResponse());
      const logger = makeLogger();
      const engine = new ByteRoverContextEngine({}, logger);

      await engine.afterTurn({
        sessionId: "s1",
        sessionFile: "/tmp/s1.jsonl",
        messages: [
          { role: "user", content: "old message" },
          { role: "user", content: "What is TypeScript?" },
          { role: "assistant", content: "<final>A typed superset of JS.</final>" },
        ],
        prePromptMessageCount: 1,
      });

      expect(mocks.brvCurate).toHaveBeenCalledOnce();
      const call = mocks.brvCurate.mock.calls[0][0];
      expect(call.detach).toBe(true);
      expect(call.context).toContain("[user]: What is TypeScript?");
      expect(call.context).toContain("[assistant]: A typed superset of JS.");
      // Curation prompt prefix should be present
      expect(call.context).toContain("Curate only information with lasting value");
      // <final> tags should be stripped
      expect(call.context).not.toContain("<final>");
    });

    it("strips metadata and attributes sender in curate context", async () => {
      mocks.brvCurate.mockResolvedValue(makeCurateResponse());
      const engine = new ByteRoverContextEngine({}, makeLogger());

      await engine.afterTurn({
        sessionId: "s1",
        sessionFile: "/tmp/s1.jsonl",
        messages: [
          {
            role: "user",
            content: [
              "Sender (untrusted metadata):",
              "```json",
              '{"name": "Alice"}',
              "```",
              "How do hooks work?",
            ].join("\n"),
          },
          { role: "assistant", content: "Hooks are lifecycle callbacks." },
        ],
        prePromptMessageCount: 0,
      });

      const call = mocks.brvCurate.mock.calls[0][0];
      expect(call.context).toContain("[Alice]: How do hooks work?");
      // Metadata block should not leak into curated context
      expect(call.context).not.toContain("untrusted metadata");
    });

    it("does not call brvCurate when all messages are toolResult", async () => {
      const logger = makeLogger();
      const engine = new ByteRoverContextEngine({}, logger);

      await engine.afterTurn({
        sessionId: "s1",
        sessionFile: "/tmp/s1.jsonl",
        messages: [{ role: "toolResult", content: "internal stuff" }],
        prePromptMessageCount: 0,
      });

      expect(mocks.brvCurate).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("empty serialized context"),
      );
    });

    it("does not fail the turn when brvCurate throws", async () => {
      mocks.brvCurate.mockRejectedValue(new Error("daemon unreachable"));
      const logger = makeLogger();
      const engine = new ByteRoverContextEngine({}, logger);

      // Should not throw
      await engine.afterTurn({
        sessionId: "s1",
        sessionFile: "/tmp/s1.jsonl",
        messages: [{ role: "user", content: "something worth curating" }],
        prePromptMessageCount: 0,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("curate failed (best-effort)"),
      );
    });
  });

  // -------------------------------------------------------------------------
  // assemble → brvQuery
  // -------------------------------------------------------------------------

  describe("assemble → brvQuery", () => {
    it("calls brvQuery with cleaned prompt and injects systemPromptAddition", async () => {
      mocks.brvQuery.mockResolvedValue(
        makeQueryResponse("User prefers TypeScript with strict mode."),
      );
      const logger = makeLogger();
      const engine = new ByteRoverContextEngine({}, logger);
      const messages = [{ role: "user", content: "Tell me about TS config" }] as unknown[];

      const result = await engine.assemble({
        sessionId: "s1",
        messages,
        prompt: "Tell me about TS config",
      });

      expect(mocks.brvQuery).toHaveBeenCalledOnce();
      const call = mocks.brvQuery.mock.calls[0][0];
      expect(call.query).toBe("Tell me about TS config");
      expect(call.signal).toBeInstanceOf(AbortSignal);

      expect(result.systemPromptAddition).toContain("<byterover-context>");
      expect(result.systemPromptAddition).toContain("User prefers TypeScript with strict mode.");
      expect(result.systemPromptAddition).toContain("</byterover-context>");
      expect(result.messages).toBe(messages);
    });

    it("strips metadata from prompt before querying brv", async () => {
      mocks.brvQuery.mockResolvedValue(makeQueryResponse("some context"));
      const engine = new ByteRoverContextEngine({}, makeLogger());

      const prompt = [
        "Sender (untrusted metadata):",
        "```json",
        '{"name": "Bob"}',
        "```",
        "How do I configure plugins?",
      ].join("\n");

      await engine.assemble({
        sessionId: "s1",
        messages: [],
        prompt,
      });

      const call = mocks.brvQuery.mock.calls[0][0];
      expect(call.query).toBe("How do I configure plugins?");
      expect(call.query).not.toContain("untrusted metadata");
    });

    it("falls back to extracting query from messages when no prompt", async () => {
      mocks.brvQuery.mockResolvedValue(makeQueryResponse("relevant context"));
      const engine = new ByteRoverContextEngine({}, makeLogger());

      const messages = [
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "What are context engines?" },
      ] as unknown[];

      const result = await engine.assemble({ sessionId: "s1", messages });

      const call = mocks.brvQuery.mock.calls[0][0];
      expect(call.query).toBe("What are context engines?");
      expect(result.systemPromptAddition).toContain("relevant context");
    });

    it("returns no systemPromptAddition when brvQuery returns empty result", async () => {
      mocks.brvQuery.mockResolvedValue(makeQueryResponse(""));
      const logger = makeLogger();
      const engine = new ByteRoverContextEngine({}, logger);

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [{ role: "user", content: "some question here" }] as unknown[],
        prompt: "some question here",
      });

      expect(result.systemPromptAddition).toBeUndefined();
      expect(logger.debug).toHaveBeenCalledWith("assemble brv query returned empty result");
    });

    it("returns no systemPromptAddition when brvQuery throws", async () => {
      mocks.brvQuery.mockRejectedValue(new Error("connection refused"));
      const logger = makeLogger();
      const engine = new ByteRoverContextEngine({}, logger);

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [],
        prompt: "a valid question",
      });

      expect(result.systemPromptAddition).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("query failed (best-effort)"),
      );
    });

    it("logs timeout warning when brvQuery is aborted", async () => {
      mocks.brvQuery.mockRejectedValue(new Error("brv query aborted"));
      const logger = makeLogger();
      const engine = new ByteRoverContextEngine({}, logger);

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [],
        prompt: "a valid question",
      });

      expect(result.systemPromptAddition).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    });

    it("uses result.content as fallback when result.result is missing", async () => {
      mocks.brvQuery.mockResolvedValue({
        command: "query",
        success: true,
        timestamp: new Date().toISOString(),
        data: { status: "completed" as const, content: "fallback content here" },
      });
      const engine = new ByteRoverContextEngine({}, makeLogger());

      const result = await engine.assemble({
        sessionId: "s1",
        messages: [],
        prompt: "tell me something",
      });

      expect(result.systemPromptAddition).toContain("fallback content here");
    });
  });

  // -------------------------------------------------------------------------
  // Full lifecycle: afterTurn → assemble
  // -------------------------------------------------------------------------

  describe("full lifecycle", () => {
    it("curates a turn then assembles context for the next query", async () => {
      mocks.brvCurate.mockResolvedValue(makeCurateResponse());
      mocks.brvQuery.mockResolvedValue(
        makeQueryResponse("Previously discussed: TypeScript strict mode is preferred."),
      );
      const logger = makeLogger();
      const engine = new ByteRoverContextEngine({}, logger);

      // Simulate turn 1: user asks about TypeScript
      const turn1Messages = [
        { role: "user", content: "What is TypeScript?" },
        { role: "assistant", content: "<final>TypeScript is a typed superset of JS.</final>" },
      ];

      await engine.afterTurn({
        sessionId: "s1",
        sessionFile: "/tmp/s1.jsonl",
        messages: turn1Messages,
        prePromptMessageCount: 0,
      });

      expect(mocks.brvCurate).toHaveBeenCalledOnce();

      // Simulate turn 2: new query retrieves curated context
      const turn2Messages = [
        ...turn1Messages,
        { role: "user", content: "How do I enable strict mode?" },
      ] as unknown[];

      const result = await engine.assemble({
        sessionId: "s1",
        messages: turn2Messages,
        prompt: "How do I enable strict mode?",
      });

      expect(mocks.brvQuery).toHaveBeenCalledOnce();
      expect(result.systemPromptAddition).toContain("TypeScript strict mode is preferred");
      expect(result.messages).toBe(turn2Messages);
      expect(result.estimatedTokens).toBe(0);
    });
  });
});
