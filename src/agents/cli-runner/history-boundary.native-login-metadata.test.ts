// Proves a SessionManager append confirms the native login owner inside the metadata worker.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { runWithCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { SessionManager } from "../sessions/session-manager.js";
import { prepareCliHistoryBoundary } from "./history-boundary.js";
import { createHistoryBoundaryFixture } from "./history-boundary.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "cli-history-boundary-metadata-");
const native = { provider: "claude-cli" };

beforeEach(() => {
  // Stub Anthropic profile endpoint: a synthetic token names its own account.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const bearer = new Headers(init?.headers).get("authorization") ?? "";
      const match = /^Bearer synthetic-token-for-(.+)$/u.exec(bearer);
      return match
        ? Response.json({ account: { uuid: match[1] }, organization: { uuid: "org" } })
        : new Response("{}", { status: 401 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function loginIn(dir: string, accountUuid: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `synthetic-token-for-${accountUuid}`,
        expiresAt: Date.parse("2030-01-01T00:00:00Z"),
      },
    }),
  );
}

const coveredSeq = (target: Parameters<typeof loadSessionEntryReadOnly>[0]) =>
  (loadSessionEntryReadOnly(target)?.cliHistoryBoundary as { maxSeq?: number } | undefined)?.maxSeq;

it("covers a SessionManager append only while the native login owner holds", async () => {
  const f = await createHistoryBoundaryFixture(sessionDirs);
  vi.stubEnv("CLAUDE_CONFIG_DIR", sessionDirs.make());
  const backend = sessionDirs.make();
  loginIn(backend, "uuid:account-a");
  const prepared = { backend: { command: "claude", env: { CLAUDE_CONFIG_DIR: backend } } };
  const runId = "boundary-native-metadata";
  await patchSessionEntryCore(f.target, (entry) => ({ ...entry, activeWriterRunId: runId }));
  await f.withRun(
    runId,
    async (params) => {
      const writer = await prepareCliHistoryBoundary(params, undefined, prepared);
      expect(writer?.bindsNativeLogin).toBe(true);
      await runWithCliHistoryWriter(writer, async () => {
        const manager = await SessionManager.openAsync(f.target);
        const before = coveredSeq(f.target);
        await manager.appendMessageAsync({ role: "user", content: "under a", timestamp: 1 });
        const covered = coveredSeq(f.target);
        expect(covered).toBeGreaterThan(before ?? -1);
        // Another account's credential, never attested by this process.
        loginIn(backend, "uuid:account-b");
        await manager.appendMessageAsync({ role: "user", content: "under b", timestamp: 2 });
        expect(coveredSeq(f.target)).toBe(covered);
        expect(JSON.stringify(manager.getEntries())).toContain("under b");
      });
    },
    native,
  );
});
