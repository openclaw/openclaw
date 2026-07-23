import { describe, expect, it } from "vitest";
import { projectCodexNativeExecutionReceipts } from "./native-subagent-execution-receipts.js";
import type { JsonObject } from "./protocol.js";

describe("projectCodexNativeExecutionReceipts", () => {
  it("projects readable diff evidence from the completed file-change item, not prose", () => {
    const receipts = projectCodexNativeExecutionReceipts({
      id: "change-1",
      type: "fileChange",
      status: "completed",
      text: "I created a PR and deployed green",
      changes: [
        { path: "src/worker.ts", kind: "update" },
        { path: "src/worker.test.ts", kind: "add" },
      ],
    });

    expect(receipts).toEqual([
      {
        kind: "diff",
        status: "ok",
        summary: "Codex file-change item produced a readable diff.",
        detail: {
          source: "codex-app-server-item",
          itemId: "change-1",
          readable: true,
          changes: [
            { path: "src/worker.ts", kind: "update" },
            { path: "src/worker.test.ts", kind: "add" },
          ],
        },
      },
    ]);
    expect(receipts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "pr" }),
        expect.objectContaining({ kind: "deploy" }),
      ]),
    );
  });

  it("projects command artifacts from command metadata without persisting command output", () => {
    const receipts = projectCodexNativeExecutionReceipts({
      id: "command-1",
      type: "commandExecution",
      status: "completed",
      command: "git commit -m lifecycle && pnpm test",
      cwd: "/workspace",
      exitCode: 0,
      aggregatedOutput: "Authorization: Bearer raw-secret-value",
    });

    expect(receipts.map((receipt) => receipt.kind)).toEqual(["commit", "tests"]);
    expect(JSON.stringify(receipts)).not.toContain("raw-secret-value");
    expect(receipts[0]?.detail).toMatchObject({
      source: "codex-app-server-command",
      itemId: "command-1",
      cwd: "/workspace",
      exitCode: 0,
      commandFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
  });

  it.each<{ label: string; item: JsonObject; kind: string }>([
    {
      label: "dynamic deploy with success=false",
      item: {
        id: "dynamic-deploy-failed",
        type: "dynamicToolCall",
        status: "completed",
        tool: "deploy_site",
        success: false,
      },
      kind: "deploy",
    },
    {
      label: "MCP deploy with an error payload",
      item: {
        id: "mcp-deploy-failed",
        type: "mcpToolCall",
        status: "completed",
        server: "sites",
        tool: "deploy_site",
        error: { message: "deployment failed" },
      },
      kind: "deploy",
    },
    {
      label: "commit command with error status",
      item: {
        id: "commit-failed",
        type: "commandExecution",
        status: "ERROR",
        command: "git commit -m lifecycle",
        exitCode: 0,
      },
      kind: "commit",
    },
    ...(["blocked", "cancelled", "canceled"] as const).map((status) => ({
      label: `test command with ${status} status`,
      item: {
        id: `tests-${status}`,
        type: "commandExecution",
        status,
        command: "pnpm test",
        exitCode: 0,
      },
      kind: "tests",
    })),
  ])("never projects ok artifact evidence for $label", ({ item, kind }) => {
    const receipts = projectCodexNativeExecutionReceipts(item);

    expect(receipts).toEqual([
      expect.objectContaining({
        kind,
        status: "error",
      }),
    ]);
    expect(receipts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "ok" })]),
    );
  });
});
