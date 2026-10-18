import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMuseLogin } from "./muse-login.js";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "muse-login-"));
  directories.push(directory);
  const binaryPath = path.join(directory, "muse");
  await writeFile(
    binaryPath,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_MUSE_DIR;
if (process.argv[2] !== 'login') process.exit(9);
fs.appendFileSync(path.join(dir, 'attempts'), 'login\\n');
if (process.env.TBH_CREDENTIAL_BACKEND !== 'file') process.exit(1);
fs.writeFileSync(path.join(dir, 'environment'), JSON.stringify({ backend: process.env.TBH_CREDENTIAL_BACKEND, home: process.env.XDG_CONFIG_HOME, key: process.env.META_API_KEY }));
const watcher = fs.watch(dir, (_, name) => { if (name === 'approve') { fs.writeFileSync(path.join(dir, 'credential'), 'saved'); watcher.close(); process.exit(0); } });
process.on('SIGTERM', () => { fs.writeFileSync(path.join(dir, 'cancelled'), 'yes'); watcher.close(); process.exit(0); });
process.stdout.write('Open this page to sign in:\\n  https://auth.meta.com/oauth/device/?code=ABCD-1234\\nconfirm this code matches:\\n  ABCD-1234\\n');
`,
  );
  await chmod(binaryPath, 0o700);
  const ctx: ProviderAuthContext = {
    config: { plugins: { entries: { muse: { config: { binaryPath } } } } },
    env: {
      ...process.env,
      FAKE_MUSE_DIR: directory,
      OPENCLAW_STATE_DIR: path.join(directory, "state"),
      META_API_KEY: "must-not-be-used",
      TBH_CREDENTIAL_BACKEND: undefined,
      XDG_CONFIG_HOME: undefined,
    },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    prompter: {
      intro: vi.fn(),
      outro: vi.fn(),
      note: vi.fn(),
      deviceCode: vi.fn(),
      select: vi.fn(),
      multiselect: vi.fn(),
      text: vi.fn(),
      confirm: vi.fn(),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    },
    isRemote: false,
    openUrl: vi.fn(async () => {
      await writeFile(path.join(directory, "approve"), "yes");
    }),
    oauth: { createVpsAwareHandlers: vi.fn() },
  };
  return { directory, ctx };
}

describe("Muse Code browser sign-in", () => {
  it("signs in with one browser approval using managed credentials", async () => {
    const { ctx, directory } = await fixture();
    const result = await runMuseLogin(ctx);
    expect(ctx.prompter.deviceCode).toHaveBeenCalledWith({
      title: "Authorize Muse Code",
      code: "ABCD-1234",
    });
    expect(ctx.openUrl).toHaveBeenCalledWith("https://auth.meta.com/oauth/device/?code=ABCD-1234");
    expect(result.profiles).toEqual([]);
    expect(result.agentRuntimeId).toBe("muse");
    expect(result.configPatch?.agents).toBeUndefined();
    expect(await readFile(path.join(directory, "attempts"), "utf8")).toBe("login\n");
    expect(ctx.prompter.deviceCode).toHaveBeenCalledOnce();
    expect(ctx.openUrl).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(path.join(directory, "environment"), "utf8"))).toEqual({
      backend: "file",
      home: path.join(directory, "state", "muse"),
    });
  });

  it("terminates the child even when cancellation interrupts device-code presentation", async () => {
    const { ctx, directory } = await fixture();
    const controller = new AbortController();
    ctx.signal = controller.signal;
    ctx.prompter.deviceCode = vi.fn(() => {
      controller.abort(new Error("cancelled while showing code"));
      return createDeferred().promise;
    });
    await expect(runMuseLogin(ctx)).rejects.toThrow("cancelled while showing code");
    expect(await readFile(path.join(directory, "cancelled"), "utf8")).toBe("yes");
    expect(ctx.openUrl).not.toHaveBeenCalled();
  });

  it("kills a pending login when authority is revoked without aborting the signal", async ({
    signal,
  }) => {
    const { ctx, directory } = await fixture();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    ctx.signal = signal;
    let active = true;
    ctx.assertCurrent = () => {
      if (!active) {
        throw new Error("Login authority revoked");
      }
    };
    ctx.openUrl = async () => {
      active = false;
      await vi.advanceTimersByTimeAsync(100);
    };
    await expect(runMuseLogin(ctx)).rejects.toThrow("Login authority revoked");
    expect(signal.aborted).toBe(false);
    expect(await readFile(path.join(directory, "cancelled"), "utf8")).toBe("yes");
    await expect(readFile(path.join(directory, "credential"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("gives the install command when the configured binary is missing", async () => {
    const { ctx, directory } = await fixture();
    ctx.config = {
      plugins: { entries: { muse: { config: { binaryPath: path.join(directory, "missing") } } } },
    };
    await expect(runMuseLogin(ctx)).rejects.toThrow(
      "curl -fsSL https://dev.meta.ai/install.sh | bash",
    );
    expect(ctx.openUrl).not.toHaveBeenCalled();
  });
});
