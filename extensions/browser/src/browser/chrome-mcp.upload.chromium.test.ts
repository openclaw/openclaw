import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR } from "openclaw/plugin-sdk/text-utility-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import * as fixture from "./chrome-mcp.chromium.test-support.js";
import { DEFAULT_UPLOAD_DIR } from "./paths.js";

const server = await vi.hoisted(async () => {
  const { randomUUID: fixtureId } = await import("node:crypto");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = join(tmpdir(), `openclaw-mcp-upload-${fixtureId()}`);
  return {
    root,
    tempDir: join(root, "server"),
    stateDir: join(root, "state"),
    browserDir: join(root, "browser"),
  };
});
vi.mock("openclaw/plugin-sdk/text-utility-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/text-utility-runtime")>()),
  CONFIG_DIR: server.stateDir,
}));
vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>()),
  resolvePreferredOpenClawTmpDir: () => server.browserDir,
}));
// Keep the real MCP subprocess and protocol, but give the server a separate
// temp root so a test home under /tmp cannot accidentally hide this regression.
vi.mock("@modelcontextprotocol/client/stdio", async (importOriginal) => {
  const original = await importOriginal<typeof import("@modelcontextprotocol/client/stdio")>();
  return {
    ...original,
    StdioClientTransport: class extends original.StdioClientTransport {
      constructor(options: ConstructorParameters<typeof original.StdioClientTransport>[0]) {
        super({
          ...options,
          env: {
            ...options.env,
            TMPDIR: server.tempDir,
            TEMP: server.tempDir,
            TMP: server.tempDir,
          },
        });
      }
    },
  };
});

describe.runIf(process.env.OPENCLAW_BROWSER_MCP_E2E === "1")("Chrome MCP upload roots", () => {
  it("uploads both accepted sources and rejects outside paths without changing the selection", async () => {
    await fs.mkdir(server.tempDir, { recursive: true });
    onTestFinished(() => fs.rm(server.root, { recursive: true, force: true }));
    const inbound = path.join(CONFIG_DIR, "media", "inbound");
    const name = `upload-${randomUUID()}.txt`;
    const files = [path.join(inbound, name), path.join(DEFAULT_UPLOAD_DIR, name)];
    const outside = path.join(CONFIG_DIR, name);
    for (const file of [...files, outside]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "synthetic upload fixture");
    }
    await fixture.withMcpBrowser(async ({ page, profile, profileName }) => {
      await page.setContent('<input type="file" aria-label="Upload" multiple>');
      const routes = fixture.mcpRoutes(profileName, profile, true);
      const snapshot = await fixture.routeSnapshot(routes);
      const ref = Object.entries(snapshot.refs).find(([, value]) => value.name === "Upload")?.[0];
      expect(ref).toBeTypeOf("string");
      const upload = (paths: string[]) =>
        fixture.routePost(routes, "/hooks/file-chooser", {
          targetId: snapshot.targetId,
          ref,
          paths,
        });
      const selected = () =>
        page
          .locator('input[type="file"]')
          .evaluate((input: HTMLInputElement) =>
            Array.from(input.files ?? [], (file) => ({ name: file.name, size: file.size })),
          );
      for (const file of files) {
        const response = await upload([file]);
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        expect(await selected()).toEqual([{ name, size: 24 }]);
      }
      const response = await upload([outside]);
      expect(response.statusCode).toBe(400);
      expect(await selected()).toEqual([{ name, size: 24 }]);
      if (process.platform !== "win32") {
        const link = path.join(inbound, `link-${name}`);
        await fs.symlink(outside, link);
        expect((await upload([link])).statusCode).toBe(400);
        expect(await selected()).toEqual([{ name, size: 24 }]);
      }
    }, "mcp-upload-roots-proof");
  }, 120_000);
});
