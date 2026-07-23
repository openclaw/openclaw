import { describe, expect, it } from "vitest";
import { projectCodexNativeExecutionReceipts } from "./native-subagent-execution-receipts.js";

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
});
