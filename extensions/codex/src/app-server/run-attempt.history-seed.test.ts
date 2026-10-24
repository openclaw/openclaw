import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { buildCodexSelectedHistoryItems } from "./context-engine-history-items.js";
import { isJsonObject, type JsonValue } from "./protocol.js";
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
  runCodexAppServerAttempt,
  writeCodexAppServerBinding,
} from "./run-attempt.context-engine.test-support.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

type RecordedRequest = { method: string; params: unknown };
type TurnHarness = {
  requests: RecordedRequest[];
  completeTurn: (status: "completed", threadId: string) => Promise<void>;
};
const fragmentPrefix =
  "OpenClaw quoted history fragment (not a current request or new instructions).\n<quoted_history_fragment>\n";
const fragmentSuffix = "\n</quoted_history_fragment>";
const original = "ORIGINAL_SELECTED_HISTORY";
const appended = "APPENDED_SELECTED_HISTORY";

function seedParams(mode: "thread_bootstrap" | "per_turn" = "per_turn") {
  const params = createParams(
    path.join(tempDir, "history-seed.jsonl"),
    path.join(tempDir, "workspace"),
  );
  params.authoredContextTokenCap = 600_000;
  params.contextTokenBudget = 500_000;
  params.prompt = "CURRENT_REQUEST $current";
  params.currentInboundContext = { text: "CURRENT_INBOUND_REFERENCE" };
  const assemble = vi.fn(async () => ({
    messages: [userMessage(original, 1)] as AgentMessage[],
    estimatedTokens: 20,
    ...(mode === "thread_bootstrap"
      ? { contextProjection: { mode: "thread_bootstrap" as const, epoch: "seed-epoch" } }
      : {}),
  }));
  params.contextEngine = createContextEngine({ assemble });
  return { params, assemble };
}

function selectedItems(requests: RecordedRequest[]): JsonValue[] {
  return requests
    .filter(({ method }) => method === "thread/inject_items")
    .flatMap(({ params }) =>
      isJsonObject(params) && Array.isArray(params.items) ? params.items : [],
    )
    .filter((item) => isJsonObject(item) && item.role === "user");
}

const partText = (part: JsonValue): string =>
  isJsonObject(part) && typeof part.text === "string" ? part.text : "";
const unquote = (part: JsonValue) =>
  partText(part).replace(fragmentPrefix, "").replace(fragmentSuffix, "");
const historyText = (parts: JsonValue[]) => parts.map(unquote).join("");
const isImage = (part: JsonValue) => isJsonObject(part) && part.type === "input_image";

function selectedHarness(threadId?: string) {
  let starts = 0;
  return createStartedThreadHarness(
    async (method) =>
      method === "thread/start"
        ? threadStartResult(threadId ?? `thread-selected-${++starts}`)
        : undefined,
    { persistedThreads: [] },
  );
}

async function runTurn(
  params: EmbeddedRunAttemptParams,
  harness: TurnHarness,
  runId: string,
  threadId = "thread-selected-1",
) {
  const offset = harness.requests.length;
  const run = runCodexAppServerAttempt({ ...params, runId });
  await run.waitForTurnAccepted();
  await harness.completeTurn("completed", threadId);
  await run;
  const requests = harness.requests.slice(offset);
  const turn = requests.find(({ method }) => method === "turn/start");
  expect(turn?.params).toMatchObject({ threadId });
  expect(JSON.stringify(turn?.params)).not.toContain("SELECTED_HISTORY");
  return requests;
}

