import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { applyControlDirectorDeliveryGuards } from "./control-director-delivery-guards.js";

const tempDirs: string[] = [];

function makeTempSessionFile(records: readonly unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-delivery-guard-"));
  tempDirs.push(dir);
  const sessionFile = path.join(dir, "session.jsonl");
  fs.writeFileSync(sessionFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return sessionFile;
}

function commandRecord(command: string, exitCode: number): unknown {
  return {
    role: "toolResult",
    toolName: "bash",
    content: [{ type: "text", text: `${command} finished` }],
    details: { command, exitCode },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Control Director delivery truth evidence ingestion", () => {
  it("allows supported verification claims from session command evidence", async () => {
    const text = [
      "Verified state: targeted tests passed.",
      "Targeted tests passed.",
      "Next build gap: no remaining test proof gap.",
      "Completion Grade: 8/10",
      "Criticality: 10/10",
      "Status: blocked",
    ].join("\n");
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      sessionFile: makeTempSessionFile([commandRecord("pnpm test src/agents/foo.test.ts", 0)]),
    };

    const result = await applyControlDirectorDeliveryGuards({
      agentId: "main",
      payloads: [{ text }],
      finalAssistantVisibleText: text,
      sessionId: "session-1",
      sessionEntry,
      requestBody: "Run targeted tests.",
      queueContinuation: false,
    });

    expect(result.payloads).toEqual([{ text }]);
    expect(result.truthAudit).toMatchObject({
      status: "passed",
      payloadsChecked: 1,
      payloadsRewritten: 0,
      claims: expect.arrayContaining([
        expect.objectContaining({
          claimType: "verification",
          requiredEvidenceType: "command",
          matchStatus: "matched",
        }),
      ]),
    });
  });

  it("blocks verification claims when session command evidence failed", async () => {
    const text = [
      "Verified state: targeted tests passed.",
      "Targeted tests passed.",
      "Next build gap: no remaining test proof gap.",
      "Completion Grade: 8/10",
      "Criticality: 10/10",
      "Status: blocked",
    ].join("\n");
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      sessionFile: makeTempSessionFile([commandRecord("pnpm test src/agents/foo.test.ts", 1)]),
    };

    const result = await applyControlDirectorDeliveryGuards({
      agentId: "control-director",
      payloads: [{ text }],
      finalAssistantVisibleText: text,
      sessionId: "session-1",
      sessionEntry,
      requestBody: "Run targeted tests.",
      queueContinuation: false,
    });

    expect(result.payloads[0]?.text).toContain("truth gate blocked");
    expect(result.payloads[0]?.text).toContain(
      "Missing evidence: command evidence with exit code 0",
    );
    expect(result.truthAudit).toMatchObject({
      status: "blocked",
      payloadsChecked: 1,
      payloadsRewritten: 1,
    });
  });
});
