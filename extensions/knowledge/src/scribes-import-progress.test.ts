/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { continuePrompt, scribeSetup, setupPrompt } from "./scribes-catalog.js";
import { buttonNamed, fixture } from "./scribes-view.test-support.js";

afterEach(() => document.body.replaceChildren());

const userText = (content: string) => ({ role: "user", content });
const statusLine = (state: string, summary: string) => ({
  role: "assistant",
  content: `Done.\nScribe status: ${state} — ${summary}`,
});
const label = "Scribe · Learn from Memory";
const sha = (n: number) => String(n).repeat(64);
const files = ["MEMORY.md", "memory/2026-11-01.md", "memory/2026-11-02.md"].map(
  (path, n) => `${path} ${sha(n + 1)}`,
);
const setup = scribeSetup(
  "memory",
  "once",
  { sources: ["memory-md", "daily-notes"], progress: true },
  "UTC",
);

it("continues a Memory import with saved progress until every file on its checkpoint has a receipt", async () => {
  const checkpoint = files.map((file) => `- ${file}`).join("\n");
  const receipts = files.slice(0, 2);
  const { render, ui, calls } = fixture({
    sessions: { [label]: { key: "s-mem", displayName: label, status: "interrupted" } },
    history: { "s-mem": [userText(setupPrompt(setup))] },
    checkpoint,
    receipts,
  });
  ui.s.scribe = "memory";
  // The start turn stopped partway: it continues in its conversation instead of starting over.
  const stopped = await render();
  expect(stopped.querySelector(".scribe-chip-warn")?.textContent).toBe("Needs attention");
  expect(stopped.textContent).toContain("2 of 3 files imported");
  buttonNamed(stopped, "Continue").click();
  await vi.waitFor(() => expect(calls.at(-1)?.[0]).toBe("chat.send"));
  expect(calls.at(-1)![1]).toEqual({
    sessionKey: "s-mem",
    agentId: "main",
    message: continuePrompt(),
    idempotencyKey: expect.stringMatching(/^knowledge:scribe:memory:s-mem:[0-9a-f-]{36}$/),
  });
  // A turn that says done while a file has no receipt is not done.
  const claimed = fixture({
    sessions: { [label]: { key: "s-mem", displayName: label } },
    history: {
      "s-mem": [
        userText(continuePrompt()),
        // Claude CLI can group several tool results in a user message without text.
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "[]" },
            { type: "tool_result", tool_use_id: "toolu_2", content: "[]" },
          ],
        },
        statusLine("done", "Saved 5 items from 3 files"),
      ],
    },
    checkpoint,
    receipts,
  });
  claimed.ui.s.scribe = "memory";
  const pending = await claimed.render();
  expect(pending.querySelector(".scribe-chip-warn")?.textContent).toBe("Needs attention");
  expect(buttonNamed(pending, "Continue")).toBeDefined();
  const finished = fixture({
    sessions: { [label]: { key: "s-mem", displayName: label } },
    history: {
      "s-mem": [userText(continuePrompt()), statusLine("done", "Saved 6 items from 3 files")],
    },
    checkpoint,
    receipts: files,
  });
  finished.ui.s.scribe = "memory";
  const done = await finished.render();
  expect(done.querySelector(".scribe-chip-on")?.textContent).toBe("Done");
  expect(done.textContent).toContain("3 of 3 files imported");
  expect(buttonNamed(done, "Continue")).toBeUndefined();
});

it("offers Continue when the start message has scrolled out of chat history", async () => {
  const { render, ui } = fixture({
    sessions: { [label]: { key: "s-mem", displayName: label, status: "interrupted" } },
    history: {
      "s-mem": [
        userText(setupPrompt(setup)),
        ...Array.from({ length: 101 }, () => ({ role: "toolResult", content: "Read daily note" })),
      ],
    },
    checkpoint: `- ${files[0]}\n- ${files[2]}`,
    receipts: [files[0]!],
  });
  ui.s.scribe = "memory";
  expect(buttonNamed(await render(), "Continue")).toBeDefined();
});

it("checks the later windows of a checkpoint before offering Continue or showing Done", async () => {
  const firstWindow = `- ${files[0]}\n- ${files[1]}\n- ${files[2]}`;
  const world = {
    sessions: { [label]: { key: "s-mem", displayName: label } },
    history: { "s-mem": [userText(continuePrompt()), statusLine("done", "Saved 5 items")] },
    checkpoint: `${firstWindow}\n- DREAMS.md ${sha(4)}`,
    checkpointWindow: firstWindow.length,
    receipts: files,
  };
  const { render, ui } = fixture(world);
  ui.s.scribe = "memory";
  const view = await render();
  expect(buttonNamed(view, "Continue")).toBeDefined();
  expect(view.textContent).toContain("3 of 4 files imported");

  // A file with nothing new to save has no receipt; its line says so.
  world.checkpoint = `${world.checkpoint} nothing new`;
  const done = await render();
  expect(done.textContent).toContain("4 of 4 files imported");
  expect(buttonNamed(done, "Continue")).toBeUndefined();
});

it("lets the user retry a checkpoint read before trusting a done result", async () => {
  const { render, ui, load, feature } = fixture({
    sessions: { [label]: { key: "s-mem", displayName: label } },
    history: { "s-mem": [userText(continuePrompt()), statusLine("done", "Saved 5 items")] },
    checkpoint: `- ${files[0]}\n- ${files[2]}`,
    receipts: [files[0]!],
  });
  ui.s.scribe = "memory";
  feature.invoke.mockRejectedValueOnce(new Error("Knowledge store unavailable"));
  const view = await render();
  expect(view.textContent).toContain("Couldn’t read saved progress");
  expect(view.querySelector(".scribe-chip-warn")?.textContent).toBe("Needs attention");
  buttonNamed(view, "Retry").click();
  expect(load).toHaveBeenCalledOnce();
  expect(buttonNamed(await render(), "Continue")).toBeDefined();
});
