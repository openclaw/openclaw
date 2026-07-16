// Matrix tests cover inbound dedupe plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogService } from "../sdk/logger.js";
import { createMatrixInboundEventDeduper } from "./inbound-dedupe.js";

describe("Matrix inbound event dedupe", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createStateEnv(): NodeJS.ProcessEnv {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-inbound-dedupe-"));
    tempDirs.push(dir);
    return { ...process.env, OPENCLAW_STATE_DIR: dir };
  }

  const auth = { accountId: "ops" } as const;
  const event = { roomId: "!room:example.org", eventId: "$event-1" } as const;

  it("persists committed events across restarts", async () => {
    const env = createStateEnv();
    const first = createMatrixInboundEventDeduper({ auth, env });
    await expect(first.claim(event)).resolves.toMatchObject({ kind: "claimed" });
    await first.commit(event);

    // A fresh instance has an empty memory layer, so the duplicate verdict
    // must come from the persisted plugin-state SQLite rows.
    const second = createMatrixInboundEventDeduper({ auth, env });
    await expect(second.claim(event)).resolves.toEqual({ kind: "duplicate" });
  });

  it("scopes dedupe state per account", async () => {
    const env = createStateEnv();
    const ops = createMatrixInboundEventDeduper({ auth: { accountId: "ops" }, env });
    await expect(ops.claim(event)).resolves.toMatchObject({ kind: "claimed" });
    await ops.commit(event);

    const home = createMatrixInboundEventDeduper({ auth: { accountId: "home" }, env });
    await expect(home.claim(event)).resolves.toMatchObject({ kind: "claimed" });
  });

  it("fails open for events without usable identifiers", async () => {
    const deduper = createMatrixInboundEventDeduper({ auth, env: createStateEnv() });

    await expect(deduper.claim({ roomId: " ", eventId: "$x" })).resolves.toEqual({
      kind: "invalid",
    });
    await expect(deduper.claim({ roomId: " ", eventId: "$x" })).resolves.toEqual({
      kind: "invalid",
    });
    await expect(deduper.commit({ roomId: "!r:x", eventId: "" })).resolves.toBe(false);
  });

  it("keeps committed events in memory when plugin-state persistence fails", async () => {
    const warnSpy = vi.spyOn(LogService, "warn").mockImplementation(() => {});
    const blockedDir = createStateEnv().OPENCLAW_STATE_DIR as string;
    // A regular file where the state dir should be makes every SQLite open fail.
    const filePath = path.join(blockedDir, "not-a-dir");
    fs.writeFileSync(filePath, "x", "utf8");
    const deduper = createMatrixInboundEventDeduper({
      auth,
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(filePath, "nested") },
    });

    await expect(deduper.claim(event)).resolves.toMatchObject({ kind: "claimed" });
    await expect(deduper.commit(event)).resolves.toBe(true);
    await expect(deduper.claim(event)).resolves.toEqual({ kind: "duplicate" });
    expect(warnSpy).toHaveBeenCalledWith(
      "MatrixInboundDedupe",
      "Matrix inbound dedupe persistence failed:",
      expect.anything(),
    );
  });
});
