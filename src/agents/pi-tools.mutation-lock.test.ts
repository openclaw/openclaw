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
      bindMounts: ["/var/shared:/data:rw"],
    });

    const p1 = wrapped.execute("call-1", { path: "/data/shared.txt", content: "one" });
    const p2 = wrapped.execute("call-2", {
      path: "/var/shared/shared.txt",
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
      "start:/var/shared/shared.txt",
      "end:/var/shared/shared.txt",
    ]);
  });

  it("normalizes root-mounted bind paths into shared lock keys", async () => {
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
        if (filePath === "/shared/root.txt") {
          await gate.promise;
        }
        events.push(`end:${filePath}`);
        return textResult(filePath);
      },
    };

    const wrapped = wrapToolMutationLock(base, process.cwd(), {
      containerWorkdir: "/agent",
      bindMounts: ["/var/shared:/:rw"],
    });

    const p1 = wrapped.execute("call-1", { path: "/shared/root.txt", content: "one" });
    const p2 = wrapped.execute("call-2", {
      path: "/var/shared/shared/root.txt",
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
      "start:/var/shared/shared/root.txt",
      "end:/var/shared/shared/root.txt",
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
});
