import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { refreshCodexAppServerAuthTokens } from "./auth-bridge.js";
import { CodexAppServerClient } from "./client.js";
import {
  clearSharedCodexAppServerClientAndWait,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

/** Uses the shared-client suite's auth mocks and lifecycle cleanup. */
export function registerSharedClientAuthRefreshTests() {
  it("joins refresh settlement after a retired shared client's transport exits", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness({ autoEmitExit: false });
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
    const refreshEntered = createDeferred<void>();
    const releaseRefresh = createDeferred<void>();
    let refreshSettled = false;
    let cleanup: Promise<void> | undefined;
    try {
      const acquiring = getLeasedSharedCodexAppServerClient({ timeoutMs: 1_000 });
      const initialize = JSON.parse(await harness.waitForWrite(0)) as {
        id: number;
        method: string;
      };
      expect(initialize.method).toBe("initialize");
      harness.send({
        id: initialize.id,
        result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` },
      });
      const client = await acquiring;
      vi.mocked(refreshCodexAppServerAuthTokens).mockImplementationOnce(async () => {
        refreshEntered.resolve();
        await releaseRefresh.promise;
        refreshSettled = true;
        return {
          accessToken: "settled-access",
          chatgptAccountId: "settled-account",
          chatgptPlanType: null,
        };
      });
      harness.send({
        id: "retired-refresh",
        method: "account/chatgptAuthTokens/refresh",
        params: { reason: "unauthorized" },
      });
      await refreshEntered.promise;
      expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
      expect(retireSharedCodexAppServerClientIfCurrent(client)).toEqual({
        activeLeases: 0,
        closed: true,
      });
      harness.emitExit();
      expect(harness.process.exitCode).toBe(0);

      let cleanupSettled = false;
      cleanup = clearSharedCodexAppServerClientAndWait().then(() => {
        cleanupSettled = true;
      });
      // Flush scheduled close continuations without releasing the admitted refresh.
      await vi.advanceTimersByTimeAsync(0);
      expect(cleanupSettled).toBe(false);
      expect(refreshSettled).toBe(false);

      releaseRefresh.resolve();
      await cleanup;
      expect(refreshSettled).toBe(true);
      expect(harness.writes.some((line) => JSON.parse(line).id === "retired-refresh")).toBe(false);
    } finally {
      releaseRefresh.resolve();
      harness.client.close();
      harness.emitExit();
      await cleanup;
      await harness.client.closeAndWait();
    }
  });
}
