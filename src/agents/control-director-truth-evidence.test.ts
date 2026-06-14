import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildControlDirectorTruthEvidenceFromRecords,
  loadControlDirectorTruthEvidence,
} from "./control-director-truth-evidence.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-truth-evidence-"));
  tempDirs.push(dir);
  return dir;
}

function toolResult(params: {
  command: string;
  output?: string | undefined;
  exitCode?: number | undefined;
}) {
  return {
    role: "toolResult",
    toolName: "bash",
    content: [{ type: "text", text: params.output ?? "" }],
    details: {
      command: params.command,
      exitCode: params.exitCode,
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Control Director runtime truth evidence ingestion", () => {
  it("creates command evidence only for exit code 0 tool results", () => {
    const evidence = buildControlDirectorTruthEvidenceFromRecords({
      records: [
        toolResult({ command: "pnpm test src/agents/foo.test.ts", exitCode: 0 }),
        toolResult({ command: "pnpm test failing.test.ts", exitCode: 1 }),
      ],
    });

    expect(evidence.filter((entry) => entry.type === "command")).toEqual([
      expect.objectContaining({
        source: "pnpm test src/agents/foo.test.ts",
        status: "passed",
        exitCode: 0,
      }),
    ]);
  });

  it("creates GitHub run evidence only for successful matching SHA metadata", () => {
    const matching = buildControlDirectorTruthEvidenceFromRecords({
      implementationSha: "afcb917bcf",
      records: [
        toolResult({
          command: "gh run view 27503423654 --json conclusion,headSha,databaseId",
          exitCode: 0,
          output: JSON.stringify({
            conclusion: "success",
            headSha: "afcb917bcf",
            databaseId: 27503423654,
          }),
        }),
      ],
    });
    const wrongSha = buildControlDirectorTruthEvidenceFromRecords({
      implementationSha: "expected-sha",
      records: [
        toolResult({
          command: "gh run view 27503423654 --json conclusion,headSha,databaseId",
          exitCode: 0,
          output: JSON.stringify({
            conclusion: "success",
            headSha: "other-sha",
            databaseId: 27503423654,
          }),
        }),
      ],
    });

    expect(matching).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "github_run",
          source: "github-actions",
          sha: "afcb917bcf",
        }),
      ]),
    );
    expect(wrongSha.some((entry) => entry.type === "github_run")).toBe(false);
  });

  it("creates UI smoke, repo change, and source citation evidence from tool records", () => {
    const evidence = buildControlDirectorTruthEvidenceFromRecords({
      records: [
        toolResult({
          command: "pnpm ui:smoke:control-director-no-response",
          exitCode: 0,
          output: JSON.stringify({
            ok: true,
            proofKind: "mobile web viewport proof",
            unsupportedCompleteDelivered: false,
          }),
        }),
        toolResult({
          command: "git diff -- src/agents/control-director-delivery-guards.ts",
          exitCode: 0,
          output:
            "diff --git a/src/agents/control-director-delivery-guards.ts b/src/agents/control-director-delivery-guards.ts",
        }),
        {
          role: "toolResult",
          toolName: "web_fetch",
          isError: false,
          content: [{ type: "text", text: "Source: https://example.test/proof" }],
        },
      ],
    });

    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "ui_smoke", source: "control-ui-smoke" }),
        expect.objectContaining({ type: "repo_change", source: "git" }),
        expect.objectContaining({ type: "source_citation", source: "web_fetch" }),
      ]),
    );
  });

  it("ignores assistant prose and reads capped session JSONL evidence", () => {
    const dir = makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({ role: "assistant", content: "Targeted tests passed." }),
        JSON.stringify(toolResult({ command: "pnpm test src/agents/foo.test.ts", exitCode: 0 })),
        "",
      ].join("\n"),
    );

    const evidence = loadControlDirectorTruthEvidence({
      sessionEntry: { sessionFile },
    });

    expect(evidence).toEqual([
      expect.objectContaining({
        type: "command",
        source: "pnpm test src/agents/foo.test.ts",
      }),
    ]);
  });
});
