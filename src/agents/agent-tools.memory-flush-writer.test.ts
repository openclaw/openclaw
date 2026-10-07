/**
 * The memory flush warning must reflect the final authorized tool list.
 * tools.deny and the rest of the policy pipeline run after the flush surface is
 * assembled, so a run can hold `write` there and still lose it before dispatch.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const warnings = vi.hoisted(() => [] as string[]);

vi.mock("../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logger.js")>();
  return {
    ...actual,
    logWarn: (message: unknown, ...rest: unknown[]) => {
      warnings.push(String(message));
      return actual.logWarn(message as never, ...(rest as never[]));
    },
  };
});

import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";

const MEMORY_PATH = "memory/2026-08-22.md";

describe("memory flush writer availability", () => {
  afterEach(() => {
    warnings.length = 0;
  });

  it("warns when tools.deny removes write after the flush surface is built", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-deny-"));
    try {
      const tools = createOpenClawCodingTools({
        workspaceDir,
        config: { tools: { deny: ["write"] } },
        trigger: "memory",
        memoryFlushWritePath: MEMORY_PATH,
        senderIsOwner: true,
      });

      expect(tools.some((tool) => tool.name === "write")).toBe(false);
      expect(
        warnings.some((line) => line.includes(`memory flush cannot persist ${MEMORY_PATH}`)),
      ).toBe(true);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("stays quiet when the transport was never meant to carry write", async () => {
    // TOOL_ALLOW_BY_MESSAGE_PROVIDER.node lists only canvas, pdf, tts, view_image,
    // web_fetch and web_search, so every node-originated flush loses the writer by
    // design. Warning here would fire on an intended configuration on every flush.
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-node-"));
    try {
      const tools = createOpenClawCodingTools({
        workspaceDir,
        trigger: "memory",
        memoryFlushWritePath: MEMORY_PATH,
        messageProvider: "node",
        senderIsOwner: true,
      });

      expect(tools.some((tool) => tool.name === "write")).toBe(false);
      expect(warnings.some((line) => line.includes("memory flush cannot persist"))).toBe(false);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("stays quiet when the flush run keeps its writer", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-ok-"));
    try {
      const tools = createOpenClawCodingTools({
        workspaceDir,
        trigger: "memory",
        memoryFlushWritePath: MEMORY_PATH,
        senderIsOwner: true,
      });

      expect(tools.some((tool) => tool.name === "write")).toBe(true);
      expect(warnings.some((line) => line.includes("memory flush cannot persist"))).toBe(false);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("memory flush CLI write boundary", () => {
  function flushTools(workspaceDir: string) {
    const tools = createOpenClawCodingTools({
      workspaceDir,
      trigger: "memory",
      memoryFlushWritePath: MEMORY_PATH,
      senderIsOwner: true,
    });
    const write = tools.find((tool) => tool.name === "write");
    expect(write).toBeDefined();
    return write!;
  }

  it("appends to the prepared memory target", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-append-"));
    try {
      const write = flushTools(workspaceDir);
      const controller = new AbortController();
      await write.execute(
        "call-1",
        { path: MEMORY_PATH, content: "first note\n" },
        controller.signal,
      );
      await write.execute(
        "call-2",
        { path: MEMORY_PATH, content: "second note\n" },
        controller.signal,
      );

      const written = await fs.readFile(path.join(workspaceDir, MEMORY_PATH), "utf8");
      expect(written).toBe("first note\nsecond note\n");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects a different-path write before filesystem I/O", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-deny-path-"));
    try {
      const write = flushTools(workspaceDir);
      const controller = new AbortController();
      await expect(
        write.execute(
          "call-1",
          { path: "memory/other.md", content: "sneaky\n" },
          controller.signal,
        ),
      ).rejects.toThrow(`Memory flush writes are restricted to ${MEMORY_PATH}`);
      // The rejection happens before any filesystem I/O: neither the
      // forbidden path nor the prepared target may exist.
      await expect(fs.stat(path.join(workspaceDir, "memory/other.md"))).rejects.toThrow();
      await expect(fs.stat(path.join(workspaceDir, MEMORY_PATH))).rejects.toThrow();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("fails closed when a memory trigger carries no write target", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-no-target-"));
    try {
      // This is the Gateway loopback invariant: a memory trigger without the
      // host-minted target must never produce an unrestricted writer.
      expect(() =>
        createOpenClawCodingTools({
          workspaceDir,
          trigger: "memory",
          senderIsOwner: true,
        }),
      ).toThrow("memoryFlushWritePath required for memory-triggered tool runs");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
