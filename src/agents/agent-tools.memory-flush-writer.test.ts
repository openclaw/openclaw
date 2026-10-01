import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

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
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => {
    warnings.length = 0;
  });

  it.each([
    {
      name: "denied by policy",
      config: { tools: { deny: ["write"] } },
      messageProvider: undefined,
      writable: false,
      warning: true,
    },
    {
      name: "excluded by transport",
      config: undefined,
      messageProvider: "node",
      writable: false,
      warning: false,
    },
    {
      name: "available",
      config: undefined,
      messageProvider: undefined,
      writable: true,
      warning: false,
    },
  ])("reports a writer $name", ({ config, messageProvider, writable, warning }) => {
    const tools = createOpenClawCodingTools({
      workspaceDir: tempDirs.make("openclaw-flush-writer-"),
      config,
      messageProvider,
      trigger: "memory",
      memoryFlushWritePath: MEMORY_PATH,
      senderIsOwner: true,
    });
    expect(tools.some((tool) => tool.name === "write")).toBe(writable);
    const flushWarnings = warnings.filter((line) => line.includes("memory flush cannot persist"));
    expect(flushWarnings).toEqual(warning ? [expect.stringContaining(MEMORY_PATH)] : []);
  });
});
