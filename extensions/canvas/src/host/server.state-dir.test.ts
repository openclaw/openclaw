import fs from "node:fs/promises";
import path from "node:path";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { beforeAll, describe, expect, it } from "vitest";

describe("canvas host state dir defaults", () => {
  let createCanvasHostHandler: typeof import("./server.js").createCanvasHostHandler;

  beforeAll(async () => {
    ({ createCanvasHostHandler } = await import("./server.js"));
  });

  it("uses a temp materialization root by default", async () => {
    await withStateDirEnv("openclaw-canvas-state-", async ({ stateDir }) => {
      const handler = await createCanvasHostHandler({
        runtime: defaultRuntime,
        allowInTests: true,
      });

      try {
        const tempRoot = await fs.realpath(
          path.join(resolvePreferredOpenClawTmpDir(), "canvas-host"),
        );
        const actualRoot = await fs.realpath(handler.rootDir);
        expect(actualRoot).toBe(tempRoot);
        expect(actualRoot.startsWith(await fs.realpath(stateDir))).toBe(false);
        const indexPath = path.join(tempRoot, "index.html");
        const indexContents = await fs.readFile(indexPath, "utf8");
        expect(indexContents).toContain("OpenClaw Canvas");
      } finally {
        await handler.close();
      }
    });
  });
});
