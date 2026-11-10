import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, describe, expect, it, vi } from "vitest";
import { registerDiffsPlugin } from "./plugin.js";

const { createDiffsToolMock } = vi.hoisted(() => ({
  createDiffsToolMock: vi.fn(() => ({ name: "diffs" })),
}));

vi.mock("./tool.js", () => ({
  createDiffsTool: createDiffsToolMock,
}));

afterAll(() => {
  vi.doUnmock("./tool.js");
  vi.resetModules();
});

describe("diffs plugin language-pack discovery", () => {
  it("skips runtime registration while collecting CLI metadata", () => {
    const hooks = { registerTool: vi.fn(), registerHttpRoute: vi.fn(), on: vi.fn() };
    registerDiffsPlugin(createTestPluginApi({ registrationMode: "cli-metadata", ...hooks }));
    for (const hook of Object.values(hooks)) {
      expect(hook).not.toHaveBeenCalled();
    }
  });

  it.each(["assets", "dist/assets"])(
    "requires both the sibling manifest and generated runtime asset in %s",
    (assetDir) => {
      const root = fs.mkdtempSync(join(os.tmpdir(), "openclaw-diffs-language-pack-"));
      try {
        const languagePackRoot = join(root, "diffs-language-pack");
        fs.mkdirSync(languagePackRoot, { recursive: true });
        fs.writeFileSync(
          join(languagePackRoot, "openclaw.plugin.json"),
          '{"id":"diffs-language-pack"}\n',
        );
        const config = { plugins: {} };
        const openBlobStore = vi.fn(() => ({}));
        const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
        const api = createTestPluginApi({
          rootDir: join(root, "diffs"),
          config,
          runtime: {
            config: { current: () => config },
            state: { openBlobStore },
          } as never,
          registerTool,
        });

        registerDiffsPlugin(api);
        expect(openBlobStore).toHaveBeenCalledWith({
          namespace: "diff-artifacts",
          maxEntries: 2_048,
          maxBytesPerEntry: 32 * 1024 * 1024,
          maxBytesPerNamespace: 256 * 1024 * 1024,
          overflowPolicy: "reject-new",
        });
        const factory = registerTool.mock.calls[0]?.[0];
        if (typeof factory !== "function") {
          throw new Error("expected diffs tool factory");
        }
        const checkAvailability = (languagePackAvailable: boolean) => {
          factory({});
          expect(createDiffsToolMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ languagePackAvailable }),
          );
        };
        checkAvailability(false);

        fs.mkdirSync(join(languagePackRoot, assetDir), { recursive: true });
        fs.writeFileSync(join(languagePackRoot, assetDir, "viewer-runtime.js"), "export {};\n");

        checkAvailability(true);
      } finally {
        fs.rmSync(root, { force: true, recursive: true });
        createDiffsToolMock.mockClear();
      }
    },
  );
});
