import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const createdHomes: string[] = [];
let previousOpenClawHome: string | undefined;
let previousStateDir: string | undefined;

async function useMockHome(homeDir: string): Promise<void> {
  previousOpenClawHome ??= process.env.OPENCLAW_HOME;
  previousStateDir ??= process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_HOME = homeDir;
  process.env.OPENCLAW_STATE_DIR = path.join(homeDir, ".openclaw");
  vi.resetModules();
  vi.doMock("node:os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:os")>();
    return {
      ...actual,
      default: { ...actual, homedir: () => homeDir },
      homedir: () => homeDir,
    };
  });
}

function makeHome(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-home-"));
  createdHomes.push(homeDir);
  return homeDir;
}

describe("qqbot storage laziness", () => {
  afterEach(() => {
    resetPluginStateStoreForTests();
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    previousOpenClawHome = undefined;
    previousStateDir = undefined;
    vi.doUnmock("node:os");
    vi.resetModules();
    for (const home of createdHomes.splice(0)) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not create ~/.openclaw/qqbot from module imports or read-only probes", async () => {
    const homeDir = makeHome();
    await useMockHome(homeDir);

    const qqbotRoot = path.join(homeDir, ".openclaw", "qqbot");

    await import("../session/session-store.js");
    await import("../session/known-users.js");
    await import("../ref/store.js");
    const { loadCredentialBackup } = await import("../config/credential-backup.js");

    expect(loadCredentialBackup("default")).toBeNull();
    expect(fs.existsSync(qqbotRoot)).toBe(false);
  });

  it("creates storage when qqbot persists runtime state", async () => {
    const homeDir = makeHome();
    await useMockHome(homeDir);

    const qqbotRoot = path.join(homeDir, ".openclaw", "qqbot");
    const { saveCredentialBackup } = await import("../config/credential-backup.js");

    saveCredentialBackup("default", "123456", "secret");

    expect(fs.existsSync(path.join(homeDir, ".openclaw", "state", "openclaw.sqlite"))).toBe(true);
    expect(fs.existsSync(qqbotRoot)).toBe(false);
  });
});
