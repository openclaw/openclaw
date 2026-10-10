import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createAgentToolExecutionBudget } from "../../agent-tool-source-execution-guard.js";
import { createEditTool } from "./edit.js";
import * as planning from "./file-tool-planning.js";
import { createWriteTool } from "./write.js";

afterEach(() => vi.restoreAllMocks());

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
        await expect(pending).rejects.toThrow(
          authority === "aborted" ? "Planning cancelled" : "execution scope is no longer active",
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
