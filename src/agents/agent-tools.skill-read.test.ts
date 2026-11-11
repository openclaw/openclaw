import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { wrapReadToolWithSkillContent } from "./agent-tools.skill-read.js";
import { createReadTool } from "./sessions/tools/read.js";
import type { ReadToolDetails } from "./sessions/tools/tool-contracts.js";
import { getTextContent as extractToolText } from "./test-helpers/agent-tools-fs-helpers.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { createContainerWorkspaceSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const skillLocator = "/skills/pond/SKILL.md";
const skillContent = "# Pond\ncomplete instructions";
const fullSkillResult: AgentToolResult<ReadToolDetails> = {
  content: [{ type: "text", text: skillContent }],
  details: { kind: "text", content: skillContent },
};

function skillReadTool(execute: Parameters<typeof wrapReadToolWithSkillContent>[0]["execute"]) {
  return wrapReadToolWithSkillContent(
    {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: Type.Object({ path: Type.String() }),
      execute,
    },
    [{ filePath: skillLocator }],
    { instructionDeliveryCache: new Map<string, Promise<boolean>>() },
  );
}

async function fileFixture(relativePath: string, content: string | Uint8Array) {
  const root = tempDirs.make("openclaw-tool-file-");
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return { root, filePath };
}

function requireTool(tools: ReturnType<typeof createOpenClawCodingTools>, name: string) {
  return expectDefined(
    tools.find((candidate) => candidate.name === name),
    `expected ${name} tool`,
  );
}