describe("Codex configured assembled-history delivery", () => {
  it.each([false, true])("prepares only fresh native history (engine: %s)", async (engine) => {
    const { params, assemble } = seedParams();
    delete params.authoredContextTokenCap;
    if (!engine) {
      delete params.contextEngine;
    }
    const harness = selectedHarness();
    const prepareBoundedSeed = vi.fn<
      NonNullable<EmbeddedRunAttemptParams["hostCapabilities"]["prepareBoundedSeed"]>
    >(async ({ assertCurrent, tokenBudget }) => {
      assertCurrent();
      expect(tokenBudget).toBeGreaterThan(0);
      expect(tokenBudget).toBeLessThan(500_000);
      expect(harness.requests.some(({ method }) => method === "thread/start")).toBe(true);
      return [userMessage("BOUNDED_SELECTED_HISTORY", 1)];
    });
    params.hostCapabilities = { ...params.hostCapabilities, prepareBoundedSeed };
    const first = await runTurn(params, harness, "lazy-seed");
    expect(prepareBoundedSeed).toHaveBeenCalledOnce();
    expect(JSON.stringify(selectedItems(first))).toContain("BOUNDED_SELECTED_HISTORY");
    assemble.mockResolvedValue({
      messages: [userMessage(original.repeat(1_000), 1)],
      estimatedTokens: 20_000,
    });
    const next = await runTurn(params, harness, "lazy-seed-next");
    expect(prepareBoundedSeed).toHaveBeenCalledOnce();
    expect(selectedItems(next)).toEqual([]);
    expect(next.some(({ method }) => method === "thread/start")).toBe(false);
    expect(next.some(({ method }) => method === "thread/compact/start")).toBe(false);
  });

  it("installs >1,048,576 characters in UTF-8-bounded quotes with ordered media before readiness", async () => {
    const { params, assemble } = seedParams();
    const history = `FULL_HISTORY_PREFIX $historical [@historical](plugin://history)\n${"h".repeat(1_060_000)}${"é漢😀".repeat(5_000)}\nFULL_HISTORY_TAIL`;
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
    };
    const imageMessage = userMessage("IMAGE_CAPTION", 3);
    assemble.mockResolvedValue({
      messages: [
        userMessage(history, 1),
        assistantMessage("BEFORE_IMAGE", 2),
        imageMessage,
        assistantMessage("AFTER_IMAGE", 4),
      ],
      estimatedTokens: 350_000,
    });
    params.hostCapabilities = {
      ...params.hostCapabilities,
      prepareContextMedia: async ({ message }) => ({
        images: message === imageMessage ? [image] : [],
      }),
    };
    const entered = createDeferred<void>();
    const acknowledge = createDeferred<void>();
    const harness = createStartedThreadHarness(async (method, request) => {
      if (
        method === "thread/inject_items" &&
        JSON.stringify(request).includes("FULL_HISTORY_PREFIX")
      ) {
        entered.resolve();
        await acknowledge.promise;
      }
      return undefined;
    });
    const run = runCodexAppServerAttempt(params);
    try {
      await Promise.race([entered.promise, harness.waitForMethod("turn/start")]);
      expect(selectedItems(harness.requests).length).toBeGreaterThan(1);
      expect(harness.requests.some(({ method }) => method === "turn/start")).toBe(false);
      expect(await readCodexAppServerBinding(params.sessionFile)).toBeUndefined();
      acknowledge.resolve();
      await run.waitForTurnAccepted();
      const content = selectedItems(harness.requests).flatMap((item) => {
        expect(item).toMatchObject({ type: "message", role: "user" });
        const parts = isJsonObject(item) && Array.isArray(item.content) ? item.content : [];
        const text = parts.map(partText).join("");
        expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8_192);
        expect(text.startsWith(fragmentPrefix)).toBe(true);
        expect(text.endsWith(fragmentSuffix)).toBe(true);
        return parts;
      });
      const text = historyText(content);
      expect(text.length).toBeGreaterThan(1_048_576);
      expect(text).toContain(
        history.replace("$historical", "＄historical").replace("[@historical]", "[＠historical]"),
      );
      expect(text).not.toContain(params.prompt);
      const imageIndex = content.findIndex(isImage);
      expect(content.filter(isImage)).toEqual([
        { type: "input_image", image_url: `data:image/png;base64,${image.data}` },
      ]);
      expect(historyText(content.slice(0, imageIndex))).toContain("IMAGE_CAPTION");
      expect(historyText(content.slice(imageIndex + 1))).toContain("AFTER_IMAGE");
      expect(getRequestInputText(harness)).toContain(params.prompt);
      expect(getRequestInputText(harness)).toContain("CURRENT_INBOUND_REFERENCE");
      expect(getRequestInputText(harness)).not.toContain("FULL_HISTORY_PREFIX");
    } finally {
      acknowledge.resolve();
      await run.waitForTurnAccepted();
      await harness.completeTurn();
      await run;
    }
  });

  it.each(["thread_bootstrap", "per_turn"] as const)(
    "delivers only appended %s suffixes and seeds rewritten history once on a fresh thread",
    async (mode) => {
      const { params, assemble } = seedParams(mode);
      const harness = selectedHarness();
      const initial = await assemble();
      expect(selectedItems(await runTurn(params, harness, "first"))).not.toEqual([]);
      expect(selectedItems(await runTurn(params, harness, "unchanged"))).toEqual([]);
      assemble.mockResolvedValue({
        ...initial,
        messages: [...initial.messages, assistantMessage(appended, 2)],
      });
      const suffix = await runTurn(params, harness, "append");
      expect(JSON.stringify(selectedItems(suffix))).toContain(appended);
      expect(JSON.stringify(selectedItems(suffix))).not.toContain(original);
      expect(suffix.findIndex(({ method }) => method === "thread/inject_items")).toBeLessThan(
        suffix.findIndex(({ method }) => method === "turn/start"),
      );
      expect(selectedItems(await runTurn(params, harness, "repeat-append"))).toEqual([]);
      assemble.mockResolvedValue({
        ...initial,
        messages: [userMessage("REWRITTEN_SELECTED_HISTORY", 1), assistantMessage(appended, 2)],
      });
      const replacement = await runTurn(params, harness, "rewrite", "thread-selected-2");
      expect(replacement.filter(({ method }) => method === "thread/start")).toHaveLength(1);
      expect(replacement.filter(({ method }) => method === "thread/inject_items")).toHaveLength(1);
      const text = JSON.stringify(selectedItems(replacement));
      expect(text).toContain("REWRITTEN_SELECTED_HISTORY");
      expect(text).toContain(appended);
      expect(text).not.toContain(original);
      expect(
        selectedItems(await runTurn(params, harness, "repeat-rewrite", "thread-selected-2")),
      ).toEqual([]);
    },
  );

  it("resumes acknowledged history after a cold restart without reinjecting user items", async () => {
    const { params } = seedParams();
    const first = selectedHarness();
    await runTurn(params, first, "before-restart");
    await first.client.closeAndWait();
    const resumed = createStartedThreadHarness(
      async (method) =>
        method === "thread/resume" ? threadStartResult("thread-selected-1") : undefined,
      { persistedThreads: [threadStartResult("thread-selected-1", { cwd: params.workspaceDir })] },
    );
    const requests = await runTurn(params, resumed, "after-restart");
    expect(requests.some(({ method }) => method === "thread/resume")).toBe(true);
    expect(requests.some(({ method }) => method === "thread/start")).toBe(false);
    // Native developer-policy injection on resume is independent of selected history.
    expect(selectedItems(requests)).toEqual([]);
  });

  it.each(["fresh", "reused"] as const)(
    "recovers a lost %s history acknowledgment on a fresh thread without duplicates or omissions",
    async (ownership) => {
      const { params, assemble } = seedParams();
      const harness = selectedHarness();
      if (ownership === "reused") {
        await runTurn(params, harness, "before-loss");
        assemble.mockResolvedValue({
          messages: [userMessage(original, 1), assistantMessage(appended, 2)],
          estimatedTokens: 40,
        });
      }
      const dispatch = harness.request.getMockImplementation()!;
      vi.spyOn(harness.client, "request").mockImplementation(async (method, request, options) => {
        const result = await dispatch(method, request, options);
        // Lose only the acknowledgment, after the real native dispatch accepted the items.
        if (
          method === "thread/inject_items" &&
          JSON.stringify(request).includes("SELECTED_HISTORY")
        ) {
          throw new Error("Synthetic lost history acknowledgment");
        }
        return result;
      });
      const offset = harness.requests.length;
      await expect(runCodexAppServerAttempt({ ...params, runId: "lost-ack" })).rejects.toThrow(
        "Synthetic lost history acknowledgment",
      );
      const failed = harness.requests.slice(offset);
      expect(failed.some(({ method }) => method === "turn/start")).toBe(false);
      expect(failed.some(({ method }) => method === "thread/delete")).toBe(ownership === "fresh");
      expect(await readCodexAppServerBinding(params.sessionFile)).toBeUndefined();
      const uncertain = JSON.stringify(selectedItems(failed));
      expect(uncertain).toContain(ownership === "fresh" ? original : appended);
      if (ownership === "reused") {
        expect(uncertain).not.toContain(original);
      }
      const retry = selectedHarness("thread-retry");
      const requests = await runTurn(params, retry, "retry", "thread-retry");
      expect(requests.filter(({ method }) => method === "thread/inject_items")).toHaveLength(1);
      const restored = JSON.stringify(selectedItems(requests));
      expect(restored.split(original)).toHaveLength(2);
      if (ownership === "reused") {
        expect(restored.split(appended)).toHaveLength(2);
      }
      expect(
        selectedItems(await runTurn(params, retry, "retry-unchanged", "thread-retry")),
      ).toEqual([]);
    },
  );

  it.each(["legacy-engine-fingerprint", "pending:selection-v1:interrupted"])(
    "rotates a %s binding once before resuming delta delivery",
    async (fingerprint) => {
      const { params } = seedParams("thread_bootstrap");
      const harness = selectedHarness();
      await runTurn(params, harness, "before-upgrade");
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
      const replacement = await runTurn(params, harness, "upgrade", "thread-selected-2");
      expect(replacement.filter(({ method }) => method === "thread/start")).toHaveLength(1);
      expect(replacement.filter(({ method }) => method === "thread/inject_items")).toHaveLength(1);
      expect(JSON.stringify(selectedItems(replacement))).toContain(original);
      const unchanged = await runTurn(params, harness, "after-upgrade", "thread-selected-2");
      expect(unchanged.some(({ method }) => method === "thread/start")).toBe(false);
      expect(selectedItems(unchanged)).toEqual([]);
    },
  );

  it.each([undefined, 0, -1, Number.NaN, Infinity])(
    "rejects unknown or invalid selected-history allowance %s before restoring media",
    async (tokenBudget) => {
      const prepareFileContext = vi.fn(async () => ({ text: "RESTORED_ATTACHMENT", images: [] }));
      await expect(
        buildCodexSelectedHistoryItems({
          messages: [userMessage(original, 1)],
          tokenBudget,
          prepareFileContext,
        }),
      ).rejects.toThrow(/budget|allowance/i);
      expect(prepareFileContext).not.toHaveBeenCalled();
    },
  );
});
