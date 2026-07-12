import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { loadMcpAppView, MCP_APP_VIEW_ID_PATTERN, storeMcpAppView } from "./mcp-app-view-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createDatabasePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mcp-app-view-"));
  tempDirs.push(dir);
  return path.join(dir, "state", "openclaw.sqlite");
}

function createViewPayload() {
  return {
    serverName: "diagrams",
    toolName: "create_view",
    resource: {
      uri: "ui://diagrams/app.html",
      mimeType: "text/html;profile=mcp-app",
      html: "<!doctype html><html><body>diagram</body></html>",
      csp: { connectDomains: ["https://api.example.com"] },
      permissions: ["clipboardWrite"],
      prefersBorder: true,
    },
    toolInput: { shape: "circle" },
    result: {
      content: [{ type: "text", text: "rendered" }],
      structuredContent: { status: "ready" },
      _meta: { source: "server" },
    },
  };
}

describe("MCP App view store", () => {
  it("persists a bounded opaque descriptor and reloads its payload after the database reopens", async () => {
    const databasePath = await createDatabasePath();
    const descriptor = storeMcpAppView(createViewPayload(), {
      databasePath,
      nowMs: 1_000,
    });

    expect(descriptor).toMatchObject({
      serverName: "diagrams",
      toolName: "create_view",
      resourceUri: "ui://diagrams/app.html",
    });
    expect(descriptor?.viewId).toMatch(MCP_APP_VIEW_ID_PATTERN);
    expect(Buffer.byteLength(JSON.stringify(descriptor), "utf8")).toBeLessThan(512);

    closeOpenClawStateDatabaseForTest();

    expect(loadMcpAppView(descriptor?.viewId ?? "", { databasePath, nowMs: 2_000 })).toEqual(
      createViewPayload(),
    );
  });

  it("does not return expired views", async () => {
    const databasePath = await createDatabasePath();
    const descriptor = storeMcpAppView(createViewPayload(), {
      databasePath,
      nowMs: 1_000,
      ttlMs: 100,
    });

    expect(loadMcpAppView(descriptor?.viewId ?? "", { databasePath, nowMs: 1_099 })).toBeDefined();
    expect(
      loadMcpAppView(descriptor?.viewId ?? "", { databasePath, nowMs: 1_100 }),
    ).toBeUndefined();
    expect(
      loadMcpAppView(descriptor?.viewId ?? "", { databasePath, nowMs: 1_099 }),
    ).toBeUndefined();
  });

  it("rejects oversized descriptor fields and payloads outside the total byte budget", async () => {
    const databasePath = await createDatabasePath();
    const oversizedUri = createViewPayload();
    oversizedUri.resource.uri = `ui://${"x".repeat(2_049)}`;

    expect(storeMcpAppView(oversizedUri, { databasePath })).toBeUndefined();
    expect(
      storeMcpAppView(createViewPayload(), { databasePath, maxTotalBytes: 100 }),
    ).toBeUndefined();
  });

  it("evicts the oldest views when the entry budget is exceeded", async () => {
    const databasePath = await createDatabasePath();
    const first = storeMcpAppView(createViewPayload(), {
      databasePath,
      nowMs: 1_000,
      maxEntries: 2,
    });
    const second = storeMcpAppView(createViewPayload(), {
      databasePath,
      nowMs: 2_000,
      maxEntries: 2,
    });
    const third = storeMcpAppView(createViewPayload(), {
      databasePath,
      nowMs: 3_000,
      maxEntries: 2,
    });

    expect(loadMcpAppView(first?.viewId ?? "", { databasePath, nowMs: 3_001 })).toBeUndefined();
    expect(loadMcpAppView(second?.viewId ?? "", { databasePath, nowMs: 3_001 })).toBeDefined();
    expect(loadMcpAppView(third?.viewId ?? "", { databasePath, nowMs: 3_001 })).toBeDefined();
  });
});
