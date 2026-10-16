import path from "node:path";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { attemptTerminal } from "./attempt-terminal.js";
import type { CodexUserInput } from "./protocol.js";
import {
  assistantMessage,
  bindProductionHarnessHostCapabilitiesForTest,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  userMessage,
} from "./run-attempt-test-harness.js";
import * as turnRequest from "./run-attempt-turn-request.js";
import {
  createContextEngine,
  createParams,
  createStartedThreadHarness,
  getRequestInputText,
  runCodexAppServerAttempt,
} from "./run-attempt.context-engine.test-support.js";
import * as sessionBinding from "./session-binding.js";
import {
  readCodexAppServerBinding,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

const goal = "ORIGINAL_GOAL: keep the receipt checksum unchanged";
const checksum = "CHECKSUM_CONSTRAINT: 7f2c9a";

function bootstrapParams() {
  const sessionFile = path.join(tempDir, "startup-bootstrap.jsonl");
  const params = createParams(sessionFile, path.join(tempDir, "workspace-bootstrap"));
  params.contextEngine = createContextEngine({
    assemble: vi.fn(async ({ prompt }) => ({
      messages: [
        userMessage(goal, 10),
        assistantMessage(checksum, 11),
        userMessage(prompt ?? "", 12),
      ],
      estimatedTokens: 64,
      contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-1" },
    })),
  });
  return params;
}

async function completeAcceptedRun(
  harness: ReturnType<typeof createStartedThreadHarness>,
  run: ReturnType<typeof runCodexAppServerAttempt>,
  status: "completed" | "failed" = "completed",
) {
  await run.waitForTurnAccepted();
  const request = harness.requests.find(({ method }) => method === "turn/start");
  if (!request) {
    throw new Error("expected an accepted turn/start request");
  }
  const { threadId } = request.params as { threadId: string };
  await harness.completeTurn(status, threadId);
  return await run;
}

async function retryBootstrap(params: ReturnType<typeof bootstrapParams>) {
  const saved = await readCodexAppServerBinding(params.sessionFile);
  const harness = createStartedThreadHarness(
    async (method) => {
      if (method === "thread/resume") {
        return threadStartResult(saved!.threadId);
      }
      if (method === "thread/start") {
        return threadStartResult("thread-retry");
      }
      return undefined;
    },
    { persistedThreads: saved ? [saved.threadId] : [] },
  );
  const run = runCodexAppServerAttempt({ ...params, runId: "bootstrap-retry" });
  await completeAcceptedRun(harness, run);
  expect(harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
  return getRequestInputText(harness);
}

describe("Codex fresh bootstrap delivery", () => {
  it.each(["none", "publication", "turn preparation", "turn rejection"] as const)(
    "retries with history only when the first input was not accepted: %s",
    async (failurePoint) => {
      const params = bootstrapParams();
      const failure = new Error("synthetic startup boundary failure");
      const resolveBinding = sessionBinding.resolveCodexSessionBinding;
      const publication = vi
        .spyOn(sessionBinding, "resolveCodexSessionBinding")
        .mockImplementation(async (input) => {
          const resolved = await resolveBinding(input);
          const withCurrent = resolved.authority.withCurrent;
          return {
            ...resolved,
            authority: {
              ...resolved.authority,
              withCurrent: async (consume) => {
                const result = await withCurrent(consume);
                // Same reader-release boundary as the existing warm-owner proof.
                // Native startup, publication and durable writes remain real.
                if (
                  failurePoint === "publication" &&
                  result !== null &&
                  typeof result === "object" &&
                  "lifecycle" in result &&
                  result.lifecycle !== null &&
                  typeof result.lifecycle === "object" &&
                  "action" in result.lifecycle &&
                  result.lifecycle.action === "started"
                ) {
                  throw failure;
                }
                return result;
              },
            },
          };
        });
      const preparation = vi.spyOn(turnRequest, "prepareCodexAttemptTurnRequest");
      if (failurePoint === "turn preparation") {
        preparation.mockRejectedValueOnce(failure);
      }
      const firstHarness = createStartedThreadHarness(
        async (method) => {
          if (failurePoint === "turn rejection" && method === "turn/start") {
            throw failure;
          }
          return undefined;
        },
        { persistedThreads: [] },
      );
      const firstRun = runCodexAppServerAttempt(params);
      if (failurePoint === "none") {
        await completeAcceptedRun(firstHarness, firstRun);
        expect(getRequestInputText(firstHarness)).toContain(checksum);
      } else {
        await expect(firstRun).rejects.toThrow(failure.message);
        expect(firstHarness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(
          failurePoint === "turn rejection" ? 1 : 0,
        );
      }
      publication.mockRestore();
      preparation.mockRestore();
      await firstHarness.client.closeAndWait();

      const retryInput = await retryBootstrap(params);
      if (failurePoint === "none") {
        expect(retryInput).toBe(params.prompt);
      } else {
        expect(retryInput).toContain(goal);
        expect(retryInput).toContain(checksum);
      }
    },
  );

  it.each([false, true])(
    "resumes accepted bootstrap history for two follow-ups (historical image: %s)",
    async (withImage) => {
      const params = bootstrapParams();
      params.model = { ...params.model, input: ["text", "image"] };
      const png = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
      const savedImage = withImage
        ? await saveMediaBuffer(png, "image/png", "inbound", undefined, "history.png")
        : undefined;
      const historical = {
        ...userMessage(goal, 10),
        ...(savedImage
          ? {
              __openclaw: {
                media: [
                  {
                    url: `media://inbound/${savedImage.id}`,
                    contentType: "image/png",
                    fileName: "history.png",
                  },
                ],
                mediaImageLayout: { slots: [{ kind: "offloaded" as const, factIndex: 0 }] },
              },
            }
          : {}),
      };
      params.contextEngine = createContextEngine({
        assemble: vi.fn(async () => ({
          messages: [historical, assistantMessage(checksum, 11)],
          estimatedTokens: 64,
          contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-1" },
        })),
      });
      const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
      try {
        for (let turn = 0; turn < 3; turn++) {
          const binding = await readCodexAppServerBinding(params.sessionFile);
          const harness = createStartedThreadHarness(
            async (method) => {
              if (method === "thread/start") {
                return threadStartResult(`thread-turn-${turn}`);
              }
              if (method === "thread/resume") {
                return threadStartResult(binding!.threadId);
              }
              return undefined;
            },
            { persistedThreads: binding ? [binding.threadId] : [] },
          );
          try {
            const prompt = `Follow-up request ${turn}`;
            const result = await completeAcceptedRun(
              harness,
              runCodexAppServerAttempt({ ...params, runId: `image-bootstrap-${turn}`, prompt }),
            );
            expect(attemptTerminal.project(result.terminal).promptError).toBeNull();
            const request = harness.requests.find(({ method }) => method === "turn/start");
            const { input, threadId } = request!.params as {
              input: CodexUserInput[];
              threadId: string;
            };
            expect.soft(threadId).toBe("thread-turn-0");
            expect
              .soft(
                (await readCodexAppServerBinding(params.sessionFile))?.contextEngine?.projection
                  ?.epoch,
              )
              .toBe("epoch-1");
            expect
              .soft(harness.requests.filter(({ method }) => method === "thread/start"))
              .toHaveLength(turn === 0 ? 1 : 0);
            expect
              .soft(harness.requests.filter(({ method }) => method === "thread/resume"))
              .toHaveLength(turn === 0 ? 0 : 1);
            if (turn === 0) {
              expect(getRequestInputText(harness)).toContain(goal);
              expect(getRequestInputText(harness)).toContain(checksum);
              expect(input.map((item) => item.type)).toEqual(
                withImage ? ["text", "image", "text"] : ["text"],
              );
              if (withImage) {
                expect(input[1]).toEqual({
                  type: "image",
                  url: `data:image/png;base64,${png.toString("base64")}`,
                });
              }
            } else {
              expect.soft(input).toEqual([{ type: "text", text: prompt, text_elements: [] }]);
            }
          } finally {
            await harness.client.closeAndWait();
          }
        }
      } finally {
        closeHost();
      }
    },
  );

  it("keeps the accepted bootstrap after the provider fails the turn", async () => {
    const params = bootstrapParams();
    const harness = createStartedThreadHarness(undefined, { persistedThreads: [] });
    const run = runCodexAppServerAttempt(params);
    const result = await completeAcceptedRun(harness, run, "failed");
    expect(attemptTerminal.project(result.terminal).promptError).toBeTruthy();
    expect(
      (await readCodexAppServerBinding(params.sessionFile))?.contextEngine?.projection,
    ).toMatchObject({
      epoch: "epoch-1",
    });
    await harness.client.closeAndWait();
    expect(await retryBootstrap(params)).toBe(params.prompt);
  });

  it("keeps the accepted bootstrap after user cancellation", async () => {
    const params = bootstrapParams();
    const controller = new AbortController();
    params.abortSignal = controller.signal;
    const harness = createStartedThreadHarness(undefined, { persistedThreads: [] });
    const run = runCodexAppServerAttempt(params);
    await run.waitForTurnAccepted();
    controller.abort("synthetic user cancellation");
    await harness.waitForMethod("turn/interrupt");
    await harness.notify({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", items: [] } },
    });
    expect(attemptTerminal.project((await run).terminal).aborted).toBe(true);
    expect(
      (await readCodexAppServerBinding(params.sessionFile))?.contextEngine?.projection,
    ).toMatchObject({
      epoch: "epoch-1",
    });
    await harness.client.closeAndWait();
    delete params.abortSignal;
    expect(await retryBootstrap(params)).toBe(params.prompt);
  });

  it("does not confirm an indeterminate cancelled turn/start", async () => {
    const params = bootstrapParams();
    const controller = new AbortController();
    params.abortSignal = controller.signal;
    const lateReply = Promise.withResolvers<void>();
    const harness = createStartedThreadHarness(
      async (method) => {
        if (method === "turn/start") {
          await lateReply.promise;
        }
        return undefined;
      },
      { persistedThreads: [] },
    );
    const result = runCodexAppServerAttempt(params).catch((error: unknown) => error);
    await harness.waitForMethod("turn/start");
    controller.abort("synthetic pending-request cancellation");
    await harness.waitForMethod("turn/interrupt");
    await harness.notify({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", items: [] } },
    });
    lateReply.resolve();
    expect(await result).toBeInstanceOf(Error);
    expect(harness.requests.filter(({ method }) => method === "turn/interrupt")).toEqual([
      { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "" } },
    ]);
    expect(
      (await readCodexAppServerBinding(params.sessionFile))?.contextEngine?.projection,
    ).toBeUndefined();
  });

  it("does not overwrite a replacement binding after accepting the old owner's input", async () => {
    const params = bootstrapParams();
    const harness = createStartedThreadHarness(undefined, { persistedThreads: [] });
    const mutate = testCodexAppServerBindingStore.mutate.bind(testCodexAppServerBindingStore);
    const mutation = vi
      .spyOn(testCodexAppServerBindingStore, "mutate")
      .mockImplementation(async (...args) => {
        const operation = args[1];
        if (operation.kind === "patch" && operation.patch.contextEngine?.projection) {
          const saved = await readCodexAppServerBinding(params.sessionFile);
          if (!saved) {
            throw new Error("expected committed fresh binding");
          }
          expect(
            await mutate(
              args[0],
              {
                kind: "replace-thread",
                expectedThreadId: saved.threadId,
                binding: {
                  ...saved,
                  threadId: "replacement-thread",
                  clientId: "replacement-client",
                },
              },
              args[2],
              args[3],
            ),
          ).toBe(true);
        }
        return await mutate(...args);
      });
    const result = await completeAcceptedRun(harness, runCodexAppServerAttempt(params));
    expect(attemptTerminal.project(result.terminal).promptError).toBeNull();
    expect(harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    expect(mutation.mock.calls.some(([, operation]) => operation.kind === "clear")).toBe(false);
    const saved = await readCodexAppServerBinding(params.sessionFile);
    expect(saved).toMatchObject({ threadId: "replacement-thread", clientId: "replacement-client" });
    expect(saved?.contextEngine?.projection).toBeUndefined();
  });

  it.each(["throw", "conflict"] as const)(
    "preserves the accepted result when only its receipt write fails: %s",
    async (failure) => {
      const params = bootstrapParams();
      const harness = createStartedThreadHarness(undefined, { persistedThreads: [] });
      const mutate = testCodexAppServerBindingStore.mutate.bind(testCodexAppServerBindingStore);
      const mutation = vi
        .spyOn(testCodexAppServerBindingStore, "mutate")
        .mockImplementation(async (...args) => {
          const operation = args[1];
          if (operation.kind === "patch" && operation.patch.contextEngine?.projection) {
            if (failure === "throw") {
              throw new Error("synthetic receipt write failure");
            }
            return false;
          }
          return await mutate(...args);
        });
      const result = await completeAcceptedRun(harness, runCodexAppServerAttempt(params));
      expect(attemptTerminal.project(result.terminal).promptError).toBeNull();
      expect(harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
      expect(mutation.mock.calls.some(([, operation]) => operation.kind === "clear")).toBe(false);
      const saved = await readCodexAppServerBinding(params.sessionFile);
      expect(saved?.threadId).toBe("thread-1");
      expect(saved?.historyCoveredThrough).toBeDefined();
      expect(saved?.contextEngine?.projection).toBeUndefined();
    },
  );

  it("does not confirm a bootstrap block omitted by final input fitting", async () => {
    const params = bootstrapParams();
    params.prompt = "current request ".repeat(80_000);
    const harness = createStartedThreadHarness(undefined, { persistedThreads: [] });
    const result = await completeAcceptedRun(harness, runCodexAppServerAttempt(params));
    expect(attemptTerminal.project(result.terminal).promptError).toBeNull();
    expect(getRequestInputText(harness)).not.toContain(checksum);
    expect(
      (await readCodexAppServerBinding(params.sessionFile))?.contextEngine?.projection,
    ).toBeUndefined();
  });

  it("confirms an accepted bootstrap with no historical messages", async () => {
    const params = bootstrapParams();
    params.contextEngine = createContextEngine({
      assemble: vi.fn(async () => ({
        messages: [],
        estimatedTokens: 0,
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "empty-epoch" },
      })),
    });
    const harness = createStartedThreadHarness(undefined, { persistedThreads: [] });
    await completeAcceptedRun(harness, runCodexAppServerAttempt(params));
    expect(
      (await readCodexAppServerBinding(params.sessionFile))?.contextEngine?.projection,
    ).toMatchObject({
      epoch: "empty-epoch",
    });
    await harness.client.closeAndWait();
    expect(await retryBootstrap(params)).toBe(params.prompt);
  });
});
