import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStoreRouter } from "./store-router.js";
import { WorkspaceStore } from "./store.js";

describe("WorkspaceStoreRouter", () => {
  it("reuses one store per domain and keeps equal resource ids isolated", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-router-"));
    const router = new WorkspaceStoreRouter(new WorkspaceStore({ stateDir }));
    try {
      const first = router.forDomain("domain-1");
      const second = router.forDomain("domain-2");
      expect(router.forDomain("domain-1")).toBe(first);

      first.mutate(
        (draft) => {
          draft.tabs[0]!.title = "First tenant";
        },
        { actor: "user" },
      );
      expect(second.read().tabs[0]).toMatchObject({ id: "main", title: "Overview" });
    } finally {
      router.close();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
