import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createDaliLocalV1RetrieveContextTool,
  resolveDaliLocalV1WorkspacePaths,
} from "./dali-local-v1-tool.js";

type DaliLocalV1ExecFile = NonNullable<
  NonNullable<Parameters<typeof createDaliLocalV1RetrieveContextTool>[0]["deps"]>["execFile"]
>;

async function createWorkspaceFixture() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-dali-local-v1-"));
  const rootDir = path.join(workspaceDir, "dali-local-v1");
  const scriptPath = path.join(rootDir, "scripts", "dali_store.py");
  const dbPath = path.join(rootDir, "state", "dali.sqlite3");
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.writeFile(scriptPath, "#!/usr/bin/env python3\n", "utf8");
  await fs.writeFile(dbPath, "", "utf8");
  return { workspaceDir, rootDir, scriptPath, dbPath };
}

describe("resolveDaliLocalV1WorkspacePaths", () => {
  it("returns null when the workspace does not contain a local-v1 script and db", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-no-local-v1-"));
    expect(resolveDaliLocalV1WorkspacePaths(workspaceDir)).toBeNull();
  });

  it("finds the local-v1 workspace underneath the active workspace root", async () => {
    const fixture = await createWorkspaceFixture();
    expect(resolveDaliLocalV1WorkspacePaths(fixture.workspaceDir)).toEqual({
      rootDir: fixture.rootDir,
      scriptPath: fixture.scriptPath,
      dbPath: fixture.dbPath,
    });
  });
});

describe("createDaliLocalV1RetrieveContextTool", () => {
  it("returns null when the active workspace does not expose a usable local-v1 store", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-no-local-v1-"));
    expect(createDaliLocalV1RetrieveContextTool({ workspaceDir })).toBeNull();
  });

  it("shells out to the existing retrieve-context CLI path and returns its context text", async () => {
    const fixture = await createWorkspaceFixture();
    const execFile: DaliLocalV1ExecFile = vi.fn(async () => ({
      stdout: JSON.stringify({
        query: "agent memory defense",
        documents: [{ id: "doc-1", title: "Memory Safe Agents" }],
        reflections: [{ id: "ref-1" }],
        contextText:
          "[Document] Memory Safe Agents\nhash8: abc12345\nexcerpt 0: Consensus memory defense reduces poisoned-memory failures.",
      }),
      stderr: "",
    }));
    const tool = createDaliLocalV1RetrieveContextTool({
      workspaceDir: fixture.workspaceDir,
      deps: {
        execFile,
      },
    });

    expect(tool).not.toBeNull();
    const result = await tool!.execute("call_local_v1", {
      query: "agent memory defense",
      topic: "agent-memory",
      documentLimit: 2,
      chunkLimit: 1,
      reflectionLimit: 1,
      maxChars: 1000,
    });

    expect(execFile).toHaveBeenCalledWith(
      "python3",
      [
        fixture.scriptPath,
        "--root",
        fixture.rootDir,
        "retrieve-context",
        "--query",
        "agent memory defense",
        "--topic",
        "agent-memory",
        "--document-limit",
        "2",
        "--chunk-limit",
        "1",
        "--reflection-limit",
        "1",
        "--max-chars",
        "1000",
      ],
      {
        cwd: fixture.rootDir,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    expect(result.content[0]).toEqual({
      type: "text",
      text: 'Dali local-v1 retrieval for "agent memory defense"\n\n[Document] Memory Safe Agents\nhash8: abc12345\nexcerpt 0: Consensus memory defense reduces poisoned-memory failures.',
    });
    expect(result.details).toMatchObject({
      status: "ok",
      rootDir: fixture.rootDir,
      scriptPath: fixture.scriptPath,
      dbPath: fixture.dbPath,
      query: "agent memory defense",
    });
  });

  it("returns a failed tool payload when the CLI output is invalid", async () => {
    const fixture = await createWorkspaceFixture();
    const execFile: DaliLocalV1ExecFile = vi.fn(async () => ({
      stdout: "not-json",
      stderr: "",
    }));
    const tool = createDaliLocalV1RetrieveContextTool({
      workspaceDir: fixture.workspaceDir,
      deps: {
        execFile,
      },
    });

    const result = await tool!.execute("call_invalid_json", {
      query: "agent memory defense",
    });

    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("Dali local-v1 retrieval failed:"),
    });
    expect(result.details).toMatchObject({
      status: "failed",
      query: "agent memory defense",
      rootDir: fixture.rootDir,
      scriptPath: fixture.scriptPath,
      dbPath: fixture.dbPath,
    });
  });
});
