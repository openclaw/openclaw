import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as authPaths from "../auth-profiles/path-resolve.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../auth-profiles/runtime-snapshots.js";
import * as sqliteRead from "../auth-profiles/sqlite-read.js";
import type { AuthProfileRowRead } from "../auth-profiles/types.js";
import { resolveDynamicModelAuthProfile } from "./model.registry-resolution.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each(["cleanup failure", "admission refusal"] as const)(
  "propagates model auth %s after disposing its captured reader",
  async (change) => {
    const root = tempDirs.make("openclaw-model-auth-race-");
    const agentDir = path.join(root, "agents/main/agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.spyOn(authPaths, "resolveSharedAuthStoreOwnershipAsync").mockResolvedValue({
      location: "legacy-main",
    });
    const events: string[] = [];
    const refusal = new Error("Auth source admission revoked");
    const cleanupFailure = new Error("Auth child failed to close");
    vi.spyOn(sqliteRead, "prepareAgentAuthProfileRowsRead").mockImplementation(() => ({
      identity: undefined,
      assertCurrent: () => {},
      dispose: async () => {
        events.push("disposed");
        if (change === "cleanup failure") {
          throw cleanupFailure;
        }
      },
      read: async (): Promise<AuthProfileRowRead> => {
        events.push("read");
        if (change === "admission refusal") {
          throw refusal;
        }
        return {
          store: {
            status: "readable",
            raw: {
              version: 1,
              profiles: {
                "custom:current": { type: "api_key", provider: "custom", key: "fixture" },
              },
            },
          },
          state: { status: "missing", reason: "row" },
          cacheable: true,
        };
      },
    }));

    const resolution = resolveDynamicModelAuthProfile({
      provider: "custom",
      modelId: "fixture",
      agentDir,
    });
    await expect(resolution).rejects.toBe(
      change === "admission refusal" ? refusal : cleanupFailure,
    );
    expect(events).toEqual(["read", "disposed"]);
  },
);
