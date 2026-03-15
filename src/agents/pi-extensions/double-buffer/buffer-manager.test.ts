/**
 * Tests for the double-buffered context window manager.
 *
 * Reference: https://marklubin.me/posts/hopping-context-windows/
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { BufferManager } from "./buffer-manager.js";
import type { BufferManagerDeps } from "./buffer-manager.js";
import {
  DEFAULT_DOUBLE_BUFFER_SETTINGS,
  computeEffectiveDoubleBufferSettings,
} from "./settings.js";
import type { EffectiveDoubleBufferSettings } from "./settings.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(id: number, charCount: number): AgentMessage {
  return {
    role: "user",
    content: "x".repeat(charCount),
    timestamp: id,
  };
}

/** Create a summarize stub that resolves immediately with a short summary. */
function makeSummarizeDep(summary = "summary of prior context"): BufferManagerDeps {
  return {
    summarize: vi.fn().mockResolvedValue(summary),
  };
}

/** Create a summarize stub that hangs until the returned resolve fn is called. */
function makeBlockingSummarizeDep(summary = "blocking summary"): {
  deps: BufferManagerDeps;
  resolve: () => void;
  reject: (err: Error) => void;
} {
  let resolveFn: ((value: string) => void) | undefined;
  let rejectFn: ((err: Error) => void) | undefined;
  const deps: BufferManagerDeps = {
    summarize: vi.fn().mockReturnValue(
      new Promise<string>((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      }),
    ),
  };
  return {
    deps,
    resolve: () => resolveFn?.(summary),
    reject: (err: Error) => rejectFn?.(err),
  };
}

function makeSettings(
  overrides: Partial<EffectiveDoubleBufferSettings> = {},
): EffectiveDoubleBufferSettings {
  return { ...DEFAULT_DOUBLE_BUFFER_SETTINGS, ...overrides };
}

/**
 * Context window = 1000 tokens. At 4 chars/token, 1000 tokens = 4000 chars.
 * checkpoint at 70% = 700 tokens = 2800 chars.
 * swap at 95% = 950 tokens = 3800 chars.
 */
const CONTEXT_WINDOW = 1000;

