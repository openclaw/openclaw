import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { isJsonObject, type JsonObject } from "./protocol.js";
import {
  assistantMessage,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  userMessage,
} from "./run-attempt-test-harness.js";
import {
  createContextEngine,
  createParams,
  createStartedThreadHarness,
  getRequestInputText,
  makeThreadBootstrapBinding,
  runCodexAppServerAttempt,
  writeCodexAppServerBinding,
} from "./run-attempt.context-engine.test-support.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";
import { CODEX_HISTORY_FRAGMENT_PREFIX, CODEX_HISTORY_FRAGMENT_SUFFIX } from "./user-input.js";

setupRunAttemptTestHooks();

const ANCHOR = "FULL_HISTORY_SEED_PREFIX";
const historyText = `${ANCHOR} $historical [@historical](plugin://history)\n${"h".repeat(1_100_000)}\né漢字\nFULL_HISTORY_SEED_TAIL`;
const historicalImage = {
  type: "image" as const,
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
};

function seedParams(mode: "thread_bootstrap" | "per_turn") {
  const sessionFile = path.join(tempDir, "history-seed.jsonl");
  const params = createParams(sessionFile, path.join(tempDir, "workspace"));
  params.authoredContextTokenCap = 600_000;
  params.contextTokenBudget = 500_000;
  params.prompt = "CURRENT_REQUEST $current";
  params.currentInboundContext = { text: "CURRENT_INBOUND_REFERENCE" };
  const savedImageMessage = {
    ...userMessage("IMAGE_MESSAGE_CAPTION", 3),
    __openclaw: { senderId: "speaker-b", senderName: "Speaker B" },
  };
  const attributedHistoryMessage = {
    ...userMessage(historyText, 1),
    __openclaw: { senderId: "speaker-a", senderName: "Speaker A" },
  };
  const messages: AgentMessage[] = [
    attributedHistoryMessage,
    assistantMessage("ASSISTANT_BETWEEN_MESSAGES", 2),
    savedImageMessage,
    assistantMessage("ASSISTANT_AFTER_IMAGE", 4),
  ];
  params.hostCapabilities = Object.freeze({
    ...params.hostCapabilities,
    prepareContextMedia: async ({
      message,
    }: Parameters<NonNullable<typeof params.hostCapabilities.prepareContextMedia>>[0]) => ({
      images: message === savedImageMessage ? [historicalImage] : [],
    }),
  });
  const assemble = vi.fn(
    async (_input: Parameters<ReturnType<typeof createContextEngine>["assemble"]>[0]) => ({
      messages,
      estimatedTokens: 350_000,
      ...(mode === "thread_bootstrap"
        ? { contextProjection: { mode: "thread_bootstrap" as const, epoch: "seed-epoch-1" } }
        : {}),
    }),
  );
  params.contextEngine = createContextEngine({ assemble });
  return { params, assemble, messages };
}

function historySeedRequests(harness: ReturnType<typeof createStartedThreadHarness>) {
  return harness.requests.filter(
    ({ method, params }) =>
      method === "thread/inject_items" && JSON.stringify(params).includes(ANCHOR),
  );
}

