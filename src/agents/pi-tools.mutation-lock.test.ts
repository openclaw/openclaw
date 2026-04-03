import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { acquireWorkspaceLock } from "../infra/workspace-lock-manager.js";
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
    content: [{ type: "text", text }],
    details: undefined,
  };
}

async function waitUntil(assertFn: () => void, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      assertFn();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("waitUntil assertion timed out");
}

describe("wrapToolMutationLock", () => {
  it("serializes same-path write calls", async () => {
    const firstGate = deferred();
    const events: string[] = [];

    const base: AnyAgentTool = {
      name: "write",
      label: "write",
      description: "test write",
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

    const wrapped = wrapToolMutationLock(base, process.cwd());

    const p1 = wrapped.execute("call-1", { path: "same.txt", content: "one" });

    await waitUntil(() => {
      expect(events).toEqual(["start:one"]);
    });

    const p2 = wrapped.execute("call-2", { file_path: "same.txt", content: "two" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["start:one"]);

    firstGate.resolve();

    await expect(p1).resolves.toMatchObject({ content: [{ type: "text", text: "one" }] });
    await expect(p2).resolves.toMatchObject({ content: [{ type: "text", text: "two" }] });
    expect(events).toEqual(["start:one", "end:one", "start:two", "end:two"]);
  });

  it("aborts queued same-path calls when signal is canceled", async () => {
    const firstGate = deferred();
    const events: string[] = [];

    const base: AnyAgentTool = {
      name: "write",
      label: "write",
      description: "test write",
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

    const wrapped = wrapToolMutationLock(base, process.cwd());
    const p1 = wrapped.execute("call-1", { path: "same.txt", content: "one" });

    await waitUntil(() => {
      expect(events).toEqual(["start:one"]);
    });

    const controller = new AbortController();
    const p2 = wrapped.execute("call-2", { path: "same.txt", content: "two" }, controller.signal);
    controller.abort();

    await expect(p2).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toEqual(["start:one"]);

    firstGate.resolve();
    await expect(p1).resolves.toMatchObject({ content: [{ type: "text", text: "one" }] });
    expect(events).toEqual(["start:one", "end:one"]);
  });

  it("aborts during filesystem lock contention", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mutation-lock-abort-"));
    try {
      const target = path.join(tempRoot, "same.txt");
      const held = await acquireWorkspaceLock(target, {
        kind: "file",
        timeoutMs: 100,
        pollIntervalMs: 5,
        ttlMs: 5_000,
      });

      const base: AnyAgentTool = {
        name: "write",
        label: "write",
        description: "test write",
        parameters: {},
        execute: async () => textResult("ok"),
      };

      const wrapped = wrapToolMutationLock(base, tempRoot);
      const controller = new AbortController();
      const pending = wrapped.execute(
        "call-1",
        { path: target, content: "one" },
        controller.signal,
      );

      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await held.release();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("allows different paths to run concurrently", async () => {
    const firstStarted = deferred();
    const releaseBoth = deferred();
    const events: string[] = [];

    const base: AnyAgentTool = {
      name: "edit",
      label: "edit",
      description: "test edit",
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

    const wrapped = wrapToolMutationLock(base, process.cwd());

    const p1 = wrapped.execute("call-1", { path: "a.txt", oldText: "a", newText: "A" });
    await firstStarted.promise;
    const p2 = wrapped.execute("call-2", { path: "b.txt", old_string: "b", new_string: "B" });

    await waitUntil(() => {
      expect(events).toEqual(["start:a.txt", "start:b.txt"]);
    });

    releaseBoth.resolve();
    await Promise.all([p1, p2]);

    expect(events).toContain("end:a.txt");
    expect(events).toContain("end:b.txt");
  });

  it("normalizes container absolute paths into shared lock keys", async () => {
    const gate = deferred();
    const events: string[] = [];

    const base: AnyAgentTool = {
      name: "write",
      label: "write",
      description: "test write",
      parameters: {},
      execute: async (_toolCallId, params) => {
        const record = params as Record<string, unknown>;
        const filePath = typeof record.path === "string" ? record.path : "";
        events.push(`start:${filePath}`);
        if (filePath === "/agent/same.txt") {
          await gate.promise;
        }
        events.push(`end:${filePath}`);
        return textResult(filePath);
      },
    };

    const wrapped = wrapToolMutationLock(base, process.cwd(), { containerWorkdir: "/agent" });

    const p1 = wrapped.execute("call-1", { path: "/agent/same.txt", content: "one" });

    await waitUntil(() => {
      expect(events).toEqual(["start:/agent/same.txt"]);
    });

    const p2 = wrapped.execute("call-2", { path: "same.txt", content: "two" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["start:/agent/same.txt"]);

    gate.resolve();
    await Promise.all([p1, p2]);
    expect(events).toEqual([
      "start:/agent/same.txt",
      "end:/agent/same.txt",
      "start:same.txt",
      "end:same.txt",
    ]);
  });

  it("normalizes file:// container paths into shared lock keys", async () => {
    const gate = deferred();
    const events: string[] = [];

    const base: AnyAgentTool = {
      name: "write",
      label: "write",
      description: "test write",
      parameters: {},
      execute: async (_toolCallId, params) => {
        const record = params as Record<string, unknown>;
        const filePath = typeof record.path === "string" ? record.path : "";
        events.push(`start:${filePath}`);
        if (filePath === "file:///agent/same.txt") {
          await gate.promise;
        }
        events.push(`end:${filePath}`);
        return textResult(filePath);
      },
    };

    const wrapped = wrapToolMutationLock(base, process.cwd(), { containerWorkdir: "/agent" });

    const p1 = wrapped.execute("call-1", { path: "file:///agent/same.txt", content: "one" });

    await waitUntil(() => {
      expect(events).toEqual(["start:file:///agent/same.txt"]);
    });

    const p2 = wrapped.execute("call-2", { path: "same.txt", content: "two" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["start:file:///agent/same.txt"]);

    gate.resolve();
    await Promise.all([p1, p2]);
    expect(events).toEqual([
      "start:file:///agent/same.txt",
      "end:file:///agent/same.txt",
      "start:same.txt",
      "end:same.txt",
    ]);
  });

  it("normalizes dot-segmented container paths into shared lock keys", async () => {
    const gate = deferred();
    const events: string[] = [];

    const base: AnyAgentTool = {
      name: "write",
      label: "write",
      description: "test write",
      parameters: {},
      execute: async (_toolCallId, params) => {
        const record = params as Record<string, unknown>;
        const filePath = typeof record.path === "string" ? record.path : "";
        events.push(`start:${filePath}`);
        if (filePath === "/agent/../agent/same.txt") {
          await gate.promise;
        }
        events.push(`end:${filePath}`);
        return textResult(filePath);
      },
    };

    const wrapped = wrapToolMutationLock(base, process.cwd(), { containerWorkdir: "/agent" });

    const p1 = wrapped.execute("call-1", { path: "/agent/../agent/same.txt", content: "one" });

    await waitUntil(() => {
      expect(events).toEqual(["start:/agent/../agent/same.txt"]);
    });

    const p2 = wrapped.execute("call-2", { path: "/agent/same.txt", content: "two" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["start:/agent/../agent/same.txt"]);

    gate.resolve();
    await Promise.all([p1, p2]);
    expect(events).toEqual([
      "start:/agent/../agent/same.txt",
      "end:/agent/../agent/same.txt",
      "start:/agent/same.txt",
      "end:/agent/same.txt",
    ]);
  });

  it("normalizes extra sandbox bind mount paths into shared lock keys", async () => {
    const gate = deferred();
    const events: string[] = [];
    // Use a writable tmpdir as the bind-mount host source so the lock manager
    // can create .openclaw.workspace-locks without EACCES on /var/shared.
    const hostShared = await fs.mkdtemp(path.join(os.tmpdir(), "oc-bindmount-test-"));
    try {
      const base: AnyAgentTool = {
        name: "write",
        label: "write",
        description: "test write",
        parameters: {},
        execute: async (_toolCallId, params) => {
          const record = params as Record<string, unknown>;
          const filePath = typeof record.path === "string" ? record.path : "";
          events.push(`start:${filePath}`);
          if (filePath === "/data/shared.txt") {
            await gate.promise;
          }
          events.push(`end:${filePath}`);
          return textResult(filePath);
        },
      };

      const wrapped = wrapToolMutationLock(base, process.cwd(), {
        containerWorkdir: "/agent",
        bindMounts: [`${hostShared}:/data:rw`],
      });

      const p1 = wrapped.execute("call-1", { path: "/data/shared.txt", content: "one" });
      const p2 = wrapped.execute("call-2", {
        path: `${hostShared}/shared.txt`,
        content: "two",
      });

      await waitUntil(() => {
        expect(events).toEqual(["start:/data/shared.txt"]);
      });

      gate.resolve();
      await Promise.all([p1, p2]);
      expect(events).toEqual([
        "start:/data/shared.txt",
        "end:/data/shared.txt",
        `start:${hostShared}/shared.txt`,
        `end:${hostShared}/shared.txt`,
      ]);
    } finally {
      await fs.rm(hostShared, { recursive: true, force: true });
    }
  });

  it("normalizes root-mounted bind paths into shared lock keys", async () => {
    const gate = deferred();
    const events: string[] = [];
    // Use a writable tmpdir as the bind-mount host source so the lock manager
    // can create .openclaw.workspace-locks without EACCES on /var/shared.
    const hostShared = await fs.mkdtemp(path.join(os.tmpdir(), "oc-bindmount-root-test-"));
    try {
      const base: AnyAgentTool = {
        name: "write",
        label: "write",
        description: "test write",
        parameters: {},
        execute: async (_toolCallId, params) => {
          const record = params as Record<string, unknown>;
          const filePath = typeof record.path === "string" ? record.path : "";
          events.push(`start:${filePath}`);
          if (filePath === "/shared/root.txt") {
            await gate.promise;
          }
          events.push(`end:${filePath}`);
          return textResult(filePath);
        },
      };

      const wrapped = wrapToolMutationLock(base, process.cwd(), {
        containerWorkdir: "/agent",
        bindMounts: [`${hostShared}:/:rw`],
      });

      const p1 = wrapped.execute("call-1", { path: "/shared/root.txt", content: "one" });
      const p2 = wrapped.execute("call-2", {
        path: `${hostShared}/shared/root.txt`,
        content: "two",
      });

      await waitUntil(() => {
        expect(events).toEqual(["start:/shared/root.txt"]);
      });

      gate.resolve();
      await Promise.all([p1, p2]);
      expect(events).toEqual([
        "start:/shared/root.txt",
        "end:/shared/root.txt",
        `start:${hostShared}/shared/root.txt`,
        `end:${hostShared}/shared/root.txt`,
      ]);
    } finally {
      await fs.rm(hostShared, { recursive: true, force: true });
    }
  });

  it("serializes @-prefixed and plain paths to the same lock key", async () => {
    const gate = deferred();
    const events: string[] = [];

    const base: AnyAgentTool = {
      name: "write",
      label: "write",
      description: "test write",
      parameters: {},
      execute: async (_toolCallId, params) => {
        const record = params as Record<string, unknown>;
        const filePath = typeof record.path === "string" ? record.path : "";
        events.push(`start:${filePath}`);
        if (filePath === "notes.txt") {
          await gate.promise;
        }
        events.push(`end:${filePath}`);
        return textResult(filePath);
      },
    };

    const wrapped = wrapToolMutationLock(base, process.cwd());

    const p1 = wrapped.execute("call-1", { path: "notes.txt", content: "one" });
    const p2 = wrapped.execute("call-2", { path: "@notes.txt", content: "two" });

    await waitUntil(() => {
      expect(events).toEqual(["start:notes.txt"]);
    });

    gate.resolve();
    await Promise.all([p1, p2]);
    // p2 should have waited for p1 because both resolve to the same file
    expect(events).toEqual([
      "start:notes.txt",
      "end:notes.txt",
      "start:@notes.txt",
      "end:@notes.txt",
    ]);
  });

  it("canonicalizes symlink aliases for missing-file mutation lock keys", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mutation-lock-"));
    try {
      const workspaceRoot = path.join(tempRoot, "workspace");
      const realDir = path.join(workspaceRoot, "real");
      const aliasDir = path.join(workspaceRoot, "alias");
      await fs.mkdir(realDir, { recursive: true });
      await fs.symlink(realDir, aliasDir, "dir");

      const firstPath = path.join(realDir, "Missing.TXT");
      const secondPath = path.join(aliasDir, "Missing.TXT");

      const gate = deferred();
      const events: string[] = [];

      const base: AnyAgentTool = {
        name: "write",
        label: "write",
        description: "test write",
        parameters: {},
        execute: async (_toolCallId, params) => {
          const record = params as Record<string, unknown>;
          const filePath = typeof record.path === "string" ? record.path : "";
          events.push(`start:${filePath}`);
          if (filePath === firstPath) {
            await gate.promise;
          }
          events.push(`end:${filePath}`);
          return textResult(filePath);
        },
      };

      const wrapped = wrapToolMutationLock(base, workspaceRoot);
      const p1 = wrapped.execute("call-1", { path: firstPath, content: "one" });
      const p2 = wrapped.execute("call-2", { path: secondPath, content: "two" });

      await waitUntil(() => {
        expect(events).toEqual([`start:${firstPath}`]);
      });

      gate.resolve();
      await Promise.all([p1, p2]);

      expect(events).toEqual([
        `start:${firstPath}`,
        `end:${firstPath}`,
        `start:${secondPath}`,
        `end:${secondPath}`,
      ]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps mixed-case lock identity stable after file materialization", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mutation-lock-case-"));
    try {
      const workspaceRoot = path.join(tempRoot, "workspace");
      const mixedCasePath = path.join(workspaceRoot, "New", "State.JSON");
      const gate = deferred();
      const events: string[] = [];

      const base: AnyAgentTool = {
        name: "write",
        label: "write",
        description: "test write",
        parameters: {},
        execute: async (_toolCallId, params) => {
          const record = params as Record<string, unknown>;
          const filePath = typeof record.path === "string" ? record.path : "";
          events.push(`start:${filePath}`);
          if (filePath === mixedCasePath) {
            await fs.mkdir(path.dirname(mixedCasePath), { recursive: true });
            await fs.writeFile(mixedCasePath, "materialized", "utf8");
            await gate.promise;
          }
          events.push(`end:${filePath}`);
          return textResult(filePath);
        },
      };

      const wrapped = wrapToolMutationLock(base, workspaceRoot);
      const p1 = wrapped.execute("call-1", { path: mixedCasePath, content: "one" });

      await waitUntil(() => {
        expect(events).toEqual([`start:${mixedCasePath}`]);
      });

      const p2 = wrapped.execute("call-2", { path: mixedCasePath, content: "two" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual([`start:${mixedCasePath}`]);

      gate.resolve();
      await Promise.all([p1, p2]);

      expect(events).toEqual([
        `start:${mixedCasePath}`,
        `end:${mixedCasePath}`,
        `start:${mixedCasePath}`,
        `end:${mixedCasePath}`,
      ]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("aborting a middle waiter preserves queue order for later waiters", async () => {
    const tempRoot = path.join(os.tmpdir(), `oc-lock-queue-abort-${Date.now()}`);
    await fs.mkdir(tempRoot, { recursive: true });

    try {
      const events: string[] = [];
      const gate1 = deferred();

      const base: AnyAgentTool = {
        name: "write",
        label: "write",
        description: "test write",
        parameters: {},
        execute: async (_toolCallId, params) => {
          const record = params as Record<string, unknown>;
          const content = typeof record.content === "string" ? record.content : "";
          events.push(`start:${content}`);
          if (content === "first") {
            await gate1.promise;
          }
          events.push(`end:${content}`);
          return textResult(content);
        },
      };

      const wrapped = wrapToolMutationLock(base, tempRoot);
      const targetPath = path.join(tempRoot, "queue-order.txt");
      await fs.writeFile(targetPath, "");

      // Call 1: starts executing, blocks on gate
      const p1 = wrapped.execute("c1", { path: targetPath, content: "first" });
      await new Promise((r) => setTimeout(r, 10));
      expect(events).toEqual(["start:first"]);

      // Call 2: queued behind call 1, will be aborted
      const controller = new AbortController();
      const p2 = wrapped.execute("c2", { path: targetPath, content: "second" }, controller.signal);
      await new Promise((r) => setTimeout(r, 10));

      // Call 3: queued behind call 2
      const p3 = wrapped.execute("c3", { path: targetPath, content: "third" });
      await new Promise((r) => setTimeout(r, 10));

      // Abort call 2 while it's still waiting in queue
      controller.abort();
      await expect(p2).rejects.toThrow();

      // Release call 1 — call 3 should still execute after call 1
      gate1.resolve();
      await p1;
      await p3;

      // Call 3 must not have started before call 1 ended
      expect(events).toEqual(["start:first", "end:first", "start:third", "end:third"]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("new write arriving after abort but before predecessor settles still queues correctly", async () => {
    const tempRoot = path.join(os.tmpdir(), `oc-lock-abort-race-${Date.now()}`);
    await fs.mkdir(tempRoot, { recursive: true });

    try {
      const events: string[] = [];
      const gate1 = deferred();

      const base: AnyAgentTool = {
        name: "write",
        label: "write",
        description: "test write",
        parameters: {},
        execute: async (_toolCallId, params) => {
          const record = params as Record<string, unknown>;
          const content = typeof record.content === "string" ? record.content : "";
          events.push(`start:${content}`);
          if (content === "first") {
            await gate1.promise;
          }
          events.push(`end:${content}`);
          return textResult(content);
        },
      };

      const wrapped = wrapToolMutationLock(base, tempRoot);
      const targetPath = path.join(tempRoot, "abort-race.txt");
      await fs.writeFile(targetPath, "");

      // Call 1: starts, blocks on gate
      const p1 = wrapped.execute("c1", { path: targetPath, content: "first" });
      await new Promise((r) => setTimeout(r, 10));

      // Call 2: queued, then aborted
      const ctrl = new AbortController();
      const p2 = wrapped.execute("c2", { path: targetPath, content: "second" }, ctrl.signal);
      await new Promise((r) => setTimeout(r, 10));
      ctrl.abort();
      await expect(p2).rejects.toThrow();

      // Call 3: arrives AFTER abort — must still wait for call 1
      const p3 = wrapped.execute("c3", { path: targetPath, content: "third" });
      await new Promise((r) => setTimeout(r, 10));

      // Call 1 still running — call 3 must not have started
      expect(events).toEqual(["start:first"]);

      gate1.resolve();
      await p1;
      await p3;

      expect(events).toEqual(["start:first", "end:first", "start:third", "end:third"]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("wrapApplyPatchMutationLock", () => {
  it("serializes concurrent apply_patch calls on the same workspace root", async () => {
    const { wrapApplyPatchMutationLock } = await import("./pi-tools.read.js");
    const tempRoot = path.join(os.tmpdir(), `oc-apply-patch-lock-test-${Date.now()}`);
    await fs.mkdir(tempRoot, { recursive: true });

    const firstGate = deferred();
    const events: string[] = [];

    const base: AnyAgentTool = {
      name: "apply_patch",
      label: "apply_patch",
      description: "test apply_patch",
      parameters: {},
      execute: async (_toolCallId, params) => {
        const record = params as Record<string, unknown>;
        const id = typeof record.input === "string" ? record.input : "";
        events.push(`start:${id}`);
        if (id === "first") {
          await firstGate.promise;
        }
        events.push(`end:${id}`);
        return textResult(id);
      },
    };

    const locked = wrapApplyPatchMutationLock(base, tempRoot);

    try {
      const p1 = locked.execute("c1", { input: "first" });
      // Let microtask queue flush so p1 starts executing
      await new Promise((r) => setTimeout(r, 10));
      const p2 = locked.execute("c2", { input: "second" });

      // p1 should have started but p2 should be blocked
      await waitUntil(() => expect(events).toContain("start:first"));
      expect(events).not.toContain("start:second");

      // Release first — second should start after
      firstGate.resolve();
      await p1;
      await p2;

      expect(events).toEqual(["start:first", "end:first", "start:second", "end:second"]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("locks apply_patch move destinations against already-running writes", async () => {
    const { wrapApplyPatchMutationLock } = await import("./pi-tools.read.js");
    const tempRoot = path.join(os.tmpdir(), `oc-apply-patch-move-lock-test-${Date.now()}`);
    await fs.mkdir(tempRoot, { recursive: true });

    const writeGate = deferred();
    const events: string[] = [];
    const destination = path.join(tempRoot, "dest.txt");

    const writeBase: AnyAgentTool = {
      name: "write",
      label: "write",
      description: "test write",
      parameters: {},
      execute: async (_toolCallId, params) => {
        const record = params as Record<string, unknown>;
        const filePath = typeof record.path === "string" ? record.path : "";
        events.push(`write-start:${filePath}`);
        await writeGate.promise;
        events.push(`write-end:${filePath}`);
        return textResult(filePath);
      },
    };

    const applyPatchBase: AnyAgentTool = {
      name: "apply_patch",
      label: "apply_patch",
      description: "test apply_patch",
      parameters: {},
      execute: async () => {
        events.push("patch-start");
        events.push("patch-end");
        return textResult("patched");
      },
    };

    const lockedWrite = wrapToolMutationLock(writeBase, tempRoot);
    const lockedPatch = wrapApplyPatchMutationLock(applyPatchBase, tempRoot);

    try {
      const writePromise = lockedWrite.execute("write-1", { path: destination, content: "busy" });
      await waitUntil(() => {
        expect(events).toEqual([`write-start:${destination}`]);
      });

      const patchPromise = lockedPatch.execute("patch-1", {
        input: [
          "*** Begin Patch",
          "*** Update File: src.txt",
          "*** Move to: dest.txt",
          "@@",
          "-before",
          "+after",
          "*** End Patch",
        ].join("\n"),
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(events).toEqual([`write-start:${destination}`]);

      writeGate.resolve();
      await writePromise;
      await patchPromise;

      expect(events).toEqual([
        `write-start:${destination}`,
        `write-end:${destination}`,
        "patch-start",
        "patch-end",
      ]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("wrapToolMemoryFlushAppendOnlyWrite", () => {
  it("skips outer lock when mutationLockingEnabled to avoid nested-lock deadlock", async () => {
    const { wrapToolMemoryFlushAppendOnlyWrite } = await import("./pi-tools.read.js");
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memflush-lock-"));
    const relPath = "memory/test.md";
    const absPath = path.resolve(tempRoot, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, "initial\n");

    const executed = deferred();
    const writeTool: AnyAgentTool = {
      name: "write",
      label: "write",
      description: "test write",
      parameters: {},
      execute: async (_id, params) => {
        const record = params as Record<string, unknown>;
        await fs.writeFile(path.resolve(tempRoot, record.path as string), record.content as string);
        executed.resolve();
        return textResult("ok");
      },
    };

    const wrapped = wrapToolMemoryFlushAppendOnlyWrite(writeTool, {
      root: tempRoot,
      relativePath: relPath,
      mutationLockingEnabled: true,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      await wrapped.execute("flush-1", { path: relPath, content: "appended" }, controller.signal);
      await executed.promise;
      const result = await fs.readFile(absPath, "utf8");
      expect(result).toContain("initial");
      expect(result).toContain("appended");
    } finally {
      clearTimeout(timeout);
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("applies file lock when mutationLockingEnabled is unset", async () => {
    const { wrapToolMemoryFlushAppendOnlyWrite } = await import("./pi-tools.read.js");
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memflush-gate-"));
    const relPath = "memory/test.md";
    const absPath = path.resolve(tempRoot, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, "start\n");

    const writeTool: AnyAgentTool = {
      name: "write",
      label: "write",
      description: "test write",
      parameters: {},
      execute: async (_id, params) => {
        const record = params as Record<string, unknown>;
        await fs.writeFile(path.resolve(tempRoot, record.path as string), record.content as string);
        return textResult("ok");
      },
    };

    const wrapped = wrapToolMemoryFlushAppendOnlyWrite(writeTool, {
      root: tempRoot,
      relativePath: relPath,
    });

    await wrapped.execute("flush-2", { path: relPath, content: "added" });
    const result = await fs.readFile(absPath, "utf8");
    expect(result).toContain("start");
    expect(result).toContain("added");
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("serializes concurrent bind-mount calls that resolve to the same canonical key (race regression)", async () => {
    // Regression: when two concurrent calls both enter wrapToolMutationLock and
    // resolve to the same canonical lock key via async canonicalizeMutationLockKey,
    // both could see an empty map and proceed in parallel. The fix serializes the
    // key-resolution + map-insertion section so the second call always queues
    // behind the first.
    const hostShared = await fs.mkdtemp(path.join(os.tmpdir(), "oc-bindrace-"));
    try {
      const gate = deferred();
      const events: string[] = [];

      const base: AnyAgentTool = {
        name: "write",
        label: "write",
        description: "race regression test",
        parameters: {},
        execute: async (_toolCallId, params) => {
          const record = params as Record<string, unknown>;
          const filePath = typeof record.path === "string" ? record.path : "";
          events.push(`start:${filePath}`);
          if (events.length === 1) {
            // Block whichever call executes first.
            await gate.promise;
          }
          events.push(`end:${filePath}`);
          return textResult(filePath);
        },
      };

      const wrapped = wrapToolMutationLock(base, process.cwd(), {
        containerWorkdir: "/workspace",
        bindMounts: [`${hostShared}:/mount:rw`],
      });

      // Fire both at once — one uses container path, other uses host path.
      const p1 = wrapped.execute("race-1", { path: "/mount/file.txt", content: "a" });
      const p2 = wrapped.execute("race-2", { path: `${hostShared}/file.txt`, content: "b" });

      // Wait until the first call is blocked inside execute.
      await waitUntil(() => {
        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events.filter((e) => e.startsWith("start:")).length).toBe(1);
      });

      // Only one start should be visible — the other is queued.
      const starts = events.filter((e) => e.startsWith("start:"));
      expect(starts).toHaveLength(1);

      gate.resolve();
      await Promise.all([p1, p2]);

      // Both should have serialized: start→end then start→end.
      const startIndices = events
        .map((e, i) => (e.startsWith("start:") ? i : -1))
        .filter((i) => i >= 0);
      const endIndices = events
        .map((e, i) => (e.startsWith("end:") ? i : -1))
        .filter((i) => i >= 0);
      expect(startIndices).toHaveLength(2);
      expect(endIndices).toHaveLength(2);
      // First call must end before second call starts.
      expect(endIndices[0]).toBeLessThan(startIndices[1]);
    } finally {
      await fs.rm(hostShared, { recursive: true, force: true });
    }
  });
});
