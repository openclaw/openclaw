import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffArtifactStore } from "./store.js";
import { createDiffsTool } from "./tool.js";

describe("diffs tool", () => {
  let rootDir: string;
  let store: DiffArtifactStore;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-diffs-tool-"));
    store = new DiffArtifactStore({ rootDir });
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("returns a viewer URL in view mode", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      store,
    });

    const result = await tool.execute?.("tool-1", {
      before: "one\n",
      after: "two\n",
      path: "README.md",
      mode: "view",
    });

    const text = readTextContent(result, 0);
    expect(text).toContain("http://127.0.0.1:18789/plugins/diffs/view/");
    expect((result?.details as Record<string, unknown>).viewerUrl).toBeDefined();
  });

  it("returns an image artifact in image mode", async () => {
    const screenshotter = {
      screenshotHtml: vi.fn(async ({ outputPath }: { outputPath: string }) => {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, Buffer.from("png"));
        return outputPath;
      }),
    };

    const tool = createDiffsTool({
      api: createApi(),
      store,
      screenshotter,
    });

    const result = await tool.execute?.("tool-2", {
      before: "one\n",
      after: "two\n",
      mode: "image",
    });

    expect(screenshotter.screenshotHtml).toHaveBeenCalledTimes(1);
    expect(readTextContent(result, 0)).toContain("Diff image generated at:");
    expect(readTextContent(result, 0)).toContain("Use the `message` tool");
    expect(result?.content).toHaveLength(1);
    expect((result?.details as Record<string, unknown>).imagePath).toBeDefined();
  });

  it("falls back to view output when both mode cannot render an image", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      store,
      screenshotter: {
        screenshotHtml: vi.fn(async () => {
          throw new Error("browser missing");
        }),
      },
    });

    const result = await tool.execute?.("tool-3", {
      before: "one\n",
      after: "two\n",
      mode: "both",
    });

    expect(result?.content).toHaveLength(1);
    expect(readTextContent(result, 0)).toContain("Image rendering failed");
    expect((result?.details as Record<string, unknown>).imageError).toBe("browser missing");
  });

  it("rejects invalid base URLs as tool input errors", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      store,
    });

    await expect(
      tool.execute?.("tool-4", {
        before: "one\n",
        after: "two\n",
        mode: "view",
        baseUrl: "javascript:alert(1)",
      }),
    ).rejects.toThrow("Invalid baseUrl");
  });
});

function createApi(): OpenClawPluginApi {
  return {
    id: "diffs",
    name: "Diffs",
    description: "Diffs",
    source: "test",
    config: {
      gateway: {
        port: 18789,
        bind: "loopback",
      },
    },
    runtime: {} as OpenClawPluginApi["runtime"],
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    registerTool() {},
    registerHook() {},
    registerHttpHandler() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    resolvePath(input: string) {
      return input;
    },
    on() {},
  };
}

function readTextContent(result: unknown, index: number): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)
    ?.content;
  const entry = content?.[index];
  return entry?.type === "text" ? (entry.text ?? "") : "";
}
