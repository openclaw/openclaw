import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createAgentToolExecutionBudget } from "../../agent-tool-source-execution-guard.js";
import { isTrustedToolInputError } from "../../tool-input-error.js";
import { createEditTool } from "./edit.js";
import * as planning from "./file-tool-planning.js";
import { createWriteTool } from "./write.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  { name: "missing", oldText: "absent", message: "Could not find the exact text" },
  { name: "ambiguous", oldText: "target", message: "Found 2 occurrences" },
  { name: "empty", oldText: "", message: "oldText must not be empty" },
])(
  "preserves trusted $name edit input errors across planning workers",
  async ({ oldText, message }) => {
    const content = "target\ntarget\n";
    const writeFile = vi.fn(async () => {});
    const tool = createEditTool("/workspace", {
      operations: {
        resolveQueueKey: (target) => target,
        access: async () => {},
        readFile: async () => Buffer.from(content),
        writeFile,
        statFile: async () => ({ type: "file", size: content.length, mtimeMs: 1 }),
      },
    });
    const error = await tool
      .execute("invalid-edit", {
        path: "example.txt",
        edits: [{ oldText, newText: "replacement" }],
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("message", expect.stringContaining(message));
    expect(isTrustedToolInputError(error)).toBe(true);
    if (oldText === "absent") {
      expect(error).toHaveProperty("message", expect.stringContaining(content));
      expect(error).toHaveProperty("cause.message", expect.not.stringContaining(content));
    }
    expect(writeFile).not.toHaveBeenCalled();
  },
);

it("does not classify filesystem failures as edit input errors", async () => {
  const fileError = new Error("Synthetic storage unavailable");
  const tool = createEditTool("/workspace", {
    operations: {
      resolveQueueKey: (target) => target,
      access: async () => {
        throw fileError;
      },
      readFile: async () => Buffer.from("target\n"),
      writeFile: async () => {},
      statFile: async () => null,
    },
  });
  const error = await tool
    .execute("storage-error", {
      path: "example.txt",
      edits: [{ oldText: "target", newText: "replacement" }],
    })
    .catch((caught: unknown) => caught);
  expect(error).toHaveProperty("cause", fileError);
  expect(isTrustedToolInputError(error)).toBe(false);
});

it.each(
  (["edit", "write"] as const).flatMap((kind) =>
    (["active", "revoked", "aborted"] as const).map((authority) => ({ kind, authority })),
  ),
)(
  "rechecks $authority authority after $kind planning before mutation",
  async ({ kind, authority }) => {
    const prepared = createDeferredCore();
    const release = createDeferredCore();
    const delayResult = async <T>(pending: Promise<T>): Promise<T> => {
      const result = await pending;
      prepared.resolve();
      await release.promise;
      return result;
    };
    if (kind === "edit") {
      const plan = planning.planFileEdit;
      vi.spyOn(planning, "planFileEdit").mockImplementation((...args) =>
        delayResult(plan(...args)),
      );
    } else {
      const plan = planning.planFileWriteDiff;
      vi.spyOn(planning, "planFileWriteDiff").mockImplementation((...args) =>
        delayResult(plan(...args)),
      );
    }

    let content = "before\n";
    const writeFile = vi.fn(async (_path: string, value: string) => {
      content = value;
    });
    const mkdir = vi.fn(async () => {});
    const operations = {
      resolveQueueKey: (target: string) => target,
      access: async () => {},
      mkdir,
      writeFile,
      readFile: async () => Buffer.from(content),
      statFile: async () => ({
        type: "file" as const,
        size: Buffer.byteLength(content),
        mtimeMs: 1,
      }),
    };
    const controller = new AbortController();
    let current = true;
    const budget = createAgentToolExecutionBudget({
      signal: controller.signal,
      abort: (error) => controller.abort(error),
      isCurrent: () => current,
    });
    const pending = budget.run(() =>
      kind === "edit"
        ? createEditTool("/workspace", { operations }).execute(
            "planning",
            { path: "example.txt", edits: [{ oldText: "before", newText: "after" }] },
            controller.signal,
          )
        : createWriteTool("/workspace", { operations }).execute(
            "planning",
            { path: "example.txt", content: "after\n" },
            controller.signal,
          ),
    );
    void pending.catch(prepared.reject);
    try {
      await prepared.promise;
      expect(mkdir).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
      expect(content).toBe("before\n");
      if (authority === "revoked") {
        current = false;
      } else if (authority === "aborted") {
        controller.abort(new Error("Planning cancelled"));
      }
      release.resolve();
      if (authority === "active") {
        await expect(pending).resolves.toMatchObject({ details: { changed: true } });
        expect(writeFile).toHaveBeenCalledOnce();
        expect(content).toBe("after\n");
      } else {
        const abortedMessage = kind === "write" ? "Operation aborted" : "Planning cancelled";
        await expect(pending).rejects.toThrow(
          authority === "aborted" ? abortedMessage : "execution scope is no longer active",
        );
        expect(mkdir).not.toHaveBeenCalled();
        expect(writeFile).not.toHaveBeenCalled();
        expect(content).toBe("before\n");
      }
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
    }
  },
);
