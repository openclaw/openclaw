import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { ensureSessionHeader } from "./pi-embedded-helpers.js";

function expectPrivateDirMode(actual: number) {
  if (process.platform === "win32") {
    expect([0o700, 0o666, 0o777]).toContain(actual);
    return;
  }
  expect(actual).toBe(0o700);
}

describe("ensureSessionHeader", () => {
  it("creates managed session dirs with private permissions", async () => {
    await withTempHome(async (home) => {
      const sessionsDir = path.join(home, ".openclaw", "agents", "main", "sessions");
      const sessionFile = path.join(sessionsDir, "probe.jsonl");
      await fs.rm(sessionsDir, { recursive: true, force: true });

      await ensureSessionHeader({
        sessionFile,
        sessionId: "probe-session",
        cwd: home,
      });

      const mode = (await fs.stat(sessionsDir)).mode & 0o777;
      expectPrivateDirMode(mode);
    });
  });
});
