import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";

describe("resolveOpenClawAgentDir", () => {
  let tempStateDir: string | null = null;

  afterEach(async () => {
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
  });

  it("defaults to the multi-agent path when no overrides are set", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const stateDir = tempStateDir;
    if (!stateDir) {
      throw new Error("expected temp state dir");
    }
    withEnv(
      {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_AGENT_DIR: undefined,
        PI_CODING_AGENT_DIR: undefined,
      },
      () => {
        const resolved = resolveOpenClawAgentDir();
        expect(resolved).toBe(path.join(stateDir, "agents", "main", "agent"));
      },
    );
  });

  it("honors OPENCLAW_AGENT_DIR overrides", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const stateDir = tempStateDir;
    if (!stateDir) {
      throw new Error("expected temp state dir");
    }
    const override = path.join(stateDir, "agent");
    withEnv(
      {
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_AGENT_DIR: override,
        PI_CODING_AGENT_DIR: undefined,
      },
      () => {
        const resolved = resolveOpenClawAgentDir();
        expect(resolved).toBe(path.resolve(override));
      },
    );
  });
});
