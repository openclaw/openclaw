import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addActionQueueItem,
  listActionQueueItems,
  resetActionQueueStoreForTest,
  updateActionQueueItem,
} from "./action-queue.js";

describe("action queue store", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-action-queue-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    resetActionQueueStoreForTest();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetActionQueueStoreForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("adds open items with normalized defaults and newest-first listing", async () => {
    const first = await addActionQueueItem({
      title: "  Draft BlueBubbles reply  ",
      caption: "Summarize the news article before sending.",
      source: "notion",
      kind: "draft",
      priority: "high",
      nowMs: 1_000,
    });
    const second = await addActionQueueItem({
      title: "Teach Thomas image generation",
      source: "canvas",
      kind: "idea",
      nowMs: 2_000,
    });

    expect(first).toMatchObject({
      title: "Draft BlueBubbles reply",
      caption: "Summarize the news article before sending.",
      source: "notion",
      kind: "draft",
      priority: "high",
      status: "open",
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
    });

    const listed = await listActionQueueItems({ status: "open", limit: 10 });
    expect(listed.items.map((item) => item.id)).toEqual([second.id, first.id]);
    expect(listed.items[0]).toMatchObject({
      title: "Teach Thomas image generation",
      source: "canvas",
      kind: "idea",
      priority: "normal",
    });
  });

  it("updates item status and hides resolved items from the default list", async () => {
    const item = await addActionQueueItem({
      title: "Review failed cron run",
      source: "cron",
      kind: "fix",
      priority: "urgent",
      nowMs: 5_000,
    });

    const updated = await updateActionQueueItem({
      id: item.id,
      patch: { status: "done", caption: "Handled from Canvas." },
      nowMs: 9_000,
    });

    expect(updated).toMatchObject({
      id: item.id,
      status: "done",
      caption: "Handled from Canvas.",
      updatedAtMs: 9_000,
    });
    await expect(listActionQueueItems({ status: "open" })).resolves.toMatchObject({ items: [] });
    await expect(listActionQueueItems({ status: "all" })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: item.id, status: "done" })],
    });
  });

  it("clears optional fields without returning undefined properties", async () => {
    const item = await addActionQueueItem({
      title: "Review draft",
      caption: "Needs approval.",
      actionLabel: "Open",
      dueAtMs: 12_345,
      payload: { draftId: "draft-1" },
      nowMs: 1_000,
    });

    const updated = await updateActionQueueItem({
      id: item.id,
      patch: { caption: "", actionLabel: "", dueAtMs: null as never, payload: null as never },
      nowMs: 2_000,
    });

    expect(updated).not.toHaveProperty("caption");
    expect(updated).not.toHaveProperty("actionLabel");
    expect(updated).not.toHaveProperty("dueAtMs");
    expect(updated).not.toHaveProperty("payload");
  });

  it("rejects empty titles and unknown item ids", async () => {
    await expect(addActionQueueItem({ title: "   " })).rejects.toThrow("title is required");
    await expect(
      updateActionQueueItem({ id: "missing", patch: { status: "done" } }),
    ).rejects.toThrow("action queue item not found");
  });
});
