import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  addConversationCacheMarkers,
  applyExtraParamsToAgent,
  countExistingCacheBlocks,
} from "../pi-embedded-runner.js";

// Mock the logger to avoid noise in tests
vi.mock("./logger.js", () => ({
  log: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

type TestMessage = {
  role?: string;
  content: string | Array<{ type: string; text?: string; cache_control?: { type: string } }>;
};

function makeMessages(count: number): TestMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i}`,
  }));
}

type MsgLike = { content?: unknown };

function countCacheMarkers(messages: MsgLike[]): number {
  let count = 0;
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ cache_control?: { type: string } }>) {
        if (block.cache_control?.type === "ephemeral") {
          count++;
        }
      }
    }
  }
  return count;
}

function getCacheMarkerIndices(messages: MsgLike[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ cache_control?: { type: string } }>) {
        if (block.cache_control?.type === "ephemeral") {
          indices.push(i);
        }
      }
    }
  }
  return indices;
}

describe("addConversationCacheMarkers", () => {
  it("skips short sessions with fewer than minStable stable messages", () => {
    // 25 total messages, tail=30 → stableCutoff = 0 → no markers
    const messages = makeMessages(25);
    const result = addConversationCacheMarkers(messages, 30);
    expect(countCacheMarkers(result)).toBe(0);
  });

  it("skips when stable messages are below minStable threshold", () => {
    // 40 total, tail=30 → stableCutoff = 10 → below default minStable (20)
    const messages = makeMessages(40);
    const result = addConversationCacheMarkers(messages, 30);
    expect(countCacheMarkers(result)).toBe(0);
  });

  it("places 1 marker for a medium session", () => {
    // 55 total, tail=30 → stableCutoff = 25 → floor(25/20) = 1 marker
    const messages = makeMessages(55);
    const result = addConversationCacheMarkers(messages, 30);
    expect(countCacheMarkers(result)).toBe(1);

    // Marker placed at the end of the stable zone (indices 0..24)
    // With 1 marker: idx = floor(25 * 1 / 1) - 1 = 24
    const indices = getCacheMarkerIndices(result);
    expect(indices).toEqual([24]);
  });

  it("places 2 markers for a longer session", () => {
    // 80 total, tail=30 → stableCutoff = 50 → floor(50/20) = 2 markers (capped at 2)
    const messages = makeMessages(80);
    const result = addConversationCacheMarkers(messages, 30);
    expect(countCacheMarkers(result)).toBe(2);

    // Markers at: floor(50*1/2)-1 = 24, floor(50*2/2)-1 = 49
    const indices = getCacheMarkerIndices(result);
    expect(indices).toEqual([24, 49]);
  });

  it("places 2 markers (maximum) for a long session", () => {
    // 120 total, tail=30 → stableCutoff = 90 → floor(90/20) = 4 → capped at MAX=2
    const messages = makeMessages(120);
    const result = addConversationCacheMarkers(messages, 30);
    expect(countCacheMarkers(result)).toBe(2);

    // Markers at: floor(90*1/2)-1 = 44, floor(90*2/2)-1 = 89
    const indices = getCacheMarkerIndices(result);
    expect(indices).toEqual([44, 89]);

    // All markers should be in the stable zone (before index 90)
    for (const idx of indices) {
      expect(idx).toBeLessThan(90);
    }
  });

  it("caches all messages when tailCount=0", () => {
    // 60 total, tail=0 → stableCutoff = 60 → 2 markers (capped at MAX=2)
    const messages = makeMessages(60);
    const result = addConversationCacheMarkers(messages, 0);
    expect(countCacheMarkers(result)).toBe(2);

    // With stableCutoff=60 and 2 markers:
    // idx = floor(60*1/2)-1 = 29, floor(60*2/2)-1 = 59
    const indices = getCacheMarkerIndices(result);
    expect(indices).toEqual([29, 59]);
  });

  it("converts string content to content blocks when adding markers", () => {
    const messages = makeMessages(55);
    // Verify content starts as string
    // With 55 msgs, tail=30 → stableCutoff=25, 1 marker at floor(25*1/1)-1 = 24
    expect(typeof messages[24].content).toBe("string");

    addConversationCacheMarkers(messages, 30);

    // The marked message should have its content converted to blocks
    expect(Array.isArray(messages[24].content)).toBe(true);
    const blocks = messages[24].content as Array<{
      type: string;
      text?: string;
      cache_control?: { type: string };
    }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("message 24");
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("attaches cache_control to last block of existing content arrays", () => {
    const messages = makeMessages(55);
    // Pre-convert the marker message (index 24) to content block format
    // With 55 msgs, tail=30 → stableCutoff=25, 1 marker at floor(25*1/1)-1 = 24
    messages[24].content = [
      { type: "text", text: "first part" },
      { type: "text", text: "second part" },
    ];

    addConversationCacheMarkers(messages, 30);

    const blocks = messages[24].content as Array<{
      type: string;
      text?: string;
      cache_control?: { type: string };
    }>;
    // cache_control should be on the last block only
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("uses custom minStable parameter", () => {
    // 40 total, tail=30, minStable=5 → stableCutoff=10 → floor(10/5) = 2 markers
    const messages = makeMessages(40);
    const result = addConversationCacheMarkers(messages, 30, 5);
    expect(countCacheMarkers(result)).toBe(2);
  });

  it("does not modify messages outside the stable zone", () => {
    const messages = makeMessages(120);
    addConversationCacheMarkers(messages, 30);

    // Messages from index 90 onward (tail zone) should remain as strings
    for (let i = 90; i < 120; i++) {
      expect(typeof messages[i].content).toBe("string");
    }
  });
});

describe("addConversationCacheMarkers — maxMarkers parameter", () => {
  it("respects explicit maxMarkers cap below default", () => {
    // 120 total, tail=30 → stableCutoff=90 → normally 2 markers, but cap to 1
    const messages = makeMessages(120);
    const result = addConversationCacheMarkers(messages, 30, 20, "1h", 1);
    expect(countCacheMarkers(result)).toBe(1);
  });

  it("places 0 markers when maxMarkers=0 (no slots available)", () => {
    const messages = makeMessages(120);
    const result = addConversationCacheMarkers(messages, 30, 20, "1h", 0);
    expect(countCacheMarkers(result)).toBe(0);
  });
});

describe("countExistingCacheBlocks", () => {
  it("returns 0 for empty payload", () => {
    expect(countExistingCacheBlocks({})).toBe(0);
  });

  it("counts system blocks with cache_control", () => {
    const payload = {
      system: [
        { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
        { type: "text", text: "world" }, // no cache
      ],
    };
    expect(countExistingCacheBlocks(payload)).toBe(1);
  });

  it("counts multiple system blocks (OAuth path has 2)", () => {
    const payload = {
      system: [
        { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } },
        { type: "text", text: "System prompt here", cache_control: { type: "ephemeral" } },
      ],
    };
    expect(countExistingCacheBlocks(payload)).toBe(2);
  });

  it("counts cache_control on tool definitions", () => {
    const payload = {
      tools: [{ name: "read" }, { name: "write", cache_control: { type: "ephemeral" } }],
    };
    expect(countExistingCacheBlocks(payload)).toBe(1);
  });

  it("counts cache_control on message content blocks", () => {
    const payload = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
        },
        { role: "assistant", content: "response" }, // string, no blocks
        { role: "user", content: [{ type: "text", text: "bye" }] }, // no cache
      ],
    };
    expect(countExistingCacheBlocks(payload)).toBe(1);
  });

  it("sums across system + tools + messages", () => {
    const payload = {
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "read", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
        },
      ],
    };
    expect(countExistingCacheBlocks(payload)).toBe(3);
  });
});

describe("adaptive slot limiting: wrapper respects existing cache blocks", () => {
  const cfgLong = {
    agents: {
      defaults: {
        models: { "anthropic/claude-opus-4-6": { params: { cacheRetention: "long" as const } } },
      },
    },
  };

  it("places 1 marker when payload already has 3 cache blocks (e.g. OAuth + last-user-msg)", () => {
    // OAuth path: 2 system blocks + 1 last-user-message = 3 existing → 1 slot left
    const payloads: unknown[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const messages = makeMessages(120);
      // Simulate pi-ai adding cache to the last user message (what pi-ai does)
      const last = messages[messages.length - 1];
      last.content = [{ type: "text", text: "last", cache_control: { type: "ephemeral" } }];
      const payload = {
        system: [
          { type: "text", text: "Claude Code", cache_control: { type: "ephemeral" } },
          { type: "text", text: "System prompt", cache_control: { type: "ephemeral" } },
        ],
        messages,
      };
      options?.onPayload?.(payload);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(agent, cfgLong, "anthropic", "claude-opus-4-6");

    const context: Context = { messages: [] };
    void agent.streamFn?.(
      {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-opus-4-6",
      } as Parameters<StreamFn>[0],
      context,
      {},
    );

    expect(payloads).toHaveLength(1);
    const payload = payloads[0] as { messages: MsgLike[] };
    // 3 existing blocks → 1 slot → 1 conversation marker added
    // last message is in hot tail (not touched), so total = 3 existing + 1 new = 4 ✓
    expect(countCacheMarkers(payload.messages)).toBe(2); // 1 on last-user (existing) + 1 our marker
  });

  it("places 0 markers when payload already has 4 cache blocks (all slots used)", () => {
    const payloads: unknown[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const messages = makeMessages(120);
      const last = messages[messages.length - 1];
      last.content = [{ type: "text", text: "last", cache_control: { type: "ephemeral" } }];
      const payload = {
        system: [
          { type: "text", text: "sys1", cache_control: { type: "ephemeral" } },
          { type: "text", text: "sys2", cache_control: { type: "ephemeral" } },
          { type: "text", text: "sys3", cache_control: { type: "ephemeral" } },
        ],
        messages,
      };
      options?.onPayload?.(payload);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(agent, cfgLong, "anthropic", "claude-opus-4-6");

    const context: Context = { messages: [] };
    void agent.streamFn?.(
      {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-opus-4-6",
      } as Parameters<StreamFn>[0],
      context,
      {},
    );

    expect(payloads).toHaveLength(1);
    const payload = payloads[0] as { messages: MsgLike[] };
    // 4 existing blocks → 0 slots → no markers added, only existing 1 (last-user)
    expect(countCacheMarkers(payload.messages)).toBe(1); // only the last-user one pi-ai added
  });
});

describe("conversation cache markers integration via applyExtraParamsToAgent", () => {
  it("applies cache markers via onPayload when cacheRetention is explicitly set", () => {
    // Conversation caching only activates when cacheRetention is explicitly configured.
    // This ensures pi-ai always receives cacheRetention and uses matching TTLs on its
    // own cache blocks (system/last-user-message), avoiding TTL ordering violations.
    const payloads: unknown[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = {
        messages: makeMessages(60),
      };
      options?.onPayload?.(payload);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": {
              params: { cacheRetention: "long" as const },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-opus-4-6");

    const context: Context = { messages: [] };
    void agent.streamFn?.(
      {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-opus-4-6",
      } as Parameters<StreamFn>[0],
      context,
      {},
    );

    expect(payloads).toHaveLength(1);
    const payload = payloads[0] as { messages: TestMessage[] };
    // tail=30, stableCutoff=30 → floor(30/20) = 1 marker
    expect(countCacheMarkers(payload.messages)).toBe(1);
  });

  it("does NOT apply cache markers when cacheRetention is not configured (no config)", () => {
    // Without explicit cacheRetention, pi-ai would use "short" (5m) on system blocks
    // while our markers would use ttl="1h" → Anthropic TTL ordering violation.
    const payloads: unknown[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = { messages: makeMessages(120) };
      options?.onPayload?.(payload);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "anthropic", "claude-opus-4-6");

    const context: Context = { messages: [] };
    void agent.streamFn?.(
      {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-opus-4-6",
      } as Parameters<StreamFn>[0],
      context,
      {},
    );

    expect(payloads).toHaveLength(1);
    const payload = payloads[0] as { messages: MsgLike[] };
    expect(countCacheMarkers(payload.messages)).toBe(0);
  });

  it("does not apply cache markers for non-Anthropic providers", () => {
    const payloads: unknown[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = {
        messages: makeMessages(120),
      };
      options?.onPayload?.(payload);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-4");

    const context: Context = { messages: [] };
    void agent.streamFn?.(
      { api: "openai-completions", provider: "openai", id: "gpt-4" } as Parameters<StreamFn>[0],
      context,
      {},
    );

    expect(payloads).toHaveLength(1);
    const payload = payloads[0] as { messages: TestMessage[] };
    expect(countCacheMarkers(payload.messages)).toBe(0);
  });

  it("respects cacheConversationTail: 0 to disable", () => {
    const payloads: unknown[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = {
        messages: makeMessages(120),
      };
      options?.onPayload?.(payload);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": {
              params: {
                cacheRetention: "short" as const,
                cacheConversationTail: 0,
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-opus-4-6");

    const context: Context = { messages: [] };
    void agent.streamFn?.(
      {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-opus-4-6",
      } as Parameters<StreamFn>[0],
      context,
      {},
    );

    expect(payloads).toHaveLength(1);
    const payload = payloads[0] as { messages: TestMessage[] };
    expect(countCacheMarkers(payload.messages)).toBe(0);
  });

  it("uses custom cacheConversationTail value", () => {
    const payloads: unknown[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = {
        messages: makeMessages(120),
      };
      options?.onPayload?.(payload);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": {
              params: {
                cacheRetention: "short" as const,
                cacheConversationTail: 10,
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-opus-4-6");

    const context: Context = { messages: [] };
    void agent.streamFn?.(
      {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-opus-4-6",
      } as Parameters<StreamFn>[0],
      context,
      {},
    );

    expect(payloads).toHaveLength(1);
    const payload = payloads[0] as { messages: TestMessage[] };
    // tail=10, stableCutoff=110 → 2 markers (capped at MAX=2)
    expect(countCacheMarkers(payload.messages)).toBe(2);
  });

  it.each([NaN, Infinity, -Infinity, -1])(
    "falls back to default tail when cacheConversationTail=%s",
    (invalidTail) => {
      const payloads: unknown[] = [];
      const baseStreamFn: StreamFn = (_model, _context, options) => {
        // 80 msgs: default tail=30 → stableCutoff=50 → 2 markers
        const payload = { messages: makeMessages(80) };
        options?.onPayload?.(payload);
        payloads.push(payload);
        return {} as ReturnType<StreamFn>;
      };
      const agent = { streamFn: baseStreamFn };
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: {
                  cacheRetention: "short" as const,
                  cacheConversationTail: invalidTail,
                },
              },
            },
          },
        },
      };

      applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-opus-4-6");

      const context: Context = { messages: [] };
      void agent.streamFn?.(
        {
          api: "anthropic-messages",
          provider: "anthropic",
          id: "claude-opus-4-6",
        } as Parameters<StreamFn>[0],
        context,
        {},
      );

      expect(payloads).toHaveLength(1);
      const payload = payloads[0] as { messages: MsgLike[] };
      // Falls back to default tail=30 → stableCutoff=50 → 2 markers
      expect(countCacheMarkers(payload.messages)).toBe(2);
    },
  );

  it("truncates fractional cacheConversationTail to integer", () => {
    const payloads: unknown[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      // 80 msgs: tail=10.9 → truncated to 10 → stableCutoff=70 → 3 markers (capped)
      const payload = { messages: makeMessages(80) };
      options?.onPayload?.(payload);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": {
              params: {
                cacheRetention: "short" as const,
                cacheConversationTail: 10.9,
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-opus-4-6");

    const context: Context = { messages: [] };
    void agent.streamFn?.(
      {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-opus-4-6",
      } as Parameters<StreamFn>[0],
      context,
      {},
    );

    expect(payloads).toHaveLength(1);
    const payload = payloads[0] as { messages: MsgLike[] };
    // tail truncated to 10 → stableCutoff=70 → 2 markers (capped at MAX=2)
    expect(countCacheMarkers(payload.messages)).toBe(2);
  });
});
