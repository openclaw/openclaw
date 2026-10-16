import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { describe, expect, it } from "vitest";
import { projectCodexCatalogNativeThread } from "./session-catalog-native-projection.js";
import { projectCodexCatalogPage } from "./session-catalog-projection.js";

describe("projectCodexCatalogNativeThread string bounds", () => {
  it("drops a surrogate pair split by the originator bound", () => {
    const row = projectCodexCatalogNativeThread(
      { id: "t1", originator: `${"s".repeat(499)}🙂` },
      sanitizeTerminalText,
    );
    expect(row.originator).toBe("s".repeat(499));
  });

  it("admits a custom source with a complete surrogate pair at its bound", () => {
    const custom = `${"s".repeat(498)}🙂`;
    const row = projectCodexCatalogNativeThread(
      { id: "t1", source: { custom } },
      sanitizeTerminalText,
    );
    expect(row.source).toEqual({ custom });
  });

  it("carries bounded native fields into the displayed catalog", async () => {
    const thread = projectCodexCatalogNativeThread(
      {
        id: " thread-1 ",
        sessionId: " native-session ",
        name: " Title ",
        preview: "\u001b[31mFirst\nrequest\u001b[0m",
        cwd: " /workspace/project ",
        modelProvider: "p".repeat(501),
        cliVersion: " 0.155.0 ",
        gitInfo: { branch: " main " },
        createdAt: 100,
        updatedAt: Number.NaN,
        recencyAt: null,
        source: "cli",
        status: { type: "active", activeFlags: [" waitingOnApproval ", "", 42] },
      },
      sanitizeTerminalText,
    );
    const page = await projectCodexCatalogPage({ data: [thread] });
    expect(page.rows[0]?.page.sessions).toEqual([
      {
        threadId: "thread-1",
        sessionId: "native-session",
        name: "Title",
        cwd: "/workspace/project",
        source: "cli",
        status: "active",
        activeFlags: ["waitingOnApproval"],
        createdAt: 100,
        recencyAt: null,
        modelProvider: "p".repeat(500),
        cliVersion: "0.155.0",
        gitBranch: "main",
        archived: false,
      },
    ]);
    expect(page.rows[0]?.preview).toBe("First request");
  });
});
