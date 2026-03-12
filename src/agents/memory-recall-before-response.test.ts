import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildMemoryRecallBeforeResponse,
  buildRecallSystemPromptAddition,
} from "./memory-recall-before-response.js";

const getMemorySearchManagerMock = vi.fn();

vi.mock("../memory/index.js", () => ({
  getMemorySearchManager: (...args: unknown[]) => getMemorySearchManagerMock(...args),
}));

const asConfig = (cfg: OpenClawConfig): OpenClawConfig => cfg;

describe("memory recall before response", () => {
  beforeEach(() => {
    getMemorySearchManagerMock.mockReset();
  });

  it("returns disabled result when recallBeforeResponse is not configured", async () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
          },
        },
      },
    });

    const result = await buildMemoryRecallBeforeResponse({
      config: cfg,
      agentId: "main",
      sessionKey: "main",
      prompt: "follow policy",
    });

    expect(result).toEqual({
      enabled: false,
      enforced: false,
      checked: false,
      injected: false,
    });
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
  });

  it("injects recalled snippets when recallBeforeResponse is enabled", async () => {
    getMemorySearchManagerMock.mockResolvedValue({
      manager: {
        search: vi.fn().mockResolvedValue([
          {
            path: "MEMORY.md",
            startLine: 12,
            endLine: 14,
            score: 0.92,
            snippet: "Always send completion before start notification.",
            source: "memory",
          },
        ]),
      },
    });

    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            recallBeforeResponse: {
              enabled: true,
            },
          },
        },
      },
    });

    const result = await buildMemoryRecallBeforeResponse({
      config: cfg,
      agentId: "main",
      sessionKey: "main",
      prompt: "next step started",
    });

    expect(result.enabled).toBe(true);
    expect(result.enforced).toBe(false);
    expect(result.checked).toBe(true);
    expect(result.injected).toBe(true);
    expect(result.systemPromptAddition).toContain("Runtime-Enforced Memory Recall");
    expect(result.systemPromptAddition).toContain("MEMORY.md#L12-L14");
  });

  it("reports enforce mode failures when memory manager is unavailable", async () => {
    getMemorySearchManagerMock.mockResolvedValue({
      manager: null,
      error: "provider unavailable",
    });

    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            recallBeforeResponse: {
              enabled: true,
              mode: "enforce",
            },
          },
        },
      },
    });

    const result = await buildMemoryRecallBeforeResponse({
      config: cfg,
      agentId: "main",
      sessionKey: "main",
      prompt: "hello",
    });

    expect(result).toEqual({
      enabled: true,
      enforced: true,
      checked: false,
      injected: false,
      error: "provider unavailable",
    });
  });

  it("surfaces memory_search_disabled when recall is enabled but memory search is off", async () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            enabled: false,
            recallBeforeResponse: {
              enabled: true,
            },
          },
        },
      },
    });

    const result = await buildMemoryRecallBeforeResponse({
      config: cfg,
      agentId: "main",
      sessionKey: "main",
      prompt: "hello",
    });

    expect(result).toEqual({
      enabled: true,
      enforced: false,
      checked: false,
      injected: false,
      error: "memory_search_disabled",
    });
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
  });

  it("treats empty prompt as a no-op recall check (no error)", async () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: "openai",
            recallBeforeResponse: {
              enabled: true,
              mode: "enforce",
            },
          },
        },
      },
    });

    const result = await buildMemoryRecallBeforeResponse({
      config: cfg,
      agentId: "main",
      sessionKey: "main",
      prompt: "   ",
    });

    expect(result).toEqual({
      enabled: true,
      enforced: true,
      checked: true,
      injected: false,
    });
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
  });

  it("truncates long recall additions to maxChars budget", () => {
    const out = buildRecallSystemPromptAddition({
      maxChars: 220,
      results: [
        {
          path: "memory/rules.md",
          startLine: 1,
          endLine: 1,
          score: 0.99,
          snippet:
            "This is a very long snippet that should be truncated by the prompt budget to avoid oversized system prompt injections.",
          source: "memory",
        },
      ],
    });

    expect(out).toBeDefined();
    expect(out?.length).toBeLessThanOrEqual(220);
    expect(out).toContain("...");
  });
});