function createManager(params?: {
  settings?: Partial<EffectiveDoubleBufferSettings>;
  deps?: BufferManagerDeps;
  contextWindowTokens?: number;
  initialSummary?: string;
}): BufferManager {
  return new BufferManager({
    settings: makeSettings(params?.settings),
    contextWindowTokens: params?.contextWindowTokens ?? CONTEXT_WINDOW,
    deps: params?.deps ?? makeSummarizeDep(),
    initialSummary: params?.initialSummary,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BufferManager", () => {
  describe("initial state", () => {
    it("starts with no back buffer and empty active buffer", () => {
      const manager = createManager();
      const snap = manager.snapshot();
      expect(snap.hasBackBuffer).toBe(false);
      expect(snap.activeBuffer.messages).toHaveLength(0);
      expect(snap.activeBuffer.summary).toBeUndefined();
      expect(snap.backBuffer).toBeNull();
      expect(snap.checkpointInFlight).toBe(false);
    });

    it("accepts an initial summary", () => {
      const manager = createManager({ initialSummary: "seed summary" });
      const snap = manager.snapshot();
      expect(snap.activeBuffer.summary).toBe("seed summary");
      expect(snap.summaryChain.summaries).toEqual(["seed summary"]);
    });
  });

  describe("below checkpoint threshold", () => {
    it("appends messages to active buffer without triggering checkpoint", async () => {
      const manager = createManager();

      // Add a small message (well below 70% of 4000 chars = 2800 chars).
      await manager.onMessage(makeMessage(1, 100));

      const snap = manager.snapshot();
      expect(snap.hasBackBuffer).toBe(false);
      expect(snap.activeBuffer.messages).toHaveLength(1);
      expect(snap.checkpointInFlight).toBe(false);
    });

    it("returns active messages without summary prefix when no summary exists", async () => {
      const manager = createManager();
      await manager.onMessage(makeMessage(1, 100));

      const messages = manager.getActiveMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].timestamp).toBe(1);
    });

    it("returns active messages with summary prefix when summary exists", async () => {
      const manager = createManager({ initialSummary: "prior context" });
      await manager.onMessage(makeMessage(1, 100));

      const messages = manager.getActiveMessages();
      expect(messages).toHaveLength(2);
      // First message is the summary (a UserMessage with string content).
      const summaryMsg = messages[0];
      expect(summaryMsg.role).toBe("user");
      if (summaryMsg.role === "user") {
        expect(typeof summaryMsg.content).toBe("string");
        expect(summaryMsg.content as string).toContain("prior context");
        expect(summaryMsg.content as string).toContain("<context-summary");
      }
      // Second is the actual message.
      expect(messages[1].timestamp).toBe(1);
    });
  });

  describe("checkpoint trigger", () => {
    it("creates back buffer when usage crosses checkpoint threshold", async () => {
      const deps = makeSummarizeDep();
      const manager = createManager({ deps });

      // Push usage above 70%: 2900 chars > 2800 char threshold.
      await manager.onMessage(makeMessage(1, 2900));

      const snap = manager.snapshot();
      expect(snap.hasBackBuffer).toBe(true);
      expect(snap.backBuffer).not.toBeNull();
      expect(snap.checkpointInFlight).toBe(true);
      expect(deps.summarize).toHaveBeenCalledTimes(1);
    });

    it("starts background summarization non-blocking (agent keeps working)", async () => {
      const { deps, resolve } = makeBlockingSummarizeDep();
      const manager = createManager({ deps });

      // Trigger checkpoint.
      await manager.onMessage(makeMessage(1, 2900));

      // Agent can keep sending messages while summarization runs.
      const snap = manager.snapshot();
      expect(snap.hasBackBuffer).toBe(true);
      expect(snap.checkpointInFlight).toBe(true);

      // Resolve the summarization.
      resolve();
      // Allow microtask to settle.
      await new Promise((r) => setTimeout(r, 10));

      const snapAfter = manager.snapshot();
      expect(snapAfter.backBuffer?.summary).toBe("blocking summary");
    });
  });

  describe("concurrent phase — dual buffering", () => {
    it("mirrors new messages to both active and back buffers", async () => {
      const { deps, resolve } = makeBlockingSummarizeDep();
      const manager = createManager({ deps });

      // Trigger checkpoint.
      await manager.onMessage(makeMessage(1, 2900));
      expect(manager.snapshot().hasBackBuffer).toBe(true);

      // Add more messages in concurrent phase.
      await manager.onMessage(makeMessage(2, 100));
      await manager.onMessage(makeMessage(3, 100));

      const snap = manager.snapshot();
      // Active buffer: original + 2 concurrent = 3 messages.
      expect(snap.activeBuffer.messages).toHaveLength(3);
      // Back buffer: only 2 concurrent messages (checkpoint snapshot excluded).
      expect(snap.backBuffer?.messages).toHaveLength(2);

      resolve();
      await new Promise((r) => setTimeout(r, 10));
    });
  });

  describe("swap", () => {
    it("swaps to back buffer when usage crosses swap threshold", async () => {
      const deps = makeSummarizeDep("checkpoint summary");
      const manager = createManager({ deps });

      // Trigger checkpoint.
      await manager.onMessage(makeMessage(1, 2900));
      // Let the fast summarize resolve.
      await new Promise((r) => setTimeout(r, 10));

      // Push above swap threshold: 2900 + 1000 = 3900 > 3800 chars.
      const messages = await manager.onMessage(makeMessage(2, 1000));

      const snap = manager.snapshot();
      expect(snap.hasBackBuffer).toBe(false);
      // Back buffer should be null after swap.
      expect(snap.backBuffer).toBeNull();
      // Active buffer now has the back buffer's messages (concurrent ones only).
      // The back buffer was seeded with messages 2 only (message 1 was summarized).
      // Plus the summary prefix message.
      expect(messages.length).toBeGreaterThan(0);
      expect(snap.activeBuffer.summary).toBe("checkpoint summary");
    });

    it("blocks on checkpoint if summary is not ready at swap time", async () => {
      const { deps, resolve } = makeBlockingSummarizeDep("late summary");
      const manager = createManager({ deps });

      // Trigger checkpoint.
      await manager.onMessage(makeMessage(1, 2900));

      // Start the swap (summarize hasn't resolved yet).
      const swapPromise = manager.onMessage(makeMessage(2, 1000));

      // The swap should be blocked, waiting on the checkpoint.
      // Resolve the checkpoint to unblock.
      resolve();

      const messages = await swapPromise;

      const snap = manager.snapshot();
      expect(snap.hasBackBuffer).toBe(false);
      expect(snap.activeBuffer.summary).toBe("late summary");
      expect(messages.length).toBeGreaterThan(0);
    });

    it("handles checkpoint failure gracefully during swap", async () => {
      const { deps, reject } = makeBlockingSummarizeDep();
      const manager = createManager({ deps });

      // Trigger checkpoint.
      await manager.onMessage(makeMessage(1, 2900));

      // Start the swap.
      const swapPromise = manager.onMessage(makeMessage(2, 1000));

      // Fail the checkpoint.
      reject(new Error("API rate limit"));

      const messages = await swapPromise;

      const snap = manager.snapshot();
      // Should recover gracefully and return to idle.
      expect(snap.hasBackBuffer).toBe(false);
      // Messages should still be returned (no throw).
      expect(messages.length).toBeGreaterThan(0);
    });

    it("returns to idle after swap so next checkpoint can trigger", async () => {
      const deps = makeSummarizeDep("first summary");
      const manager = createManager({ deps });

      // First cycle: checkpoint -> swap.
      await manager.onMessage(makeMessage(1, 2900));
      await new Promise((r) => setTimeout(r, 10));
      await manager.onMessage(makeMessage(2, 1000));

      expect(manager.snapshot().hasBackBuffer).toBe(false);

      // After swap, adding more messages below threshold should stay idle.
      await manager.onMessage(makeMessage(3, 100));
      expect(manager.snapshot().hasBackBuffer).toBe(false);
    });
  });

  describe("summary accumulation and meta-summarization", () => {
    it("accumulates summaries across generations", async () => {
      const callCount = { n: 0 };
      const deps: BufferManagerDeps = {
        summarize: vi.fn().mockImplementation(() => {
          callCount.n += 1;
          return Promise.resolve(`summary-gen-${callCount.n}`);
        }),
      };
      const manager = createManager({ deps, settings: { maxGenerations: 5 } });

      // Run two checkpoint+swap cycles.
      for (let cycle = 0; cycle < 2; cycle++) {
        // Trigger checkpoint.
        await manager.onMessage(makeMessage(cycle * 10 + 1, 2900));
        await new Promise((r) => setTimeout(r, 10));
        // Trigger swap.
        await manager.onMessage(makeMessage(cycle * 10 + 2, 1000));
      }

      const snap = manager.snapshot();
      expect(snap.summaryChain.generation).toBe(2);
      expect(snap.summaryChain.summaries).toHaveLength(2);
    });

    it("meta-summarizes when maxGenerations is reached", async () => {
      const callCount = { n: 0 };
      const deps: BufferManagerDeps = {
        summarize: vi.fn().mockImplementation(() => {
          callCount.n += 1;
          return Promise.resolve(`summary-${callCount.n}`);
        }),
      };
      const manager = createManager({
        deps,
        settings: { maxGenerations: 2 },
      });

      // Run enough cycles to trigger meta-summarization.
      // Generation 1: first checkpoint+swap.
      await manager.onMessage(makeMessage(1, 2900));
      await new Promise((r) => setTimeout(r, 10));
      await manager.onMessage(makeMessage(2, 1000));

      // Generation 2: second checkpoint+swap -> triggers meta-summarize.
      await manager.onMessage(makeMessage(3, 2900));
      await new Promise((r) => setTimeout(r, 10));
      await manager.onMessage(makeMessage(4, 1000));

      const snap = manager.snapshot();
      // After meta-summarization, chain should be reset to generation 1.
      expect(snap.summaryChain.generation).toBe(1);
      expect(snap.summaryChain.summaries).toHaveLength(1);
    });
  });

  describe("cancel", () => {
    it("aborts in-flight checkpoint and discards back buffer", async () => {
      const { deps } = makeBlockingSummarizeDep();
      const manager = createManager({ deps });

      await manager.onMessage(makeMessage(1, 2900));
      expect(manager.snapshot().hasBackBuffer).toBe(true);

      manager.cancel();

      const snap = manager.snapshot();
      expect(snap.hasBackBuffer).toBe(false);
      expect(snap.backBuffer).toBeNull();
      expect(snap.checkpointInFlight).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles zero-length context window gracefully", () => {
      const manager = new BufferManager({
        settings: makeSettings(),
        contextWindowTokens: 0,
        deps: makeSummarizeDep(),
      });
      // contextWindowTokens is clamped to 1; shouldn't crash.
      const snap = manager.snapshot();
      expect(snap.hasBackBuffer).toBe(false);
    });

    it("does not double-trigger checkpoint if back buffer already exists", async () => {
      const deps = makeSummarizeDep();
      const manager = createManager({ deps });

      await manager.onMessage(makeMessage(1, 2900));
      await manager.onMessage(makeMessage(2, 100));

      // summarize should only be called once despite two messages above threshold.
      expect(deps.summarize).toHaveBeenCalledTimes(1);
    });

    it("handles summarize returning empty string", async () => {
      const deps = makeSummarizeDep("");
      const manager = createManager({ deps });

      await manager.onMessage(makeMessage(1, 2900));
      await new Promise((r) => setTimeout(r, 10));
      await manager.onMessage(makeMessage(2, 1000));

      const snap = manager.snapshot();
      expect(snap.hasBackBuffer).toBe(false);
      // Empty summary is treated as falsy: no summary prefix message.
      // (empty string is still stored but buildMessageList won't add it)
    });
  });
});

