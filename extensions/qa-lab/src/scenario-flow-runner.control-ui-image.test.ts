import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const transcriptCases = [
  ["text", "Control UI bridge check", "ui bridge armed", "hasReply"],
  ["image", "Image understanding check", "red blue", "hasColors"],
] as const;
const present = { panePresent: true, threadPresent: true, transcriptLoading: false };

function message(role: "user" | "assistant", text: string) {
  return `<div class="chat-group ${role}"><div class="chat-text">${text}</div></div>`;
}

function pane(contents: string, hidden = false, active = true) {
  return `<openclaw-chat-pane class="${active ? "chat-pane-cache__pane--active" : ""}" aria-hidden="${hidden}"><div class="chat-thread" role="log">${contents}</div></openclaw-chat-pane>`;
}

function runTranscriptStep(kind: "text" | "image", pages: string[]) {
  const scenarioId = "control-ui-qa-channel-image-roundtrip";
  const step = readQaScenarioById(scenarioId).execution.flow!.steps.find(
    (candidate) =>
      candidate.name === `${kind} injected through qa-channel renders in a fresh control ui load`,
  )!;
  let readCount = 0;
  const observations: unknown[] = [];
  const snapshots: Array<{ maxChars: number; text: string }> = [];
  const evaluationTimeouts: number[] = [];
  const readDocument = () => {
    const { document } = parseHTML(
      `<html><body>${pages[Math.min(readCount++, pages.length - 1)]}</body></html>`,
    );
    const activePane = document.querySelector(
      'openclaw-chat-pane.chat-pane-cache__pane--active[aria-hidden="false"]',
    );
    if (activePane) {
      Object.assign(activePane, { transcriptLoading: false });
    }
    return document;
  };
  const result = runLoadedScenarioFlow(scenarioId, {
    flow: { steps: [step] },
    api: {
      controlUiChatUrl: "http://127.0.0.1:43124/?session=qa",
      normalizeLowercaseStringOrEmpty,
      webOpenPage: async () => ({ pageId: "fresh-transcript" }),
      webWait: async () => ({ ok: true }),
      webEvaluate: async (params: { expression: string; timeoutMs: number }) => {
        // Execute the loaded browser expression against a DOM, not a selector-result stub.
        const observed: unknown = runInNewContext(params.expression, { document: readDocument() });
        observations.push(observed);
        evaluationTimeouts.push(params.timeoutMs);
        return observed;
      },
      webSnapshot: async ({ maxChars }: { maxChars: number }) => {
        const text = (readDocument().body.textContent ?? "").slice(0, maxChars);
        snapshots.push({ maxChars, text });
        return { text };
      },
    },
  });
  return { result, observations, snapshots, evaluationTimeouts };
}

describe.each(transcriptCases)("%s transcript", (kind, prompt, reply, replyFlag) => {
  const transcript = message("user", prompt) + message("assistant", reply);
  const run = (...pages: string[]) => runTranscriptStep(kind, pages);

  it.each([
    {
      name: "12K shell",
      pages: [`<nav>${"x".repeat(12_001)}</nav>${pane("", false, false)}${pane(transcript)}`],
      pending: [],
    },
    {
      name: "absent pane/thread",
      pages: [
        pane(transcript, true),
        '<openclaw-chat-pane class="chat-pane-cache__pane--active" aria-hidden="false"></openclaw-chat-pane>',
        pane(transcript),
      ],
      pending: [
        { panePresent: false, threadPresent: false },
        { panePresent: true, threadPresent: false },
      ],
    },
  ])("reads $name without exposing transcript text", async ({ pages, pending }) => {
    const proof = run(...pages);
    const result = await proof.result;
    expect(result.status).toBe("pass");
    expect(proof).toMatchObject({
      snapshots: [],
      evaluationTimeouts: Array(pending.length + 1).fill(30_000),
    });
    expect(proof.observations).toEqual([
      ...pending.map((state) => expect.objectContaining(state)),
      {
        ...present,
        userMessageCount: 1,
        assistantMessageCount: 1,
        hasPrompt: true,
        [replyFlag]: true,
      },
    ]);
    expect(result.steps.at(-1)?.details).toBe(JSON.stringify(proof.observations.at(-1)));
  });

  it.each(["menu decoy", "reversed roles"] as const)(
    "rejects %s with bounded diagnostics",
    async (missing) => {
      const pages = {
        "menu decoy": `<nav>${transcript}</nav>${pane(transcript, true)}${pane(transcript, false, false)}${pane("")}`,
        "reversed roles": pane(message("assistant", prompt) + message("user", reply)),
      };
      const proof = run(pages[missing]);

      await expect(proof.result).rejects.toThrow(
        `control ui ${kind} transcript missing after fresh load. state=`,
      );
      expect(proof.snapshots).toMatchObject([{ maxChars: 12_000 }]);
      expect(proof.snapshots[0]?.text.length).toBeLessThanOrEqual(12_000);
      expect(proof.observations.at(-1)).toMatchObject(present);
      expect(proof.evaluationTimeouts.at(-1)).toBe(15_000);
    },
  );
});