describe("recognized skill reads", () => {
  it.each([
    ["multi-page node", "node", `${"ok\n".repeat(2_100)}done`, false],
    ["oversized local", "local", `# Pond\n${"x".repeat(33 * 1024)}`, true],
  ] as const)(
    "serves %s skill instructions as bounded pages",
    async (_name, backend, content, oversized) => {
      const virtual = backend === "node";
      const baseDir = virtual
        ? "node://node-1/skills/pond"
        : tempDirs.make("openclaw-assembled-local-skill-");
      const locator = virtual ? `${baseDir}/SKILL.md` : path.join(baseDir, "SKILL.md");
      if (!virtual) {
        await fs.writeFile(locator, content, "utf8");
      }
      const tools = createOpenClawCodingTools({
        config: { tools: { fs: { workspaceOnly: true } } },
        skillsSnapshot: {
          prompt: "",
          skills: [{ name: "pond" }],
          resolvedSkills: [
            {
              name: "pond",
              description: "Pond skill",
              filePath: locator,
              baseDir,
              ...(virtual ? { readContent: content } : {}),
              source: virtual ? "openclaw-node" : "test",
              sourceInfo: {
                source: virtual ? "openclaw-node" : "test",
                path: locator,
                scope: "temporary",
                origin: "top-level",
              },
              disableModelInvocation: false,
            },
          ],
        },
      });

      const result = await requireTool(tools, "read").execute("whole-skill-read", {
        path: locator,
      });

      expect(result.details).toMatchObject({
        kind: "skill_page",
        startByte: 0,
        totalBytes: Buffer.byteLength(content),
      });
      if (oversized) {
        expect(result.details).toMatchObject({ nextCursor: expect.any(String) });
        expect(extractToolText(result)).toContain("# Pond");
      } else {
        expect(result.details).toMatchObject({ content, nextCursor: null });
      }
    },
  );

  it("protects materialized sandbox skill identities when no skill snapshot exists", async () => {
    const relativePath = "skills/demo/SKILL.md";
    const { root, filePath } = await fileFixture(relativePath, "# Demo\ncomplete instructions");
    const sandbox = createAgentToolsSandboxContext({
      workspaceDir: root,
      fsBridge: createContainerWorkspaceSandboxFsBridge(root),
    });
    const tools = createOpenClawCodingTools({
      sandbox,
      skillUsagePaths: [
        {
          readPath: `/workspace/${relativePath}`,
          skillFile: filePath,
          skillName: "demo",
          skillSource: "workspace",
        },
      ],
    });
    const read = requireTool(tools, "read");

    expect(extractToolText(await read.execute("sandbox-skill", { path: relativePath }))).toContain(
      "# Demo\ncomplete instructions",
    );
    for (const window of [{ offset: 2 }, { limit: 1 }, { cursor: 0 }]) {
      expect(
        (
          await read.execute("sandbox-skill-window", {
            path: `/workspace/${relativePath}`,
            ...window,
          })
        ).details,
      ).toMatchObject({
        kind: "skill_page",
        content: "# Demo\ncomplete instructions",
        startByte: 0,
        nextCursor: null,
      });
    }
  });

  it("does not cache a paginated first page or EOF suffix as a whole delivery", async () => {
    const content = "😀\r\n".repeat(1500);
    const cache = new Map<string, Promise<boolean>>();
    const tool = wrapReadToolWithSkillContent(
      createReadTool("/"),
      [{ filePath: "node://test/SKILL.md", readContent: content }],
      {
        instructionDeliveryCache: cache,
        modelContextWindowTokens: 2000,
      },
    );
    let cursor: string | undefined;
    let restored = "";
    do {
      const result = await tool.execute("page", {
        path: "node://test/SKILL.md",
        cursor: cursor ?? 0,
        offset: 2,
        limit: 1,
      });
      if (result.details.kind !== "skill_page") {
        throw new Error("Expected skill page");
      }
      restored += result.details.content;
      cursor = result.details.nextCursor ?? undefined;
      expect(cache.size).toBe(0);
    } while (cursor);
    expect(restored).toBe(content);
    await expect(
      tool.execute("invalid", { path: "node://test/SKILL.md", cursor: "0", offset: 2 }),
    ).rejects.toThrow("Invalid or stale skill cursor");
    expect((await tool.execute("restart", { path: "node://test/SKILL.md" })).details).toMatchObject(
      { startByte: 0 },
    );
  });

  it("deduplicates sequential and concurrent successful skill reads within one attempt", async () => {
    const locator = skillLocator;
    let releaseRead = (): void => undefined;
    const pendingRead = new Promise<AgentToolResult<ReadToolDetails>>((resolve) => {
      releaseRead = () => resolve(fullSkillResult);
    });
    const execute = vi.fn(() => pendingRead);
    const tool = skillReadTool(execute);

    const first = tool.execute("first-skill-read", { path: locator });
    const concurrent = tool.execute("concurrent-skill-read", { path: locator });
    expect(execute).toHaveBeenCalledTimes(1);
    releaseRead();

    expect(extractToolText(await first)).toContain("# Pond\ncomplete instructions");
    expect(extractToolText(await concurrent)).toContain("already served whole");
    expect(
      extractToolText(await tool.execute("sequential-skill-read", { path: locator })),
    ).toContain("already served whole");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("retries skill reads after failures, whole-read refusals, and optional misses", async () => {
    const locator = skillLocator;
    const truncatedResult: AgentToolResult<ReadToolDetails> = {
      content: [{ type: "text", text: "partial" }],
      details: {
        kind: "truncated",
        content: "partial",
        continuation: { kind: "line", offset: 2 },
        truncation: {
          truncated: true,
          truncatedBy: "lines",
          totalLines: 2,
          totalBytes: 16,
          outputLines: 1,
          outputBytes: 7,
          lastLinePartial: false,
          firstLineExceedsLimit: false,
          maxLines: 1,
          maxBytes: 32_768,
        },
      },
    };
    const notFoundResult: AgentToolResult<ReadToolDetails> = {
      content: [{ type: "text", text: `Optional file not found: ${locator}.` }],
      details: { kind: "not_found", status: "not_found", path: locator, optional: true },
    };
    const execute = vi
      .fn<() => Promise<AgentToolResult<ReadToolDetails>>>()
      .mockRejectedValueOnce(new Error("transient read failure"))
      .mockResolvedValueOnce(truncatedResult)
      .mockResolvedValueOnce(notFoundResult)
      .mockResolvedValueOnce(fullSkillResult);
    const tool = skillReadTool(execute);

    await expect(tool.execute("failed-skill-read", { path: locator })).rejects.toThrow(
      "transient read failure",
    );
    await expect(tool.execute("oversized-skill-read", { path: locator })).rejects.toThrow(
      "truncated document",
    );
    expect(
      extractToolText(
        await tool.execute("optional-missing-skill-read", { path: locator, optional: true }),
      ),
    ).toContain("Optional file not found");
    expect(extractToolText(await tool.execute("retried-skill-read", { path: locator }))).toContain(
      "# Pond\ncomplete instructions",
    );
    expect(execute).toHaveBeenCalledTimes(4);
  });
});
