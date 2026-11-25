import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";

const runtime = createRuntimeSpies();

describe("web logout", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let logoutWeb: typeof import("./auth-store.js").logoutWeb;

  beforeAll(async () => {
    fixtureRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-test-web-logout-"));
    vi.stubEnv("OPENCLAW_OAUTH_DIR", path.join(fixtureRoot, "oauth"));
    ({ logoutWeb } = await import("./auth-store.js"));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await fsPromises.rm(fixtureRoot, { recursive: true, force: true });
  });

  const createAuthCase = async (files: Record<string, string> = {}, external = false) => {
    const parent = external ? "external" : "oauth/whatsapp";
    const dir = path.join(fixtureRoot, parent, `case-${caseId++}`);
    await fsPromises.mkdir(dir, { recursive: true });
    await Promise.all(
      Object.entries(files).map(async ([name, contents]) => {
        await fsPromises.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
        await fsPromises.writeFile(path.join(dir, name), contents, "utf-8");
      }),
    );
    return dir;
  };

  const expectPreserved = async (authDir: string, targetDir: string, files: string[]) => {
    expect(await logoutWeb({ authDir, runtime })).toBe(false);
    for (const file of [authDir, ...files.map((name) => path.join(targetDir, name))]) {
      expect(fs.existsSync(file)).toBe(true);
    }
  };

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_OAUTH_DIR", path.join(fixtureRoot, "oauth"));
    vi.clearAllMocks();
  });

  it("removes oauth.json too when not using legacy auth dir", async () => {
    const authDir = await createAuthCase({
      "creds.json": "{}",
      "oauth.json": '{"token":true}',
      "session-abc.json": "{}",
    });
    expect(await logoutWeb({ authDir, runtime })).toBe(true);
    expect(fs.existsSync(authDir)).toBe(false);
  });

  it("no-ops when nothing to delete", { timeout: 15_000 }, async () => {
    expect(await logoutWeb({ authDir: await createAuthCase(), runtime })).toBe(false);
    expect(runtime.log).toHaveBeenCalled();
  });

  it("does not delete custom auth directories outside the OpenClaw auth root", async () => {
    const files = {
      "creds.json": "{}",
      "oauth.json": '{"token":true}',
      "notes.txt": "keep",
      "nested/session-abc.json": "keep",
    };
    const authDir = await createAuthCase(files, true);
    await expectPreserved(authDir, authDir, Object.keys(files));
  });

  it.each([
    { kind: "auth-directory", suffix: "" },
    { kind: "intermediate", suffix: "default" },
  ])("does not delete through $kind symlinks inside the auth root", async ({ suffix }) => {
    const externalRoot = await createAuthCase(
      {
        [path.join(suffix, "creds.json")]: "{}",
        [path.join(suffix, "notes.txt")]: "keep",
      },
      true,
    );
    const link = path.join(fixtureRoot, "oauth", "whatsapp", `linked-${caseId++}`);
    await fsPromises.mkdir(path.dirname(link), { recursive: true });
    await fsPromises.symlink(externalRoot, link, "dir");
    await expectPreserved(path.join(link, suffix), path.join(externalRoot, suffix), [
      "creds.json",
      "notes.txt",
    ]);
  });
});
