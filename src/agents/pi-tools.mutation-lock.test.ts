import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { wrapToolMutationLock } from "./pi-tools.read.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function textResult(text: string): AgentToolResult<unknown> {
  return {
    isError: false,
    content: [{ type: "text", text }],
  };
}

describe("wrapToolMutationLock", () => {
  it("serializes same-path write calls", async () => {
    const firstGate = deferred();
    const events: string[] = [];

    const base: AnyAgentTool = {
      name: "write",
      parameters: {},
      execute: async (_toolCallId, params) => {
        const record = params as Record<string, unknown>;
        const content = typeof record.content === "string" ? record.content : "";
        events.push(`start:${content}`);
        if (content === "one") {
          await firstGate.promise;
        }
        events.push(`end:${content}`);
        return textResult(content);
      },
    };

    const wrapped = wrapToolMutationLock(base, "/workspace");

    const p1 = wrapped.execute("call-1", { path: "same.txt", content: "one" });
    const p2 = wrapped.execute("call-2", { file_path: "same.txt", content: "two" });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["start:one"]);

    firstGate.resolve();

    await expect(p1).resolves.toMatchObject({ isError: false });
    await expect(p2).resolves.toMatchObject({ isError: false });
    expect(events).toEqual(["start:one", "end:one", "start:two", "end:two"]);
  });

  it("allows different paths to run concurrently", async () => {
    const firstStarted = deferred();
    const releaseBoth = deferred();
    const events: string[] = [];

    const base: AnyAgentTool = {
      name: "edit",
      parameters: {},
      execute: async (_toolCallId, params) => {
        const record = params as Record<string, unknown>;
        const filePath =
          typeof record.path === "string"
            ? record.path
            : typeof record.file_path === "string"
              ? record.file_path
              : "";
        events.push(`start:${filePath}`);
        if (filePath === "a.txt") {
          firstStarted.resolve();
        }
        await releaseBoth.promise;
        events.push(`end:${filePath}`);
        return textResult(filePath);
      },
    };

    const wrapped = wrapToolMutationLock(base, "/workspace");

    const p1 = wrapped.execute("call-1", { path: "a.txt", oldText: "a", newText: "A" });
    await firstStarted.promise;
    const p2 = wrapped.execute("call-2", { path: "b.txt", old_string: "b", new_string: "B" });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["start:a.txt", "start:b.txt"]);

    releaseBoth.resolve();
    await Promise.all([p1, p2]);

    expect(events).toContain("end:a.txt");
    expect(events).toContain("end:b.txt");
  });
});
