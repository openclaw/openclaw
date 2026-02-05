import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readArtifactRegistry } from "./artifact-registry.js";
import { migrateSessionFileArtifactsIfNeeded } from "./session-artifact-migration.js";

describe("migrateSessionFileArtifactsIfNeeded", () => {
  it("externalizes legacy tool results and bumps transcript version", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-migrate-"));
    const sessionFile = path.join(dir, "session.jsonl");
    const header = {
      type: "session",
      version: 2,
      id: "session-1",
      timestamp: new Date().toISOString(),
      cwd: "/tmp",
    };
    const toolMessage = {
      type: "message",
      id: "msg-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        content: [{ type: "text", text: "legacy output" }],
      },
    };
    const content = `${JSON.stringify(header)}\n${JSON.stringify(toolMessage)}\n`;
    await fs.writeFile(sessionFile, content, "utf-8");

    const result = await migrateSessionFileArtifactsIfNeeded({
      sessionFile,
      sessionKey: "agent:main",
      sessionId: "session-1",
    });

    expect(result.migrated).toBe(true);
    expect(result.createdArtifacts).toBe(1);

    const updated = await fs.readFile(sessionFile, "utf-8");
    const entries = updated
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            version?: number;
            message?: {
              role?: string;
              details?: { artifactRef?: { id?: string } };
              content?: Array<{ text?: string }>;
            };
          },
      );

    expect(entries[0]?.type).toBe("session");
    expect(entries[0]?.version).toBe(3);

    const migratedTool = entries.find((entry) => entry.message?.role === "toolResult");
    expect(migratedTool?.message?.details?.artifactRef?.id).toBeTruthy();
    expect(migratedTool?.message?.content?.[0]?.text).toContain(
      "[Tool result omitted: stored as artifact]",
    );

    const registry = readArtifactRegistry(path.join(dir, "artifacts"));
    expect(registry).toHaveLength(1);
    expect(registry[0]?.sessionKey).toBe("agent:main");
  });
});
