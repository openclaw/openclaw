import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  logCorruptedToolResult,
  sanitizeCorruptedToolResult,
  validateAndSanitizeToolResult,
  validateToolResultForPersistence,
} from "./session-tool-result-validation.js";

describe("validateToolResultForPersistence", () => {
  it("returns valid for well-formed tool result", () => {
    const message = {
      role: "toolResult" as const,
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "file contents here" }],
      isError: false,
    } as AgentMessage;

    const result = validateToolResultForPersistence(message);
    expect(result.valid).toBe(true);
    expect(result.message).toBe(message);
    expect(result.error).toBeUndefined();
  });

  it("returns valid for message with unicode content", () => {
    const message = {
      role: "toolResult" as const,
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "Hello 世界 🌍 Привет" }],
      isError: false,
    } as AgentMessage;

    const result = validateToolResultForPersistence(message);
    expect(result.valid).toBe(true);
  });

  it("returns invalid for message with circular reference", () => {
    const message: Record<string, unknown> = {
      role: "toolResult",
      toolCallId: "call_1",
      content: [{ type: "text", text: "ok" }],
    };
    message.circular = message;

    const result = validateToolResultForPersistence(message as AgentMessage);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain("circular");
  });

  it("returns invalid for message with BigInt (non-serializable)", () => {
    const message = {
      role: "toolResult" as const,
      toolCallId: "call_1",
      content: [{ type: "text", text: "ok" }],
      bigNumber: BigInt(9007199254740991),
    } as unknown as AgentMessage;

    const result = validateToolResultForPersistence(message);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("sanitizeCorruptedToolResult", () => {
  it("creates a valid placeholder message", () => {
    const corrupted = {
      role: "toolResult" as const,
      toolCallId: "call_1",
      toolName: "exec",
      content: "invalid",
    } as AgentMessage;

    const sanitized = sanitizeCorruptedToolResult(corrupted, {
      toolCallId: "call_1",
      toolName: "exec",
    });

    expect(sanitized.role).toBe("toolResult");
    expect((sanitized as { toolCallId: string }).toolCallId).toBe("call_1");
    expect((sanitized as { toolName: string }).toolName).toBe("exec");
    expect((sanitized as { isError: boolean }).isError).toBe(true);
    expect(
      (sanitized as { content: Array<{ type: string; text: string }> }).content[0].text,
    ).toContain("corrupted");
  });

  it("uses fallback values when meta is incomplete", () => {
    const corrupted = {} as AgentMessage;

    const sanitized = sanitizeCorruptedToolResult(corrupted, {});

    expect((sanitized as { toolCallId: string }).toolCallId).toBe("unknown");
    expect((sanitized as { toolName: string }).toolName).toBe("unknown");
  });

  it("extracts toolCallId from message when not in meta", () => {
    const corrupted = {
      role: "toolResult" as const,
      toolCallId: "from_message",
      toolName: "from_message_tool",
    } as AgentMessage;

    const sanitized = sanitizeCorruptedToolResult(corrupted, {});

    expect((sanitized as { toolCallId: string }).toolCallId).toBe("from_message");
    expect((sanitized as { toolName: string }).toolName).toBe("from_message_tool");
  });
});

describe("logCorruptedToolResult", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-validation-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates debug log file with corruption details", () => {
    // Mock the debug directory to use our temp dir
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const message = {
        role: "toolResult" as const,
        toolCallId: "call_1",
        content: [{ type: "text", text: "some content" }],
      } as AgentMessage;

      const error = new Error("JSON.stringify failed");

      const filepath = logCorruptedToolResult(message, error, {
        toolCallId: "call_1",
        toolName: "exec",
        sessionKey: "test-session",
      });

      expect(filepath).not.toBeNull();
      expect(fs.existsSync(filepath!)).toBe(true);

      const content = JSON.parse(fs.readFileSync(filepath!, "utf-8"));
      expect(content.sessionKey).toBe("test-session");
      expect(content.toolCallId).toBe("call_1");
      expect(content.toolName).toBe("exec");
      expect(content.error.message).toBe("JSON.stringify failed");
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("returns null on write failure without throwing", () => {
    // Temporarily make mkdirSync throw to simulate write failure
    const originalMkdirSync = fs.mkdirSync;
    fs.mkdirSync = () => {
      throw new Error("simulated write failure");
    };

    try {
      const filepath = logCorruptedToolResult({} as AgentMessage, new Error("test"), {});
      // Should return null on any write failure
      expect(filepath).toBeNull();
    } finally {
      fs.mkdirSync = originalMkdirSync;
    }
  });
});

describe("validateAndSanitizeToolResult", () => {
  it("returns original message when valid", () => {
    const message = {
      role: "toolResult" as const,
      toolCallId: "call_1",
      content: [{ type: "text", text: "ok" }],
    } as AgentMessage;

    const result = validateAndSanitizeToolResult(message, {
      toolCallId: "call_1",
      toolName: "read",
    });

    expect(result.wasCorrupted).toBe(false);
    expect(result.message).toBe(message);
  });

  it("sanitizes and warns on corrupted message", () => {
    const message: Record<string, unknown> = {
      role: "toolResult",
      toolCallId: "call_1",
    };
    message.circular = message;

    const warnings: string[] = [];
    const result = validateAndSanitizeToolResult(message as AgentMessage, {
      toolCallId: "call_1",
      toolName: "exec",
      sessionKey: "test",
      warn: (msg) => warnings.push(msg),
    });

    expect(result.wasCorrupted).toBe(true);
    expect(result.error).toBeDefined();
    expect((result.message as { isError: boolean }).isError).toBe(true);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("corrupted");
    expect(warnings[0]).toContain("exec");
  });

  it("continues session flow even with corrupted output", () => {
    // This test verifies the graceful degradation behavior
    const corrupted: Record<string, unknown> = {
      role: "toolResult",
      toolCallId: "call_1",
    };
    corrupted.self = corrupted;

    const result = validateAndSanitizeToolResult(corrupted as AgentMessage, {
      toolCallId: "call_1",
      toolName: "exec",
    });

    // Session should continue with sanitized message
    expect(result.message).toBeDefined();
    expect((result.message as { role: string }).role).toBe("toolResult");

    // The sanitized message should be valid JSON
    expect(() => JSON.stringify(result.message)).not.toThrow();
  });
});