describe("computeEffectiveDoubleBufferSettings", () => {
  it("returns defaults for empty config", () => {
    const settings = computeEffectiveDoubleBufferSettings({});
    expect(settings).toEqual(DEFAULT_DOUBLE_BUFFER_SETTINGS);
  });

  it("returns null for non-object input", () => {
    expect(computeEffectiveDoubleBufferSettings(null)).toBeNull();
    expect(computeEffectiveDoubleBufferSettings(undefined)).toBeNull();
    expect(computeEffectiveDoubleBufferSettings("string")).toBeNull();
  });

  it("clamps checkpointThreshold to valid range", () => {
    const low = computeEffectiveDoubleBufferSettings({ checkpointThreshold: 0.01 });
    expect(low?.checkpointThreshold).toBe(0.1);

    const high = computeEffectiveDoubleBufferSettings({ checkpointThreshold: 0.99 });
    expect(high?.checkpointThreshold).toBe(0.95);
  });

  it("clamps swapThreshold to valid range", () => {
    // swapThreshold 0.1 is clamped to 0.5, but since default checkpoint is 0.7,
    // the "swap must exceed checkpoint" rule bumps it to 0.8.
    const low = computeEffectiveDoubleBufferSettings({ swapThreshold: 0.1 });
    expect(low?.swapThreshold).toBeGreaterThanOrEqual(0.5);
    expect(low?.swapThreshold).toBeGreaterThan(low!.checkpointThreshold);

    // With a low checkpoint, the clamped swap of 0.5 should survive.
    const withLowCheckpoint = computeEffectiveDoubleBufferSettings({
      checkpointThreshold: 0.2,
      swapThreshold: 0.1,
    });
    expect(withLowCheckpoint?.swapThreshold).toBe(0.5);
  });

  it("ensures swapThreshold > checkpointThreshold", () => {
    const settings = computeEffectiveDoubleBufferSettings({
      checkpointThreshold: 0.9,
      swapThreshold: 0.8,
    });
    // swap should be bumped above checkpoint.
    expect(settings).not.toBeNull();
    expect(settings!.swapThreshold).toBeGreaterThan(settings!.checkpointThreshold);
  });

  it("parses maxGenerations", () => {
    const settings = computeEffectiveDoubleBufferSettings({ maxGenerations: 5 });
    expect(settings?.maxGenerations).toBe(5);
  });

  it("floors maxGenerations to 1", () => {
    const settings = computeEffectiveDoubleBufferSettings({ maxGenerations: 0 });
    expect(settings?.maxGenerations).toBe(1);
  });

  it("parses customInstructions", () => {
    const settings = computeEffectiveDoubleBufferSettings({
      customInstructions: "  Focus on code changes.  ",
    });
    expect(settings?.customInstructions).toBe("Focus on code changes.");
  });

  it("ignores empty customInstructions", () => {
    const settings = computeEffectiveDoubleBufferSettings({ customInstructions: "   " });
    expect(settings?.customInstructions).toBeUndefined();
  });
});
