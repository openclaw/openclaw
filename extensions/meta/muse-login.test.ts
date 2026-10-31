import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTestWizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/provider-auth";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { runMuseLogin as login } from "./muse-login.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.useRealTimers());

async function fixture() {
  const dir = directories.make("muse-login-");
  const binaryPath = path.join(dir, "fake-muse");
  const script = `#!${process.execPath}
const fs = require('node:fs');
process.chdir(process.env.FAKE_MUSE_DIR);
if (process.argv[2] !== 'login') process.exit(9);
fs.writeFileSync('environment', JSON.stringify({ backend: process.env.TBH_CREDENTIAL_BACKEND, home: process.env.XDG_CONFIG_HOME, key: process.env.META_API_KEY }));
const watcher = fs.watch('.', (_, name) => { if (name === 'approve') { fs.writeFileSync('credential', 'saved'); watcher.close(); process.exit(0); } });
process.on('SIGTERM', () => { fs.writeFileSync('cancelled', 'yes'); watcher.close(); process.exit(0); });
process.stdout.write('Open this page to sign in:\\n  https://auth.meta.com/oauth/device/?code=ABCD-1234\\nconfirm this code matches:\\n  ABCD-1234\\n');
`;
  await writeFile(binaryPath, script, { mode: 0o700 });
  const ctx: ProviderAuthContext = {
    config: { plugins: { entries: { muse: { config: { binaryPath } } } } },
    env: { FAKE_MUSE_DIR: dir, OPENCLAW_STATE_DIR: dir, META_API_KEY: "must-not-be-used" },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    prompter: createTestWizardPrompter({ deviceCode: vi.fn(), select: vi.fn() }),
    isRemote: false,
    openUrl: vi.fn(async () => writeFile(path.join(dir, "approve"), "yes")),
    oauth: { createVpsAwareHandlers: vi.fn() },
  };
  return { dir, ctx, read: (name: string) => readFile(path.join(dir, name), "utf8") };
}

it("signs in with one browser approval using managed credentials", async () => {
  const { ctx, dir, read } = await fixture();
  const { profiles, agentRuntimeId, configPatch } = await login(ctx);
  const code = { title: "Authorize Muse Code", code: "ABCD-1234" };
  const url = "https://auth.meta.com/oauth/device/?code=ABCD-1234";
  expect(ctx.prompter.deviceCode).toHaveBeenCalledExactlyOnceWith(code);
  expect(ctx.openUrl).toHaveBeenCalledExactlyOnceWith(url);
  expect([profiles, agentRuntimeId, configPatch?.agents]).toEqual([[], "muse", undefined]);
  expect(ctx.prompter.select).not.toHaveBeenCalled();
  const environment = JSON.parse(await read("environment"));
  expect(environment).toEqual({ backend: "file", home: path.join(dir, "muse") });
});

it.each([true, false])("terminates login (signal cancellation: %s)", async (cancel) => {
  const { ctx, read } = await fixture();
  const authority = new AbortController();
  const error = new Error("Login authority revoked");
  ctx.signal = cancel ? authority.signal : new AbortController().signal;
  ctx.assertCurrent = () => authority.signal.throwIfAborted();
  if (cancel) {
    ctx.prompter.deviceCode = () => {
      authority.abort(error);
      return Promise.race([]);
    };
  } else {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    ctx.openUrl = vi.fn(async () => {
      authority.abort(error);
      await vi.advanceTimersByTimeAsync(100);
    });
  }
  await expect(login(ctx)).rejects.toBe(error);
  expect(ctx.signal.aborted).toBe(cancel);
  expect(await read("cancelled")).toBe("yes");
  await expect(read("credential")).rejects.toMatchObject({ code: "ENOENT" });
  expect(ctx.openUrl).toHaveBeenCalledTimes(cancel ? 0 : 1);
});

it("gives the install command when the configured binary is missing", async () => {
  const { ctx, dir } = await fixture();
  await rm(path.join(dir, "fake-muse"));
  await expect(login(ctx)).rejects.toThrow("curl -fsSL https://dev.meta.ai/install.sh | bash");
  expect(ctx.openUrl).not.toHaveBeenCalled();
});
