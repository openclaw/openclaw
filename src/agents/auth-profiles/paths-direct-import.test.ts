import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveLegacyAuthProfilesPath as resolveAuthStorePath } from "../../commands/doctor-auth-legacy-paths.js";
import { withEnv } from "../../test-utils/env.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { resolveAuthStorePathForDisplay } from "./paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("auth profile path helpers (direct-import coverage attribution)", () => {
  let stateDir = "";

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-path-direct-");
  });

  it("honors OPENCLAW_AGENT_DIR in both no-argument auth path implementations", () => {
    const relocatedAgentDir = path.join(stateDir, "relocated-main-agent");
    withEnv({ OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: relocatedAgentDir }, () => {
      expect(path.dirname(resolveAuthStorePath())).toBe(relocatedAgentDir);
      expect(resolveAuthStorePathForDisplay()).toBe(
        path.join(relocatedAgentDir, "openclaw-agent.sqlite"),
      );
    });
  });

  it("falls back to the shared owner for an agent dir that has no local store", () => {
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      // A tilde-rooted dir resolveUserPath cannot expand still must not be reported as the owner:
      // without a local store the loader reads the shared database, so display must name that.
      const resolved = resolveAuthStorePathForDisplay("~fake-openclaw-no-expand");
      expect(resolved).toBe(resolveSharedAuthStorePath());
      expect(resolved.startsWith("~")).toBe(false);
    });
  });
});
