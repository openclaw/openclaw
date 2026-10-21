import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createAgentToolExecutionBudget } from "../../agent-tool-source-execution-guard.js";
import { isTrustedToolInputError } from "../../tool-input-error.js";
import { createEditTool, type EditToolOptions } from "./edit.js";
import * as planning from "./file-tool-planning.js";
import { createWriteTool } from "./write.js";

afterEach(() => vi.restoreAllMocks());
const fileError = new Error("Synthetic storage unavailable");
const path = "example.txt";

function storage(initial: string, failed = false) {
  let text = initial;
  const operations = {
    resolveQueueKey: (target: string) => target,
    access: async () => {
      if (failed) {
        throw fileError;
      }
    },
    readFile: async () => Buffer.from(text),
    writeFile: vi.fn(async (_path: string, value: string) => {
      text = value;
    }),
    statFile: async () =>
      failed ? null : { type: "file", size: Buffer.byteLength(text), mtimeMs: 1 },
  } satisfies NonNullable<EditToolOptions["operations"]>;
  return { operations, content: () => text };
}
it.each([
  ["absent", "Could not find the exact text", false],
  ["target", "Found 2 occurrences", false],
  ["", "oldText must not be empty", false],
  ["target", "Synthetic storage unavailable", true],
] as const)("classifies edit failure for %j (%s)", async (oldText, message, storageError) => {
  const content = storageError ? "target\n" : "target\ntarget\n";
  const { operations } = storage(content, storageError);
  const tool = createEditTool("/workspace", { operations });
  const edits = [{ oldText, newText: "replacement" }];
  const error = await tool.execute("edit", { path, edits }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(isTrustedToolInputError(error)).toBe(!storageError);
  if (storageError) {
    expect(error).toHaveProperty("cause", fileError);
  } else {
    expect(error).toMatchObject({ message: expect.stringContaining(message) });
    if (oldText === "absent") {
      expect(error).toMatchObject({
        message: expect.stringContaining(content),
        cause: { message: expect.not.stringContaining(content) },
      });
    }
    expect(operations.writeFile).not.toHaveBeenCalled();
  }
});

it.each(
  (["edit", "write"] as const).flatMap((kind) =>
    (["active", "revoked", "aborted"] as const).map((authority) => ({ kind, authority })),
  ),
)("$kind honors $authority after planning", async ({ kind, authority }) => {
  const prepared = createDeferredCore();
  const release = createDeferredCore();
  const hold = async <T>(pending: Promise<T>): Promise<T> => {
    const result = await pending;
    prepared.resolve();
    await release.promise;
    return result;
  };
  if (kind === "edit") {
    const plan = planning.planFileEdit;
    vi.spyOn(planning, "planFileEdit").mockImplementation((...args) => hold(plan(...args)));
  } else {
    const plan = planning.planFileWriteDiff;
    vi.spyOn(planning, "planFileWriteDiff").mockImplementation((...args) => hold(plan(...args)));
  }

  const { operations: base, content } = storage("before\n");
  const operations = { ...base, mkdir: vi.fn(async () => {}) };
  const { mkdir, writeFile } = operations;
  const state = () => ({ dirs: mkdir.mock.calls, writes: writeFile.mock.calls, text: content() });
  const controller = new AbortController();
  let current = true;
  const budget = createAgentToolExecutionBudget({
    signal: controller.signal,
    abort: (error) => controller.abort(error),
    isCurrent: () => current,
  });
  const editArgs = { path, edits: [{ oldText: "before", newText: "after" }] };
  const writeArgs = { path, content: "after\n" };
  const signal = controller.signal;
  const pending = budget.run(() =>
    kind === "edit"
      ? createEditTool("/workspace", { operations }).execute("planning", editArgs, signal)
      : createWriteTool("/workspace", { operations }).execute("planning", writeArgs, signal),
  );
  void pending.catch(prepared.reject);
  try {
    await prepared.promise;
    expect(state()).toEqual({ dirs: [], writes: [], text: "before\n" });
    if (authority === "revoked") {
      current = false;
    } else if (authority === "aborted") {
      controller.abort(new Error("Planning cancelled"));
    }
    release.resolve();
    if (authority === "active") {
      await expect(pending).resolves.toMatchObject({ details: { changed: true } });
      expect(state()).toMatchObject({ writes: [expect.any(Array)], text: "after\n" });
    } else {
      const abortedMessage = kind === "write" ? "Operation aborted" : "Planning cancelled";
      await expect(pending).rejects.toThrow(
        authority === "aborted" ? abortedMessage : "execution scope is no longer active",
      );
      expect(state()).toEqual({ dirs: [], writes: [], text: "before\n" });
    }
  } finally {
    release.resolve();
    await pending.catch(() => undefined);
  }
});
