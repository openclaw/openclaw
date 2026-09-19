import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const transcriptCases = [
  {
    kind: "text",
    prompt: "Control UI bridge check. Marker exact marker: `ui bridge armed`",
    reply: "ui bridge armed",
    replyFlag: "hasReply",
  },
  {
    kind: "image",
    prompt: "Image understanding check: describe the top and bottom colors.",
    reply: "The top is red and the bottom is blue.",
    replyFlag: "hasColors",
  },
] as const;

function message(role: "user" | "assistant", text: string) {
  return `<div class="chat-group ${role}"><div class="chat-text">${text}</div></div>`;
}

function pane(contents: string, hidden = false, active = true) {
  return `<openclaw-chat-pane class="${active ? "chat-pane-cache__pane--active" : ""}" aria-hidden="${hidden}"><div class="chat-thread" role="log">${contents}</div></openclaw-chat-pane>`;
}

function runTranscriptStep(kind: "text" | "image", pages: string[]) {
  const scenarioId = "control-ui-qa-channel-image-roundtrip";
  const scenario = readQaScenarioById(scenarioId);
  const step = scenario.execution.flow?.steps.find(
    (candidate) =>
      candidate.name === `${kind} injected through qa-channel renders in a fresh control ui load`,
  );
  if (!step) {
    throw new Error(`missing ${kind} transcript step`);
  }
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
    flow: {
      steps: [
        {
          name: "sets the selected session URL",
          actions: [{ set: "controlUiChatUrl", value: "http://127.0.0.1:43124/?session=qa" }],
        },
        step,
      ],
    },
    api: {
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

describe.each(transcriptCases)("loaded Control UI $kind transcript assertion", (testCase) => {
  const transcript = message("user", testCase.prompt) + message("assistant", testCase.reply);

  it("reads the active transcript beyond a 12K shell prefix without returning its text", async () => {
    const proof = runTranscriptStep(testCase.kind, [
      `<nav>${"x".repeat(12_001)}</nav>${pane(transcript)}`,
    ]);

    const result = await proof.result;

    expect(result.status).toBe("pass");
    expect(proof.snapshots).toEqual([]);
    expect(proof.observations).toEqual([
      {
        panePresent: true,
        threadPresent: true,
        transcriptLoading: false,
        userMessageCount: 1,
        assistantMessageCount: 1,
        hasPrompt: true,
        [testCase.replyFlag]: true,
      },
    ]);
    expect(result.steps.at(-1)?.details).toBe(JSON.stringify(proof.observations[0]));
    expect(result.steps.at(-1)?.details).not.toContain(testCase.prompt);
  });

  it.each([
    "missing prompt",
    "missing answer",
    "hidden pane",
    "menu decoy",
    "reversed roles",
    "prompt-only answer",
  ] as const)("rejects %s and keeps bounded, pane-owned failure diagnostics", async (missing) => {
    const pages = {
      "missing prompt": pane(message("assistant", testCase.reply)),
      "missing answer": pane(message("user", testCase.prompt)),
      "hidden pane": pane(transcript, true) + pane(""),
      "menu decoy": `<nav>${transcript}</nav>${pane("")}`,
      "reversed roles": pane(
        message("assistant", testCase.prompt) + message("user", testCase.reply),
      ),
      "prompt-only answer": pane(message("user", `${testCase.prompt} ${testCase.reply}`)),
    };
    const proof = runTranscriptStep(testCase.kind, [pages[missing]]);

    await expect(proof.result).rejects.toThrow(
      `control ui ${testCase.kind} transcript missing after fresh load. state=`,
    );
    expect(proof.snapshots).toHaveLength(1);
    expect(proof.snapshots[0]?.maxChars).toBe(12_000);
    expect(proof.snapshots[0]?.text.length).toBeLessThanOrEqual(12_000);
    expect(proof.observations.at(-1)).toMatchObject({
      panePresent: true,
      threadPresent: true,
      transcriptLoading: false,
    });
    expect(proof.evaluationTimeouts.at(-1)).toBe(15_000);
  });

  it.each([true, false])(
    "uses the active transcript, not an earlier presented pane (active has transcript: %s)",
    async (activeHasTranscript) => {
      const proof = runTranscriptStep(testCase.kind, [
        pane(activeHasTranscript ? "" : transcript, false, false) +
          pane(activeHasTranscript ? transcript : ""),
      ]);

      if (activeHasTranscript) {
        await expect(proof.result).resolves.toMatchObject({ status: "pass" });
        expect(proof.snapshots).toEqual([]);
      } else {
        await expect(proof.result).rejects.toThrow(
          `control ui ${testCase.kind} transcript missing after fresh load. state=`,
        );
      }
      expect(proof.observations.at(-1)).toMatchObject({
        hasPrompt: activeHasTranscript,
        [testCase.replyFlag]: activeHasTranscript,
      });
    },
  );

  it("keeps polling while the active pane or transcript is absent", async () => {
    const proof = runTranscriptStep(testCase.kind, [
      pane(transcript, true),
      '<openclaw-chat-pane class="chat-pane-cache__pane--active" aria-hidden="false"></openclaw-chat-pane>',
      pane(transcript),
    ]);

    await expect(proof.result).resolves.toMatchObject({ status: "pass" });
    expect(proof.observations).toHaveLength(3);
    expect(proof.observations[0]).toMatchObject({ panePresent: false, threadPresent: false });
    expect(proof.observations[1]).toMatchObject({ panePresent: true, threadPresent: false });
    expect(proof.observations[2]).toMatchObject({ hasPrompt: true, [testCase.replyFlag]: true });
    expect(proof.evaluationTimeouts).toEqual([30_000, 30_000, 30_000]);
    expect(proof.snapshots).toEqual([]);
  });
});

it.each(["red", "blue"])("requires both image color groups, not only %s", async (color) => {
  const proof = runTranscriptStep("image", [
    pane(
      message("user", transcriptCases[1].prompt) + message("assistant", `The image is ${color}.`),
    ),
  ]);

  await expect(proof.result).rejects.toThrow(
    "control ui image transcript missing after fresh load",
  );
  expect(proof.observations.at(-1)).toMatchObject({ hasPrompt: true, hasColors: false });
});
