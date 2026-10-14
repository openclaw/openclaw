import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import {
  shellEscape,
  tempWorkspaceSync,
  resolvePreferredOpenClawTmpDir,
  type CreateSandboxBackendParams,
  type SandboxBackendManager,
} from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSrtSandboxBackendFactory,
  createSrtSandboxBackendManager,
  shutdownSrtSandboxRuntime,
} from "./backend.js";
import { resolveSrtPluginConfig } from "./config.js";

afterEach(shutdownSrtSandboxRuntime);

describe.skipIf(process.platform !== "darwin")("macOS detached-session custody", () => {
  it.each(
    (["ordinary", "broker", "streaming"] as const).flatMap((route) =>
      (["completion", "cancellation", "retirement"] as const).map((ending) => ({ route, ending })),
    ),
  )("blocks session-changing children through $route on $ending", async ({ route, ending }) => {
    const workspace = tempWorkspaceSync({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "srt-session-proof-",
    });
    const scopeKey = `${route}-${ending}`;
    const proof = workspace.path("attempts");
    const effect = workspace.path("delayed-write");
    const allowed = workspace.path("allowed-write");
    const python = execFileSync(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-c",
        "import os, sys; p = os.path.join(sys.prefix, 'Resources/Python.app/Contents/MacOS/Python'); print(p if os.path.exists(p) else sys.executable)",
      ],
      { encoding: "utf8" },
    ).trim();
    const payload = `import time; time.sleep(0.75); open(${JSON.stringify(effect)}, 'w').write('escaped')`;
    const script = [
      "import os, subprocess, time",
      "results = []",
      "for mode in ['session', 'group', 'spawn-group']:",
      "    try:",
      "        if mode == 'spawn-group':",
      `            os.posix_spawn(${JSON.stringify(python)}, [${JSON.stringify(python)}, '-I', '-S', '-c', ${JSON.stringify(payload)}], os.environ, setpgroup=0, file_actions=[(os.POSIX_SPAWN_OPEN, fd, '/dev/null', os.O_RDONLY if fd == 0 else os.O_WRONLY, 0) for fd in range(3)])`,
      "        else:",
      `            subprocess.Popen([${JSON.stringify(python)}, '-I', '-S', '-c', ${JSON.stringify(payload)}], start_new_session=mode == 'session', preexec_fn=(lambda: os.setpgid(0, 0)) if mode == 'group' else None, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)`,
      "        results.append('escaped')",
      "    except PermissionError:",
      "        results.append('denied')",
      "    except subprocess.SubprocessError:",
      "        results.append('denied')",
      `subprocess.run([${JSON.stringify(python)}, '-I', '-S', '-c', ${JSON.stringify(`open(${JSON.stringify(allowed)}, 'w').write('allowed')`)}], check=True)`,
      `open(${JSON.stringify(proof)}, 'w').write(','.join(results))`,
      ...(ending === "completion" ? [] : ["time.sleep(30)"]),
    ].join("\n");
    const command = `${shellEscape(python)} -I -S -c ${shellEscape(script)}`;
    const factory = createSrtSandboxBackendFactory({
      pluginConfig: resolveSrtPluginConfig({ perSessionNetwork: route === "broker" }),
    });
    const params: CreateSandboxBackendParams = {
      sessionKey: scopeKey,
      scopeKey,
      workspaceDir: workspace.dir,
      agentWorkspaceDir: workspace.dir,
      cfg: {
        mode: "all",
        backend: "srt",
        scope: "session",
        workspaceAccess: "rw",
        workspaceRoot: workspace.dir,
        dockerTmpfsSource: "default",
        docker: { workdir: workspace.dir, env: {} },
        ssh: {},
        browser: {},
        tools: {},
        prune: {},
      } as unknown as CreateSandboxBackendParams["cfg"],
    };
    const controller = new AbortController();
    const handle = await factory(params);
    let finalize: (() => Promise<void>) | undefined;
    let terminate: (() => Promise<void>) | undefined;
    let pending: Promise<unknown>;
    if (route === "streaming") {
      const cleanup = handle.prepareProcessCleanup!({});
      const spec = await handle.buildExecSpec({ command, env: cleanup.env, usePty: false });
      const child = spawn(spec.argv[0]!, spec.argv.slice(1), { env: spec.env, stdio: "ignore" });
      pending = once(child, "close");
      terminate = async () => {
        await cleanup.terminate();
      };
      finalize = async () => {
        await handle.finalizeExec!({
          status: "completed",
          exitCode: 0,
          timedOut: false,
          token: spec.finalizeToken,
        });
      };
    } else {
      pending = handle.runShellCommand({
        script: command,
        signal: controller.signal,
        allowFailure: true,
      });
      // Cancellation is expected to reject; attach the handler before retiring.
      pending = pending.catch(() => undefined);
      terminate = async () => {
        controller.abort();
      };
    }
    try {
      await expect.poll(() => existsSync(proof), { timeout: 10_000 }).toBe(true);
      if (ending === "cancellation") {
        await terminate();
      } else if (ending === "retirement") {
        await createSrtSandboxBackendManager().removeRuntime({
          entry: { containerName: scopeKey, sessionKey: scopeKey },
          config: {},
        } as unknown as Parameters<SandboxBackendManager["removeRuntime"]>[0]);
      }
      await pending;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1000);
      });
      expect(readFileSync(allowed, "utf8")).toBe("allowed");
      expect(existsSync(effect)).toBe(false);
      expect(readFileSync(proof, "utf8")).toBe("denied,denied,denied");
    } finally {
      await terminate();
      await pending;
      await finalize?.();
      await shutdownSrtSandboxRuntime();
      workspace.cleanup();
    }
  });
});
