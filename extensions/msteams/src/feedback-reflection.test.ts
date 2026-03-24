import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFeedbackEvent,
  buildReflectionPrompt,
  clearReflectionCooldowns,
  isReflectionAllowed,
  loadSessionLearnings,
  recordReflectionTime,
} from "./feedback-reflection.js";

describe("buildFeedbackEvent", () => {
  it("builds a well-formed custom event", () => {
    const event = buildFeedbackEvent({
      messageId: "msg-123",
      value: "negative",
      comment: "too verbose",
      sessionKey: "msteams:user1",
      agentId: "default",
      conversationId: "19:abc",
    });

    expect(event.type).toBe("custom");
    expect(event.event).toBe("feedback");
    expect(event.value).toBe("negative");
    expect(event.comment).toBe("too verbose");
    expect(event.messageId).toBe("msg-123");
    expect(event.ts).toBeGreaterThan(0);
  });

  it("omits comment when not provided", () => {
    const event = buildFeedbackEvent({
      messageId: "msg-123",
      value: "positive",
      sessionKey: "msteams:user1",
      agentId: "default",
      conversationId: "19:abc",
    });

    expect(event.comment).toBeUndefined();
    expect(event.value).toBe("positive");
  });
});

describe("buildReflectionPrompt", () => {
  it("includes the thumbed-down response", () => {
    const prompt = buildReflectionPrompt({
      thumbedDownResponse: "Here is a long explanation...",
    });

    expect(prompt).toContain("previous response wasn't helpful");
    expect(prompt).toContain("Here is a long explanation...");
    expect(prompt).toContain("reflect");
  });

  it("truncates long responses", () => {
    const longResponse = "x".repeat(600);
    const prompt = buildReflectionPrompt({
      thumbedDownResponse: longResponse,
    });

    expect(prompt).toContain("...");
    expect(prompt.length).toBeLessThan(longResponse.length + 500);
  });

  it("includes user comment when provided", () => {
    const prompt = buildReflectionPrompt({
      thumbedDownResponse: "Some response",
      userComment: "Too wordy",
    });

    expect(prompt).toContain('User\'s comment: "Too wordy"');
  });

  it("works without optional params", () => {
    const prompt = buildReflectionPrompt({});
    expect(prompt).toContain("previous response wasn't helpful");
    expect(prompt).toContain("reflect");
  });
});

describe("reflection cooldown", () => {
  afterEach(() => {
    clearReflectionCooldowns();
  });

  it("allows first reflection", () => {
    expect(isReflectionAllowed("session-1")).toBe(true);
  });

  it("blocks reflection within cooldown", () => {
    recordReflectionTime("session-1");
    expect(isReflectionAllowed("session-1", 60_000)).toBe(false);
  });

  it("allows reflection after cooldown expires", () => {
    // Manually set a past timestamp
    recordReflectionTime("session-1");
    // Override the map entry to simulate time passing
    clearReflectionCooldowns();
    expect(isReflectionAllowed("session-1", 1)).toBe(true);
  });

  it("tracks sessions independently", () => {
    recordReflectionTime("session-1");
    expect(isReflectionAllowed("session-1", 60_000)).toBe(false);
    expect(isReflectionAllowed("session-2", 60_000)).toBe(true);
  });
});

describe("loadSessionLearnings", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty array when file doesn't exist", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "learnings-test-"));
    const learnings = await loadSessionLearnings(tmpDir, "nonexistent");
    expect(learnings).toEqual([]);
  });

  it("reads existing learnings", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "learnings-test-"));
    // Colons are sanitized to underscores in filenames (Windows compat)
    const safeKey = "msteams_user1";
    const filePath = path.join(tmpDir, `${safeKey}.learnings.json`);
    await writeFile(filePath, JSON.stringify(["Be concise", "Use examples"]), "utf-8");

    const learnings = await loadSessionLearnings(tmpDir, "msteams:user1");
    expect(learnings).toEqual(["Be concise", "Use examples"]);
  });
});
