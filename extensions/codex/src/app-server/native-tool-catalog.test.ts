import { mkdir, mkdtemp, realpath, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCodexAppServerVerifiedLocalHomeDir } from "./auth-start-options.js";
import { parseCodexNativeToolCatalog } from "./native-tool-catalog.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";

const threadId = "native-thread";
const tool = {
  type: "function" as const,
  name: "example",
  description: "Synthetic tool",
  inputSchema: { type: "object" },
};

describe("parseCodexNativeToolCatalog", () => {
  it.each([{}, { dynamic_tools: null }, { dynamic_tools: [] }])(
    "restores the native empty representation %j without accepting a missing nonempty catalog",
    (catalog) => {
      const metadata = { id: threadId, ...catalog };
      expect(
        parseCodexNativeToolCatalog(metadata, threadId, codexDynamicToolsFingerprint([])),
      ).toEqual([]);
      expect(() =>
        parseCodexNativeToolCatalog(metadata, threadId, codexDynamicToolsFingerprint([tool])),
      ).toThrow("native tool catalog is missing, corrupt, or changed");
    },
  );

  it.each([
    null,
    {},
    { id: "other" },
    ...[{}, [null]].map((dynamic_tools) => ({ id: threadId, dynamic_tools })),
  ])("rejects invalid metadata %j", (metadata) => {
    expect(() => parseCodexNativeToolCatalog(metadata, threadId)).toThrow(
      "native tool catalog is missing, corrupt, or changed",
    );
  });

  it("retains nonempty declarations and the pinned false-defer omission", () => {
    expect(
      parseCodexNativeToolCatalog(
        { id: threadId, dynamic_tools: [{ ...tool, deferLoading: false }] },
        threadId,
        codexDynamicToolsFingerprint([tool]),
      ),
    ).toEqual([tool]);
  });
});

describe("resolveCodexAppServerVerifiedLocalHomeDir", () => {
  it("accepts the canonical home of a local alias and rejects a retargeted alias", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "codex-home-verification-"));
    try {
      const scratchHome = await realpath(scratch);
      const home = path.join(scratchHome, "home");
      const other = path.join(scratchHome, "other");
      const alias = path.join(scratch, "alias");
      await mkdir(home);
      await mkdir(other);
      await symlink(home, alias, "junction");
      const appServer = {
        start: {
          transport: "stdio" as const,
          command: "codex",
          args: [],
          headers: {},
          codexHome: alias,
        },
      };
      await expect(
        resolveCodexAppServerVerifiedLocalHomeDir(appServer, undefined, home),
      ).resolves.toBe(home);
      await expect(
        resolveCodexAppServerVerifiedLocalHomeDir(appServer, undefined, other),
      ).resolves.toBeUndefined();
      await expect(
        resolveCodexAppServerVerifiedLocalHomeDir(
          { ...appServer, remoteWorkspaceRoot: "/remote" },
          undefined,
          home,
        ),
      ).resolves.toBeUndefined();

      await unlink(alias);
      await expect(
        resolveCodexAppServerVerifiedLocalHomeDir(appServer, undefined, home),
      ).resolves.toBeUndefined();
      await symlink(other, alias, "junction");
      await expect(
        resolveCodexAppServerVerifiedLocalHomeDir(appServer, undefined, home),
      ).resolves.toBeUndefined();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
