import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { createTestWizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/provider-auth";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { runMuseLogin } from "./muse-login.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.useRealTimers());

async function fixture() {
  const directory = directories.make("muse-login-");
  const binaryPath = path.join(directory, "muse");
  const script = `#!${process.execPath}
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
`;
  await writeFile(binaryPath, script, { mode: 0o700 });
  const ctx: ProviderAuthContext = {
    config: { plugins: { entries: { muse: { config: { binaryPath } } } } },
    env: {
      FAKE_MUSE_DIR: directory,
      OPENCLAW_STATE_DIR: path.join(directory, "state"),
      META_API_KEY: "must-not-be-used",
    },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    prompter: createTestWizardPrompter({ deviceCode: vi.fn(), select: vi.fn() }),
    isRemote: false,
    openUrl: vi.fn(async () => {
      await writeFile(path.join(directory, "approve"), "yes");
    }),
    oauth: { createVpsAwareHandlers: vi.fn() },
  };
  return { directory, ctx, read: (name: string) => readFile(path.join(directory, name), "utf8") };
}

it("signs in with one browser approval using managed credentials", async () => {
  const { ctx, directory, read } = await fixture();
  const { profiles, agentRuntimeId, configPatch } = await runMuseLogin(ctx);
  const code = { title: "Authorize Muse Code", code: "ABCD-1234" };
  const url = "https://auth.meta.com/oauth/device/?code=ABCD-1234";
  expect(ctx.prompter.deviceCode).toHaveBeenCalledExactlyOnceWith(code);
  expect(ctx.openUrl).toHaveBeenCalledExactlyOnceWith(url);
  expect([profiles, agentRuntimeId, configPatch?.agents]).toEqual([[], "muse", undefined]);
  expect(ctx.prompter.select).not.toHaveBeenCalled();
  expect(await read("attempts")).toBe("login\n");
  const environment = JSON.parse(await read("environment"));
  expect(environment).toEqual({ backend: "file", home: path.join(directory, "state", "muse") });
});

it("terminates the child even when cancellation interrupts device-code presentation", async () => {
  const { ctx, read } = await fixture();
  const controller = new AbortController();
  ctx.signal = controller.signal;
  ctx.prompter.deviceCode = vi.fn(() => {
    controller.abort(new Error("cancelled while showing code"));
    return createDeferred().promise;
  });
  await expect(runMuseLogin(ctx)).rejects.toThrow("cancelled while showing code");
  expect(await read("cancelled")).toBe("yes");
  expect(ctx.openUrl).not.toHaveBeenCalled();
});

it("terminates login on authority revocation without aborting its signal", async ({ signal }) => {
  const { ctx, read } = await fixture();
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
  expect(await read("cancelled")).toBe("yes");
  await expect(read("credential")).rejects.toMatchObject({ code: "ENOENT" });
});

it("gives the install command when the configured binary is missing", async () => {
  const { ctx, directory } = await fixture();
  await rm(path.join(directory, "muse"));
  await expect(runMuseLogin(ctx)).rejects.toThrow(
    "curl -fsSL https://dev.meta.ai/install.sh | bash",
  );
  expect(ctx.openUrl).not.toHaveBeenCalled();
});
