import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const persistMemoryDocumentCanonicalMock = vi.hoisted(() => vi.fn(async () => {}));
const readMemoryDocumentFromPostgresMock = vi.hoisted(() =>
  vi.fn<() => Promise<string | null>>(async () => null),
);
const scheduleMemoryDocumentSyncToPostgresMock = vi.hoisted(() => vi.fn());

vi.mock("../persistence/postgres-client.js", () => ({
  getRuntimePostgresPersistencePolicySync: () => ({
    enabled: true,
    exportCompatibility: false,
  }),
}));

vi.mock("../persistence/service.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../persistence/service.js")>();
  return {
    ...mod,
    persistMemoryDocumentCanonical: persistMemoryDocumentCanonicalMock,
    readMemoryDocumentFromPostgres: readMemoryDocumentFromPostgresMock,
    scheduleMemoryDocumentSyncToPostgres: scheduleMemoryDocumentSyncToPostgresMock,
  };
});

const { createHostWorkspaceEditTool, createHostWorkspaceWriteTool } =
  await import("./pi-tools.read.js");

describe("host memory tools avoid filesystem re-sync in postgres canonical mode", () => {
  let workspaceDir = "";

  beforeEach(async () => {
    persistMemoryDocumentCanonicalMock.mockClear();
    readMemoryDocumentFromPostgresMock.mockClear();
    scheduleMemoryDocumentSyncToPostgresMock.mockClear();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-host-memory-"));
  });

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
    }
  });

  it("writes MEMORY.md canonically without scheduling a filesystem sync", async () => {
    const tool = createHostWorkspaceWriteTool(workspaceDir, { agentId: "main" });

    await tool.execute(
      "call-write",
      {
        path: "MEMORY.md",
        content: "host canonical\n",
      },
      undefined,
    );

    expect(persistMemoryDocumentCanonicalMock).toHaveBeenCalledWith({
      workspaceRoot: workspaceDir,
      absolutePath: path.join(workspaceDir, "MEMORY.md"),
      logicalPath: "MEMORY.md",
      body: "host canonical\n",
      agentId: "main",
    });
    expect(scheduleMemoryDocumentSyncToPostgresMock).not.toHaveBeenCalled();
  });

  it("edits MEMORY.md canonically without scheduling a filesystem sync", async () => {
    readMemoryDocumentFromPostgresMock.mockResolvedValue("old text\n");
    const tool = createHostWorkspaceEditTool(workspaceDir, { agentId: "main" });

    await tool.execute(
      "call-edit",
      {
        path: "MEMORY.md",
        old_string: "old text",
        new_string: "new text",
      },
      undefined,
    );

    expect(readMemoryDocumentFromPostgresMock).toHaveBeenCalledWith({
      workspaceRoot: workspaceDir,
      logicalPath: "MEMORY.md",
      lookupMode: "runtime",
    });
    expect(persistMemoryDocumentCanonicalMock).toHaveBeenCalledWith({
      workspaceRoot: workspaceDir,
      absolutePath: path.join(workspaceDir, "MEMORY.md"),
      logicalPath: "MEMORY.md",
      body: "new text\n",
      agentId: "main",
    });
    expect(scheduleMemoryDocumentSyncToPostgresMock).not.toHaveBeenCalled();
  });
});