describe("Codex configured assembled-history delivery", () => {
  it("seeds complete history from the existing authored cap without a caller budget", async () => {
    const { params, assemble } = seedParams("per_turn");
    delete params.contextTokenBudget;
    delete params.contextWindowInfo;
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await run.waitForTurnAccepted();
    await harness.completeTurn();
    await run;

    const seeds = historySeedRequests(harness);
    expect(seeds).toHaveLength(1);
    const seedText = JSON.stringify(seeds[0]?.params);
    expect(seedText.length).toBeGreaterThan(1 << 20);
    expect(seedText).toContain("FULL_HISTORY_SEED_TAIL");
    expect(seedText).not.toContain(params.prompt);
    expect(getRequestInputText(harness)).toContain(params.prompt);
    expect(getRequestInputText(harness)).not.toContain(ANCHOR);
    expect(
      harness.requests.findIndex(({ method }) => method === "thread/inject_items"),
    ).toBeLessThan(harness.requests.findIndex(({ method }) => method === "turn/start"));
    const assembled = assemble.mock.calls[0]?.[0];
    expect(assembled?.tokenBudget).toBeGreaterThan(0);
    expect(assembled?.tokenBudget).toBeLessThan(580_000);
    expect(assembled?.runtimeSettings?.limits.promptTokenBudget).toBe(assembled?.tokenBudget);
    const binding = await readCodexAppServerBinding(params.sessionFile);
    expect(JSON.parse(binding?.contextEngine?.policyFingerprint ?? "null")).toMatchObject({
      contextTokenBudget: 600_000,
      historyCarrier: "thread/inject_items",
      modelProvider: params.provider,
      model: params.modelId,
    });
  });

  it("replaces a same-epoch legacy binding when only the existing authored cap selects history delivery", async () => {
    const { params } = seedParams("thread_bootstrap");
    delete params.contextTokenBudget;
    delete params.contextWindowInfo;
    await writeCodexAppServerBinding(
      params.sessionFile,
      makeThreadBootstrapBinding({
        threadId: "thread-legacy",
        cwd: params.workspaceDir,
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
        epoch: "seed-epoch-1",
      }),
    );
    const harness = createStartedThreadHarness(
      async (method, request) => {
        if (method === "thread/start") {
          return threadStartResult("thread-migrated");
        }
        if (method === "thread/resume" && isJsonObject(request)) {
          if (typeof request.threadId !== "string") {
            throw new Error("Expected a native thread id in the resume request");
          }
          return threadStartResult(request.threadId);
        }
        return undefined;
      },
      {
        persistedThreads: [threadStartResult("thread-legacy", { cwd: params.workspaceDir })],
      },
    );
    const run = runCodexAppServerAttempt(params);
    await run.waitForTurnAccepted();
    const acceptedTurn = harness.requests.findLast(({ method }) => method === "turn/start")?.params;
    if (!isJsonObject(acceptedTurn) || typeof acceptedTurn.threadId !== "string") {
      throw new Error("Expected a native thread id in the accepted turn request");
    }
    await harness.completeTurn("completed", acceptedTurn.threadId);
    await run;

    expect(historySeedRequests(harness)).toHaveLength(1);
    expect(harness.requests.some(({ method }) => method === "thread/resume")).toBe(false);
    expect((await readCodexAppServerBinding(params.sessionFile))?.threadId).toBe("thread-migrated");
  });

  it("replaces a same-epoch seeded thread when the authored cap changes without a caller budget", async () => {
    const { params, assemble } = seedParams("thread_bootstrap");
    delete params.contextTokenBudget;
    delete params.contextWindowInfo;
    let starts = 0;
    const harness = createStartedThreadHarness(
      async (method, request) => {
        if (method === "thread/start") {
          return threadStartResult(`thread-cap-${++starts}`);
        }
        if (method === "thread/resume" && isJsonObject(request)) {
          if (typeof request.threadId !== "string") {
            throw new Error("Expected a native thread id in the resume request");
          }
          return threadStartResult(request.threadId);
        }
        return undefined;
      },
      { persistedThreads: [] },
    );
    const completeAcceptedTurn = async () => {
      const acceptedTurn = harness.requests.findLast(
        ({ method }) => method === "turn/start",
      )?.params;
      if (!isJsonObject(acceptedTurn) || typeof acceptedTurn.threadId !== "string") {
        throw new Error("Expected a native thread id in the accepted turn request");
      }
      await harness.completeTurn("completed", acceptedTurn.threadId);
    };
    const first = runCodexAppServerAttempt(params);
    await first.waitForTurnAccepted();
    await completeAcceptedTurn();
    await first;
    const previous = await readCodexAppServerBinding(params.sessionFile);

    const second = runCodexAppServerAttempt({
      ...params,
      authoredContextTokenCap: 500_000,
      runId: "authored-cap-change",
    });
    await second.waitForTurnAccepted();
    await completeAcceptedTurn();
    await second;

    expect(starts).toBe(2);
    expect(historySeedRequests(harness)).toHaveLength(2);
    expect(harness.requests.some(({ method }) => method === "thread/resume")).toBe(false);
    expect(assemble.mock.calls[1]?.[0].tokenBudget).toBeLessThan(
      assemble.mock.calls[0]?.[0].tokenBudget ?? 0,
    );
    const current = await readCodexAppServerBinding(params.sessionFile);
    expect(current?.contextEngine?.policyFingerprint).not.toBe(
      previous?.contextEngine?.policyFingerprint,
    );
    expect(current?.contextEngine?.projection?.epoch).toBe("seed-epoch-1");
  });

  it.each(["thread_bootstrap", "per_turn"] as const)(
    "installs all >1,048,576 characters of the %s seed before publishing ready, separate from current input",
    async (mode) => {
      const { params, assemble } = seedParams(mode);
      const seedEntered = createDeferred<void>();
      const acknowledgeSeed = createDeferred<void>();
      const harness = createStartedThreadHarness(async (method, request) => {
        if (method === "thread/inject_items" && JSON.stringify(request).includes(ANCHOR)) {
          seedEntered.resolve();
          await acknowledgeSeed.promise;
          return {};
        }
        return undefined;
      });
      const run = runCodexAppServerAttempt(params);
      try {
        // The original defect reaches turn/start without a seed; fail on that
        // production boundary rather than waiting for a nonexistent fixture RPC.
        await Promise.race([seedEntered.promise, harness.waitForMethod("turn/start")]);
        expect(historySeedRequests(harness)).toHaveLength(1);
        expect(harness.requests.some(({ method }) => method === "turn/start")).toBe(false);
        expect(await readCodexAppServerBinding(params.sessionFile)).toBeUndefined();
        acknowledgeSeed.resolve();
        await run.waitForTurnAccepted();

        const seed = historySeedRequests(harness)[0]!.params as JsonObject;
        expect(seed.threadId).toBe("thread-1");
        const items = seed.items;
        expect(Array.isArray(items)).toBe(true);
        const historyItems = Array.isArray(items) ? items : [];
        expect(historyItems.length).toBeGreaterThan(1);
        const content = historyItems.flatMap((item) => {
          expect(item).toMatchObject({ type: "message", role: "user" });
          const parts = isJsonObject(item) && Array.isArray(item.content) ? item.content : [];
          const itemText = parts
            .flatMap((part) =>
              isJsonObject(part) && typeof part.text === "string" ? [part.text] : [],
            )
            .join("");
          expect(Buffer.byteLength(itemText, "utf8")).toBeLessThanOrEqual(8 * 1_024);
          return parts;
        });
        const stripFragmentFrame = (part: unknown) => {
          if (!isJsonObject(part) || typeof part.text !== "string") {
            return "";
          }
          const text = part.text.startsWith(CODEX_HISTORY_FRAGMENT_PREFIX)
            ? part.text.slice(CODEX_HISTORY_FRAGMENT_PREFIX.length)
            : part.text;
          return text.endsWith(CODEX_HISTORY_FRAGMENT_SUFFIX)
            ? text.slice(0, -CODEX_HISTORY_FRAGMENT_SUFFIX.length)
            : text;
        };
        const text = content.map(stripFragmentFrame).join("");
        expect(text.length).toBeGreaterThan(1 << 20);
        expect(text).toContain(
          historyText
            .replace("$historical", "＄historical")
            .replace("[@historical]", "[＠historical]"),
        );
        expect(text).toContain('[user sender={"id":"speaker-a","name":"Speaker A"}]');
        expect(text).toContain('[user sender={"id":"speaker-b","name":"Speaker B"}]');
        expect(text).not.toContain("truncated");
        expect(text).not.toContain(params.prompt);
        const imageIndex = content.findIndex(
          (part) => isJsonObject(part) && part.type === "input_image",
        );
        expect(content.filter((part) => isJsonObject(part) && part.type === "input_image")).toEqual(
          [{ type: "input_image", image_url: `data:image/png;base64,${historicalImage.data}` }],
        );
        expect(content.slice(0, imageIndex).map(stripFragmentFrame).join("")).toContain(
          "IMAGE_MESSAGE_CAPTION",
        );
        expect(
          content
            .slice(imageIndex + 1)
            .map(stripFragmentFrame)
            .join(""),
        ).toContain("ASSISTANT_AFTER_IMAGE");
        const current = getRequestInputText(harness);
        expect(current).toContain(params.prompt);
        expect(current).toContain("CURRENT_INBOUND_REFERENCE");
        expect(current).not.toContain(ANCHOR);
        const assembled = assemble.mock.calls[0]?.[0];
        expect(assembled).toMatchObject({ tokenBudget: expect.any(Number) });
        expect(assembled?.tokenBudget).toBeLessThan(480_000);
        const binding = await readCodexAppServerBinding(params.sessionFile);
        expect(binding?.threadId).toBe("thread-1");
        if (mode === "thread_bootstrap") {
          expect(binding?.contextEngine?.projection?.epoch).toBe("seed-epoch-1");
        } else {
          expect(binding?.contextEngine?.projection?.epoch).toEqual(expect.any(String));
        }
      } finally {
        acknowledgeSeed.resolve();
        await run.waitForTurnAccepted();
        await harness.completeTurn();
        await run;
      }
    },
  );

  it("discards an uncertain seed and retries on a different fresh thread without advancing its epoch", async () => {
    const { params } = seedParams("thread_bootstrap");
    let starts = 0;
    let loseAcknowledgment = true;
    const acceptedSeeds: string[] = [];
    const respond = async (method: string, request: unknown) => {
      if (method === "thread/start") {
        return threadStartResult(`thread-seed-${++starts}`);
      }
      if (method === "thread/delete") {
        return {};
      }
      if (
        method === "thread/inject_items" &&
        isJsonObject(request) &&
        JSON.stringify(request).includes(ANCHOR)
      ) {
        if (typeof request.threadId !== "string") {
          throw new Error("Expected a native thread id in the history seed request");
        }
        acceptedSeeds.push(request.threadId);
        if (loseAcknowledgment) {
          throw new Error("Synthetic lost seed acknowledgment");
        }
        return {};
      }
      return undefined;
    };
    const harness = createStartedThreadHarness(respond);
    await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
      "Synthetic lost seed acknowledgment",
    );
    expect(acceptedSeeds).toEqual(["thread-seed-1"]);
    expect(await readCodexAppServerBinding(params.sessionFile)).toBeUndefined();
    expect(harness.requests).toContainEqual({
      method: "thread/delete",
      params: { threadId: "thread-seed-1" },
    });
    expect(harness.requests.some(({ method }) => method === "turn/start")).toBe(false);
    loseAcknowledgment = false;
    // Failed startup retires its client; recovery must acquire a fresh transport.
    const retryHarness = createStartedThreadHarness(respond);
    const retry = runCodexAppServerAttempt({ ...params, runId: "run-seed-retry" });
    // Recording dispatch precedes installing the terminal notification projector.
    await retry.waitForTurnAccepted();
    expect(acceptedSeeds).toEqual(["thread-seed-1", "thread-seed-2"]);
    await retryHarness.completeTurn("completed", "thread-seed-2");
    await retry;
    expect((await readCodexAppServerBinding(params.sessionFile))?.threadId).toBe("thread-seed-2");
  });

  it("declines a native model mismatch before injecting the requested model's history", async () => {
    const { params } = seedParams("thread_bootstrap");
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        return { ...threadStartResult(), model: "smaller-native-model" };
      }
      return method === "thread/delete" ? {} : undefined;
    });
    await expect(runCodexAppServerAttempt(params)).rejects.toThrow("different model");
    expect(historySeedRequests(harness)).toEqual([]);
    expect(await readCodexAppServerBinding(params.sessionFile)).toBeUndefined();
    expect(harness.requests.some(({ method }) => method === "turn/start")).toBe(false);
  });

  it("reuses an acknowledged bootstrap and rotates only when its projection epoch changes", async () => {
    const { params, assemble } = seedParams("thread_bootstrap");
    let starts = 0;
    const harness = createStartedThreadHarness(async (method, request) => {
      if (method === "thread/start") {
        return threadStartResult(`thread-epoch-${++starts}`);
      }
      if (method === "thread/resume" && isJsonObject(request)) {
        if (typeof request.threadId !== "string") {
          throw new Error("Expected a native thread id in the resume request");
        }
        return threadStartResult(request.threadId);
      }
      return undefined;
    });
    const runTurn = async (runId: string, threadId: string) => {
      const run = runCodexAppServerAttempt({ ...params, runId });
      await run.waitForTurnAccepted();
      await harness.completeTurn("completed", threadId);
      await run;
    };
    await runTurn("epoch-first", "thread-epoch-1");
    expect(historySeedRequests(harness)).toHaveLength(1);
    await runTurn("epoch-reuse", "thread-epoch-1");
    expect(starts).toBe(1);
    expect(historySeedRequests(harness)).toHaveLength(1);
    const previous = await assemble.mock.results[0]!.value;
    assemble.mockResolvedValue({
      ...previous,
      contextProjection: { mode: "thread_bootstrap", epoch: "seed-epoch-2" },
    });
    await runTurn("epoch-change", "thread-epoch-2");
    expect(starts).toBe(2);
    expect(historySeedRequests(harness)).toHaveLength(2);
    expect(
      (await readCodexAppServerBinding(params.sessionFile))?.contextEngine?.projection?.epoch,
    ).toBe("seed-epoch-2");
  });

  it("also seeds small configured per-turn projections on a fresh checked native thread", async () => {
    const { params } = seedParams("per_turn");
    params.contextEngine = createContextEngine({
      assemble: async () => ({ messages: [userMessage("SMALL_HISTORY", 1)], estimatedTokens: 10 }),
    });
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await run.waitForTurnAccepted();
    expect(getRequestInputText(harness)).not.toContain("SMALL_HISTORY");
    expect(historySeedRequests(harness)).toEqual([]);
    const seed = harness.requests.find(
      ({ method, params: request }) =>
        method === "thread/inject_items" && JSON.stringify(request).includes("SMALL_HISTORY"),
    );
    expect(seed).toBeDefined();
    expect(
      harness.requests.findIndex(({ method }) => method === "thread/inject_items"),
    ).toBeLessThan(harness.requests.findIndex(({ method }) => method === "turn/start"));
    await harness.completeTurn();
    await run;
  });

  it("rotates when a previously nonempty selection is rewritten to empty", async () => {
    const { params } = seedParams("per_turn");
    let starts = 0;
    const harness = createStartedThreadHarness(
      async (method) => {
        if (method === "thread/start") {
          return threadStartResult(`thread-empty-${++starts}`);
        }
        return undefined;
      },
      { persistedThreads: [] },
    );
    const first = runCodexAppServerAttempt(params);
    await first.waitForTurnAccepted();
    await harness.completeTurn("completed", "thread-empty-1");
    await first;
    expect(historySeedRequests(harness)).toHaveLength(1);
    params.contextEngine = createContextEngine({
      assemble: async () => ({ messages: [], estimatedTokens: 0 }),
    });
    const offset = harness.requests.length;
    const empty = runCodexAppServerAttempt({ ...params, runId: "empty-projection" });
    await empty.waitForTurnAccepted();
    expect(starts).toBe(2);
    const requests = harness.requests.slice(offset);
    expect(requests.some(({ method }) => method === "thread/inject_items")).toBe(false);
    expect(requests.some(({ method }) => method === "thread/resume")).toBe(false);
    const turn = requests.find(({ method }) => method === "turn/start");
    expect(turn?.params).toMatchObject({ threadId: "thread-empty-2" });
    expect(JSON.stringify(turn?.params)).toContain(params.prompt);
    expect(JSON.stringify(turn?.params)).not.toContain(ANCHOR);
    await harness.completeTurn("completed", "thread-empty-2");
    await empty;
    expect((await readCodexAppServerBinding(params.sessionFile))?.threadId).toBe("thread-empty-2");
  });

  it.each(["thread_bootstrap", "per_turn"] as const)(
    "injects only append-only suffixes once per %s native epoch and rotates rewritten history",
    async (mode) => {
      const { params, assemble } = seedParams(mode);
      const initial = {
        messages: [userMessage("ORIGINAL_SELECTED_HISTORY", 1)],
        estimatedTokens: 20,
        ...(mode === "thread_bootstrap"
          ? { contextProjection: { mode: "thread_bootstrap" as const, epoch: "append-epoch" } }
          : {}),
      };
      assemble.mockResolvedValue(initial);
      let starts = 0;
      const harness = createStartedThreadHarness(
        async (method) =>
          method === "thread/start" ? threadStartResult(`thread-selected-${++starts}`) : undefined,
        { persistedThreads: [] },
      );
      const runTurn = async (runId: string, threadId: string) => {
        const offset = harness.requests.length;
        const run = runCodexAppServerAttempt({ ...params, runId });
        await run.waitForTurnAccepted();
        const requests = harness.requests.slice(offset);
        expect(requests.find(({ method }) => method === "turn/start")?.params).toMatchObject({
          threadId,
        });
        expect(
          JSON.stringify(requests.find(({ method }) => method === "turn/start")?.params),
        ).not.toContain("SELECTED_HISTORY");
        await harness.completeTurn("completed", threadId);
        await run;
        return requests;
      };
      const first = await runTurn("selected-first", "thread-selected-1");
      expect(first.filter(({ method }) => method === "thread/inject_items")).toHaveLength(1);
      const binding = await readCodexAppServerBinding(params.sessionFile);
      const unchanged = await runTurn("selected-unchanged", "thread-selected-1");
      expect(unchanged.some(({ method }) => method === "thread/inject_items")).toBe(false);
      assemble.mockResolvedValue({
        ...initial,
        messages: [...initial.messages, assistantMessage("APPENDED_SELECTED_HISTORY", 2)],
      });
      const appended = await runTurn("selected-appended", "thread-selected-1");
      const injections = appended.filter(({ method }) => method === "thread/inject_items");
      expect(injections).toHaveLength(1);
      expect(injections[0]?.params).toMatchObject({ threadId: "thread-selected-1" });
      expect(JSON.stringify(injections[0]?.params)).toContain("APPENDED_SELECTED_HISTORY");
      expect(JSON.stringify(injections[0]?.params)).not.toContain("ORIGINAL_SELECTED_HISTORY");
      expect(appended.findIndex(({ method }) => method === "thread/inject_items")).toBeLessThan(
        appended.findIndex(({ method }) => method === "turn/start"),
      );
      const appendedBinding = await readCodexAppServerBinding(params.sessionFile);
      expect(appendedBinding?.contextEngine?.projection?.epoch).toBe(
        binding?.contextEngine?.projection?.epoch,
      );
      expect(appendedBinding?.contextEngine?.projection?.fingerprint).not.toBe(
        binding?.contextEngine?.projection?.fingerprint,
      );
      const repeated = await runTurn("selected-appended-unchanged", "thread-selected-1");
      expect(repeated.some(({ method }) => method === "thread/inject_items")).toBe(false);
      assemble.mockResolvedValue({
        ...initial,
        messages: [
          userMessage("REWRITTEN_SELECTED_HISTORY", 1),
          assistantMessage("APPENDED_SELECTED_HISTORY", 2),
        ],
      });
      const rewritten = await runTurn("selected-rewritten", "thread-selected-2");
      const replacement = rewritten.filter(({ method }) => method === "thread/inject_items");
      expect(starts).toBe(2);
      expect(replacement).toHaveLength(1);
      expect(replacement[0]?.params).toMatchObject({ threadId: "thread-selected-2" });
      expect(JSON.stringify(replacement[0]?.params)).toContain("REWRITTEN_SELECTED_HISTORY");
      expect(JSON.stringify(replacement[0]?.params)).toContain("APPENDED_SELECTED_HISTORY");
      expect(JSON.stringify(replacement[0]?.params)).not.toContain("ORIGINAL_SELECTED_HISTORY");
      const unchangedRewrite = await runTurn("selected-rewritten-unchanged", "thread-selected-2");
      expect(unchangedRewrite.some(({ method }) => method === "thread/inject_items")).toBe(false);
    },
  );

  it.each(["legacy-engine-fingerprint", "pending:selection-v1:interrupted"])(
    "rotates an unacknowledged %s binding once before resuming delta delivery",
    async (fingerprint) => {
      const { params } = seedParams("thread_bootstrap");
      let starts = 0;
      const harness = createStartedThreadHarness(
        async (method) =>
          method === "thread/start" ? threadStartResult(`thread-upgrade-${++starts}`) : undefined,
        { persistedThreads: [] },
      );
      const runTurn = async (runId: string, threadId: string) => {
        const run = runCodexAppServerAttempt({ ...params, runId });
        await run.waitForTurnAccepted();
        await harness.completeTurn("completed", threadId);
        await run;
      };
      await runTurn("before-upgrade", "thread-upgrade-1");
      const binding = await readCodexAppServerBinding(params.sessionFile);
      if (!binding?.contextEngine?.projection) {
        throw new Error("Expected a committed selected-history binding");
      }
      await writeCodexAppServerBinding(params.sessionFile, {
        ...binding,
        contextEngine: {
          ...binding.contextEngine,
          projection: { ...binding.contextEngine.projection, fingerprint },
        },
      });
      const offset = harness.requests.length;
      await runTurn("after-upgrade", "thread-upgrade-2");
      const replacement = harness.requests.slice(offset);
      expect(starts).toBe(2);
      expect(replacement.filter(({ method }) => method === "thread/inject_items")).toHaveLength(1);
      expect(JSON.stringify(replacement)).toContain(ANCHOR);
      const acknowledged = await readCodexAppServerBinding(params.sessionFile);
      expect(acknowledged?.contextEngine?.projection?.fingerprint).toMatch(/^selection-v1:/);
      const afterReplacement = harness.requests.length;
      await runTurn("after-upgrade-unchanged", "thread-upgrade-2");
      expect(starts).toBe(2);
      expect(
        harness.requests
          .slice(afterReplacement)
          .some(({ method }) => method === "thread/inject_items"),
      ).toBe(false);
    },
  );

  it.each(["thread_bootstrap", "per_turn"] as const)(
    "does not reinject acknowledged %s history after a cold native resume",
    async (mode) => {
      const { params } = seedParams(mode);
      const firstHarness = createStartedThreadHarness(
        async (method) =>
          method === "thread/start" ? threadStartResult("thread-cold-history") : undefined,
        { persistedThreads: [] },
      );
      const first = runCodexAppServerAttempt(params);
      await first.waitForTurnAccepted();
      await firstHarness.completeTurn("completed", "thread-cold-history");
      await first;
      const initialBinding = await readCodexAppServerBinding(params.sessionFile);
      expect(historySeedRequests(firstHarness)).toHaveLength(1);
      await firstHarness.client.closeAndWait();
      const resumedHarness = createStartedThreadHarness(
        async (method, request) => {
          if (method === "thread/resume" && isJsonObject(request)) {
            if (typeof request.threadId !== "string") {
              throw new Error("Expected the preserved native thread id in the resume request");
            }
            return threadStartResult(request.threadId);
          }
          return undefined;
        },
        {
          persistedThreads: [
            threadStartResult("thread-cold-history", { cwd: params.workspaceDir }),
          ],
        },
      );
      const resumed = runCodexAppServerAttempt({ ...params, runId: "cold-history-resume" });
      await resumed.waitForTurnAccepted();
      expect(resumedHarness.requests.some(({ method }) => method === "thread/start")).toBe(false);
      expect(resumedHarness.requests.some(({ method }) => method === "thread/resume")).toBe(true);
      expect(historySeedRequests(resumedHarness)).toEqual([]);
      const resumedHistory = resumedHarness.requests
        .filter(({ method }) => method === "thread/inject_items")
        .flatMap(({ params: request }) =>
          isJsonObject(request) && Array.isArray(request.items) ? request.items : [],
        )
        .filter((item) => isJsonObject(item) && item.role === "user");
      expect(resumedHistory).toEqual([]);
      expect(
        resumedHarness.requests.find(({ method }) => method === "turn/start")?.params,
      ).toMatchObject({
        threadId: "thread-cold-history",
      });
      await resumedHarness.completeTurn("completed", "thread-cold-history");
      await resumed;
      expect(
        (await readCodexAppServerBinding(params.sessionFile))?.contextEngine?.projection,
      ).toEqual(initialBinding?.contextEngine?.projection);
    },
  );

  it("preserves a reused native transcript after an uncertain injection and retries fresh", async () => {
    const { params, assemble, messages } = seedParams("per_turn");
    let starts = 0;
    let loseAcknowledgment = false;
    const respond = async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult(`thread-warm-retry-${++starts}`);
      }
      return undefined;
    };
    const harness = createStartedThreadHarness(respond, { persistedThreads: [] });
    const dispatch = harness.request.getMockImplementation();
    if (!dispatch) {
      throw new Error("Expected the registered native request dispatcher");
    }
    vi.spyOn(harness.client, "request").mockImplementation(async (method, request, options) => {
      const result = await dispatch(method, request, options);
      // Registered injection has its own subscription owner and bypasses the
      // responder hook. Accept its real dispatch first, then lose only the
      // acknowledgment returned to this caller, not the native side effect.
      if (
        loseAcknowledgment &&
        method === "thread/inject_items" &&
        JSON.stringify(request).includes(ANCHOR)
      ) {
        throw new Error("Synthetic lost reused-history acknowledgment");
      }
      return result;
    });
    const first = runCodexAppServerAttempt(params);
    await first.waitForTurnAccepted();
    await harness.completeTurn("completed", "thread-warm-retry-1");
    await first;
    const original = await assemble.mock.results[0]!.value;
    assemble.mockResolvedValue({
      ...original,
      messages: [...messages, userMessage(`${ANCHOR} APPENDED_UNCERTAIN_HISTORY`, 5)],
    });
    const offset = harness.requests.length;
    loseAcknowledgment = true;
    await expect(runCodexAppServerAttempt({ ...params, runId: "warm-lost-ack" })).rejects.toThrow(
      "Synthetic lost reused-history acknowledgment",
    );
    const failedRequests = harness.requests.slice(offset);
    expect(starts).toBe(1);
    expect(failedRequests.some(({ method }) => method === "turn/start")).toBe(false);
    expect(failedRequests.some(({ method }) => method === "thread/delete")).toBe(false);
    expect(await readCodexAppServerBinding(params.sessionFile)).toBeUndefined();
    loseAcknowledgment = false;
    const retryHarness = createStartedThreadHarness(respond, { persistedThreads: [] });
    const retry = runCodexAppServerAttempt({ ...params, runId: "warm-retry" });
    await retry.waitForTurnAccepted();
    expect(starts).toBe(2);
    expect(historySeedRequests(retryHarness)).toHaveLength(1);
    await retryHarness.completeTurn("completed", "thread-warm-retry-2");
    await retry;
    expect((await readCodexAppServerBinding(params.sessionFile))?.threadId).toBe(
      "thread-warm-retry-2",
    );
  });

  it("keeps the ordinary assembly-error fallback with a configured cap", async () => {
    const { params } = seedParams("per_turn");
    params.contextEngine = createContextEngine({
      assemble: async () => {
        throw new Error("Synthetic ordinary assembly failure");
      },
    });
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await run.waitForTurnAccepted();
    expect(historySeedRequests(harness)).toEqual([]);
    expect(getRequestInputText(harness)).toContain(params.prompt);
    await harness.completeTurn();
    await run;
  });
});
