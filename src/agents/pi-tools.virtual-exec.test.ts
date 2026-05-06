import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSqliteVirtualAgentFs } from "./filesystem/virtual-agent-fs.sqlite.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

function createTempDbPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vfs-exec-tool-"));
  return path.join(root, "state", "openclaw.sqlite");
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("VFS-backed exec tool", () => {
  it("projects scratch to disk and syncs foreground command output back", async () => {
    const scratch = createSqliteVirtualAgentFs({
      agentId: "main",
      namespace: "scratch",
      path: createTempDbPath(),
      now: () => 1000,
    });
    const tools = createOpenClawCodingTools({
      workspaceDir: "/virtual/workspace",
      agentFilesystem: { scratch },
      config: {
        tools: {
          exec: {
            security: "full",
            ask: "off",
          },
        },
      },
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: true,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    });
    const execTool = tools.find((tool) => tool.name === "exec");

    expect(execTool).toBeDefined();
    await execTool?.execute("call-exec", {
      command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('out.txt','hello vfs exec')"`,
    });

    expect(scratch.readFile("/out.txt").toString("utf8")).toBe("hello vfs exec");
  });
});
