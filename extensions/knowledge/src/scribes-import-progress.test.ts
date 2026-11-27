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

it("continues a Memory import with saved progress until every file on its checkpoint is done", async () => {
  const label = "Scribe · Learn from Memory";
  const setup = scribeSetup(
    "memory",
    "once",
    { sources: ["memory-md", "daily-notes"], progress: true },
    "UTC",
  );
  const checkpoint = [
    "- MEMORY.md: done (3 saved, 1 known, 0 skipped)",
    "- memory/2026-11-01.md: done (2 saved, 0 known, 1 skipped)",
    "- memory/2026-11-02.md: pending",
  ].join("\n");
  const { render, ui, calls } = fixture({
    sessions: { [label]: { key: "s-mem", displayName: label, status: "interrupted" } },
    history: { "s-mem": [userText(setupPrompt(setup))] },
    checkpoint,
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
  // A turn that says done while a file is still pending is not done.
  const claimed = fixture({
    sessions: { [label]: { key: "s-mem", displayName: label } },
    history: {
      "s-mem": [userText(continuePrompt()), statusLine("done", "Saved 5 items from 3 files")],
    },
    checkpoint,
  });
  claimed.ui.s.scribe = "memory";
  expect((await claimed.render()).querySelector(".scribe-chip-warn")?.textContent).toBe(
    "Needs attention",
  );
  const finished = fixture({
    sessions: { [label]: { key: "s-mem", displayName: label } },
    history: {
      "s-mem": [
        userText(continuePrompt()),
        // A Claude CLI turn records its tool results as user messages without text.
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "[]" }],
        },
        statusLine("done", "Saved 6 items from 3 files"),
      ],
    },
    checkpoint: checkpoint.replace("pending", "done (1 saved, 0 known, 0 skipped)"),
  });
  finished.ui.s.scribe = "memory";
  const done = await finished.render();
  expect(done.querySelector(".scribe-chip-on")?.textContent).toBe("Done");
  expect(done.textContent).toContain("3 of 3 files imported");
  expect(buttonNamed(done, "Continue")).toBeUndefined();
});
