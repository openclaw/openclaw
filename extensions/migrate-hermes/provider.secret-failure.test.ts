import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAuthProfileStoreLocationForDisplay } from "openclaw/plugin-sdk/agent-runtime";
import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HERMES_REASON_AUTH_PROFILE_WRITE_FAILED } from "./items.js";

const mocks = vi.hoisted(() => ({
  updateAuthProfileStoreWithLock: vi.fn(async () => null),
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  updateAuthProfileStoreWithLock: mocks.updateAuthProfileStoreWithLock,
}));

const { buildHermesMigrationProvider } = await import("./provider.js");

const tempRoots = new Set<string>();
const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function stateEnv(stateDir: string): NodeJS.ProcessEnv {
  return { ...process.env, OPENCLAW_STATE_DIR: stateDir };
}

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-secret-failure-"));
  tempRoots.add(root);
  return root;
}

async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function makeContext(params: {
  source: string;
  stateDir: string;
  workspaceDir: string;
  reportDir: string;
}): MigrationProviderContext {
  return {
    config: {
      agents: {
        defaults: {
          workspace: params.workspaceDir,
        },
      },
    } as OpenClawConfig,
    stateDir: params.stateDir,
    source: params.source,
    includeSecrets: true,
    overwrite: true,
    reportDir: params.reportDir,
    logger,
  };
}

describe("Hermes migration provider secret write failures", () => {
  afterEach(async () => {
    for (const root of tempRoots) {
      await fs.rm(root, { force: true, recursive: true });
    }
    tempRoots.clear();
    mocks.updateAuthProfileStoreWithLock.mockClear();
  });

  it("reports an error when a secret auth-profile write fails", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");

    const provider = buildHermesMigrationProvider();
    const result = await provider.apply(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        reportDir: path.join(root, "report"),
      }),
    );

    expect(result.items).toEqual([
      {
        id: "secret:openai",
        kind: "secret",
        action: "create",
        source: path.join(source, ".env"),
        target: `${resolveAuthProfileStoreLocationForDisplay(
          path.join(stateDir, "agents", "main", "agent"),
          stateEnv(stateDir),
        )}/openai:hermes-import`,
        status: "error",
        sensitive: true,
        reason: HERMES_REASON_AUTH_PROFILE_WRITE_FAILED,
        details: {
          envVar: "OPENAI_API_KEY",
          provider: "openai",
          profileId: "openai:hermes-import",
        },
      },
    ]);
    expect(result.summary.errors).toBe(1);
    expect(result.summary.migrated).toBe(0);
  });
});
