import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenClawCodingTools } from "./pi-tools.js";

describe("tool filesystem permissions from exec approvals", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let outsideFile: string;
  let previousOpenClawHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fs-perms-"));
    workspaceDir = path.join(tmpDir, "workspace");
    outsideFile = path.join(tmpDir, "outside.txt");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "inside.txt"), "inside", "utf8");
    await fs.writeFile(outsideFile, "outside", "utf8");

    previousOpenClawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = tmpDir;
    const approvalsPath = path.join(tmpDir, ".openclaw", "exec-approvals.json");
    await fs.mkdir(path.dirname(approvalsPath), { recursive: true });
    await fs.writeFile(
      approvalsPath,
      `${JSON.stringify(
        {
          version: 1,
          permissions: {
            filesystem: {
              rules: {
                [`${workspaceDir.replace(/\\/g, "/")}/**`]: "rw-",
              },
              default: "---",
            },
          },
          agents: {},
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  });

  afterEach(async () => {
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("allows read inside the allowed workspace rule", async () => {
    const tools = createOpenClawCodingTools({
      workspaceDir,
      config: { tools: { fs: { workspaceOnly: false } } },
    });
    const readTool = tools.find((tool) => tool.name === "read");
    expect(readTool).toBeDefined();

    await expect(
      readTool!.execute("read-inside", {
        path: path.join(workspaceDir, "inside.txt"),
      }),
    ).resolves.toBeDefined();
  });

  it("blocks read and write outside allowed rules", async () => {
    const tools = createOpenClawCodingTools({
      workspaceDir,
      config: { tools: { fs: { workspaceOnly: false } } },
    });
    const readTool = tools.find((tool) => tool.name === "read");
    const writeTool = tools.find((tool) => tool.name === "write");
    expect(readTool).toBeDefined();
    expect(writeTool).toBeDefined();

    await expect(
      readTool!.execute("read-outside", {
        path: outsideFile,
      }),
    ).rejects.toThrow(/filesystem permission denied \(r\)/);
    await expect(
      writeTool!.execute("write-outside", {
        path: outsideFile,
        content: "blocked",
      }),
    ).rejects.toThrow(/filesystem permission denied \(w\)/);
  });
});
