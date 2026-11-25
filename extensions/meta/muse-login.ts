import { spawn } from "node:child_process";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import type { ProviderAuthContext, ProviderAuthResult } from "openclaw/plugin-sdk/provider-auth";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_MODEL = "meta/muse-spark-1.3";
const INSTALL_COMMAND = "curl -fsSL https://dev.meta.ai/install.sh | bash";

async function loginAttempt(ctx: ProviderAuthContext, binaryPath: string): Promise<boolean> {
  ctx.signal?.throwIfAborted();
  ctx.assertCurrent?.();
  // ctx.env is the host process environment chosen by the auth caller (it defaults to
  // process.env); it is the single base, never merged with a second source.
  const env: NodeJS.ProcessEnv = {
    ...(ctx.env ?? process.env),
    MUSE_NO_AUTO_UPDATE: "1",
    TBH_CREDENTIAL_BACKEND: "file",
  };
  env.XDG_CONFIG_HOME = path.join(resolveStateDir(env), "muse");
  delete env.META_API_KEY;
  const { promise, resolve, reject } = createDeferred<boolean>();
  const child = spawn(binaryPath, ["login"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let presented = false;
  let presentation: Promise<void> = Promise.resolve();
  let failure: unknown;
  let killTimer: NodeJS.Timeout | undefined;
  let authorityTimer: NodeJS.Timeout | undefined;
  const stop = (error: unknown) => {
    failure ??= error;
    clearInterval(authorityTimer);
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    killTimer.unref();
  };
  const abort = () => stop(ctx.signal?.reason ?? new Error("Muse sign-in cancelled."));
  const timer = setTimeout(
    () => stop(new Error("Muse sign-in timed out. Start sign-in again.")),
    10 * 60_000,
  );
  timer.unref();
  // Device-token invalidation can revoke authority without aborting the wizard signal.
  if (ctx.assertCurrent) {
    authorityTimer = setInterval(() => {
      try {
        ctx.assertCurrent?.();
      } catch (error) {
        stop(error);
      }
    }, 100);
    authorityTimer.unref();
  }
  ctx.signal?.addEventListener("abort", abort, { once: true });
  // Cover cancellation between the initial authority check and listener installation.
  if (ctx.signal?.aborted) {
    abort();
  }
  const observe = (chunk: Buffer) => {
    output = (output + stripVTControlCharacters(chunk.toString("utf8"))).slice(-32_768);
    if (presented || failure) {
      return;
    }
    const match =
      /https:\/\/auth\.meta\.com\/oauth\/device\/\?code=([A-Z0-9]+(?:-[A-Z0-9]+)*)/.exec(output);
    if (!match?.[1]) {
      return;
    }
    presented = true;
    const url = match[0];
    const code = match[1];
    presentation = (async () => {
      ctx.signal?.throwIfAborted();
      ctx.assertCurrent?.();
      if (ctx.prompter.deviceCode) {
        await ctx.prompter.deviceCode({ title: "Authorize Muse Code", code });
      } else {
        await ctx.prompter.note(`Open ${url} and confirm code ${code}.`, "Authorize Muse Code");
      }
      ctx.signal?.throwIfAborted();
      ctx.assertCurrent?.();
      await ctx.openUrl(url);
    })();
    void presentation.catch(stop);
  };
  child.stdout.on("data", observe);
  child.stderr.on("data", observe);
  // OpenClaw handles the browser handoff. EOF skips Muse's interactive Enter prompt.
  child.stdin.end();
  child.once("error", () => {
    failure ??= new Error(`Could not start Muse Code. Install it with: ${INSTALL_COMMAND}`);
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    clearTimeout(killTimer);
    clearInterval(authorityTimer);
    ctx.signal?.removeEventListener("abort", abort);
    if (failure) {
      reject(failure);
      return;
    }
    void presentation.then(() => {
      resolve(code === 0 && presented);
    }, reject);
  });
  return await promise;
}

export async function runMuseLogin(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  ctx.signal?.throwIfAborted();
  ctx.assertCurrent?.();
  const config = ctx.config.plugins?.entries?.muse?.config;
  const pluginConfig = isRecord(config) ? config : {};
  const binaryPath = typeof pluginConfig.binaryPath === "string" ? pluginConfig.binaryPath : "muse";
  if (!(await loginAttempt(ctx, binaryPath))) {
    throw new Error(
      "Muse Code sign-in failed. Start sign-in again and approve the code in your browser.",
    );
  }
  ctx.signal?.throwIfAborted();
  ctx.assertCurrent?.();
  return {
    profiles: [],
    defaultModel: DEFAULT_MODEL,
    agentRuntimeId: "muse",
    configPatch: {
      plugins: {
        entries: {
          muse: {
            enabled: true,
          },
        },
      },
    },
  };
}
