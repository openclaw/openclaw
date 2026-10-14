import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, tempWorkspaceSync } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, it, vi } from "vitest";
import { ExecCustody } from "./exec-custody.js";

describe.skipIf(process.platform === "win32")("normal exec lifecycle custody", () => {
  it.each(["BASH_ENV", "NODE_OPTIONS"])(
    "rejects %s before host interpreters execute workspace startup code",
    async (key) => {
      const workspace = tempWorkspaceSync({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "srt-startup-proof-",
      });
      const marker = workspace.path("marker");
      const startup = workspace.path(key === "BASH_ENV" ? "hook.sh" : "hook.cjs");
      writeFileSync(
        startup,
        key === "BASH_ENV"
          ? `echo escaped > ${JSON.stringify(marker)}`
          : `require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped');`,
      );
      const custody = new ExecCustody();
      const env = { [key]: key === "BASH_ENV" ? startup : `--require ${startup}` };
      try {
        await expect(
          custody.run(
            { argv: [process.execPath, "-e", "0"], env, stdinMode: "pipe-open" },
            { timeoutMs: 2000, maxBufferBytes: 1024 * 1024 },
          ),
        ).rejects.toThrow(/startup|environment/i);
        expect(existsSync(marker)).toBe(false);
      } finally {
        custody.dispose();
        workspace.cleanup();
      }
    },
  );

  it.each([0, 7, 143])(
    "preserves exit status %i while sweeping background descendants",
    async (code) => {
      const custody = new ExecCustody();
      const prepared = custody.prepare({});
      const source = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setTimeout(()=>${code === 143 ? "process.kill(process.pid,'SIGTERM')" : `process.exit(${code})`},30);`;
      const spec = custody.wrap(
        { argv: [process.execPath, "-e", source], env: prepared.env, stdinMode: "pipe-open" },
        prepared.env,
      );
      const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
        env: spec.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let descendant = 0;
      const exited = once(child, "exit");
      try {
        const [chunk] = (await once(child.stdout!, "data")) as [Buffer];
        descendant = Number.parseInt(chunk.toString(), 10);
        expect((await exited)[0]).toBe(code);
        await expect.poll(() => alive(descendant), { timeout: 2000 }).toBe(false);
      } finally {
        custody.dispose();
        await custody.finalize(spec.finalizeToken);
        if (descendant && alive(descendant)) {
          process.kill(descendant, "SIGKILL");
        }
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await exited;
      }
    },
  );

  it("rejects a prepared command after scope retirement", async () => {
    const custody = new ExecCustody();
    const env = custody.prepare({}).env;
    const spec = custody.wrap(
      { argv: [process.execPath, "-e", "0"], env, stdinMode: "pipe-open" },
      env,
    );
    custody.dispose();
    expect(() => spec.assertCurrent?.()).toThrow(/stale/);
    await custody.finalize(spec.finalizeToken);
  });

  it("terminates the complete detached descendant group on scope disposal", async () => {
    const custody = new ExecCustody();
    const prepared = custody.prepare({});
    const inner = [
      process.execPath,
      "-e",
      "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']); console.log(c.pid); setInterval(()=>{},1000)",
    ];
    const spec = custody.wrap(
      { argv: inner, env: prepared.env, stdinMode: "pipe-open" },
      prepared.env,
    );
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [chunk] = (await once(child.stdout!, "data")) as [Buffer];
    const descendantPid = Number.parseInt(chunk.toString("utf8"), 10);
    custody.dispose();
    await once(child, "exit");
    expect(() => process.kill(descendantPid, 0)).toThrow();
    await custody.finalize(spec.finalizeToken);
  });

  it("sweeps descendants when the streaming launcher is killed without cleanup callbacks", async () => {
    const custody = new ExecCustody();
    const prepared = custody.prepare({});
    const spec = custody.wrap(
      {
        argv: [
          process.execPath,
          "-e",
          "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']); console.log(c.pid); setInterval(()=>{},1000)",
        ],
        env: prepared.env,
        stdinMode: "pipe-open",
      },
      prepared.env,
    );
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let descendant = 0;
    try {
      const [chunk] = (await once(child.stdout!, "data")) as [Buffer];
      descendant = Number.parseInt(chunk.toString(), 10);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      await expect.poll(() => alive(descendant), { timeout: 2000 }).toBe(false);
    } finally {
      custody.dispose();
      await custody.finalize(spec.finalizeToken);
      if (descendant && alive(descendant)) {
        process.kill(descendant, "SIGKILL");
      }
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  });

  it("sweeps streaming descendants when the Gateway dies without disposing custody", async () => {
    const modulePath = path.resolve("extensions/srt-sandbox/src/exec-custody.ts");
    const fixture = `import { ExecCustody } from ${JSON.stringify(modulePath)}; import { spawn } from 'node:child_process'; const c=new ExecCustody(); const p=c.prepare({}); const s=c.wrap({argv:[process.execPath,'-e',"const{spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']); console.log('tree '+process.pid+' '+c.pid); setInterval(()=>{},1000)"],env:p.env,stdinMode:'pipe-open'},p.env); const l=spawn(s.argv[0],s.argv.slice(1),{env:s.env,stdio:['ignore','inherit','inherit']}); console.log('launcher '+l.pid); setInterval(()=>{},1000);`;
    const gateway = spawn(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "--input-type=module", "-e", fixture],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let errors = "";
    let inner = 0;
    let descendant = 0;
    let launcher = 0;
    gateway.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    gateway.stderr!.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    try {
      await expect
        .poll(() => output.includes("tree "), { timeout: 5000, message: errors })
        .toBe(true);
      const tree = /tree (\d+) (\d+)/.exec(output)!;
      inner = Number(tree[1]);
      descendant = Number(tree[2]);
      launcher = Number(/launcher (\d+)/.exec(output)![1]);
      const exited = once(gateway, "exit");
      gateway.kill("SIGKILL");
      await exited;
      await expect.poll(() => alive(descendant), { timeout: 2000 }).toBe(false);
      await expect.poll(() => alive(launcher), { timeout: 2000 }).toBe(false);
    } finally {
      if (inner && alive(inner)) {
        try {
          process.kill(-inner, "SIGKILL");
        } catch {
          process.kill(inner, "SIGKILL");
        }
      }
      for (const pid of [descendant, launcher]) {
        if (pid && alive(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
      if (gateway.exitCode === null && gateway.signalCode === null) {
        const exited = once(gateway, "exit");
        gateway.kill("SIGKILL");
        await exited;
      }
    }
  });

  describe("output capture limit", () => {
    const limit = 64 * 1024;

    async function expectFloodTerminated(stream: "stdout" | "stderr") {
      const workspace = tempWorkspaceSync({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "srt-flood-",
      });
      const pidFile = workspace.path("pid");
      const custody = new ExecCustody();
      let pid = 0;
      try {
        const redirect = stream === "stderr" ? " >&2" : "";
        await expect(
          custody.run(
            {
              argv: ["/bin/sh", "-c", `echo small; echo $$ > '${pidFile}'; exec yes${redirect}`],
              env: {},
              stdinMode: "pipe-open",
            },
            { timeoutMs: 30_000, maxBufferBytes: limit },
          ),
        ).rejects.toThrow(`srt-sandbox command ${stream} exceeded ${limit} bytes`);
        pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
        await expect.poll(() => alive(pid), { timeout: 2000 }).toBe(false);
      } finally {
        if (pid && alive(pid)) {
          process.kill(pid, "SIGKILL");
        }
        custody.dispose();
        workspace.cleanup();
      }
    }

    it("terminates a command whose stdout exceeds the limit", async () => {
      await expectFloodTerminated("stdout");
    });

    it("attributes an stderr flood to stderr while stdout stays small", async () => {
      await expectFloodTerminated("stderr");
    });

    it("leaves small output unchanged", async () => {
      const custody = new ExecCustody();
      try {
        const result = await custody.run(
          {
            argv: [
              process.execPath,
              "-e",
              "process.stdout.write('out'); process.stderr.write('err')",
            ],
            env: {},
            stdinMode: "pipe-open",
          },
          { timeoutMs: 10_000, maxBufferBytes: limit },
        );
        expect(result).toMatchObject({ code: 0, timedOut: false });
        expect(result.stdout.toString()).toBe("out");
        expect(result.stderr.toString()).toBe("err");
      } finally {
        custody.dispose();
      }
    });

    it("counts each stream against the limit separately", async () => {
      const custody = new ExecCustody();
      const size = limit - 1024;
      try {
        // Combined output exceeds the limit; neither stream does on its own.
        const result = await custody.run(
          {
            argv: [
              process.execPath,
              "-e",
              `process.stdout.write('o'.repeat(${size})); process.stderr.write('e'.repeat(${size}))`,
            ],
            env: {},
            stdinMode: "pipe-open",
          },
          { timeoutMs: 10_000, maxBufferBytes: limit },
        );
        expect(result.code).toBe(0);
        expect(result.stdout.toString()).toBe("o".repeat(size));
        expect(result.stderr.toString()).toBe("e".repeat(size));
      } finally {
        custody.dispose();
      }
    });
  });

  it("closes the cancellation-before-native-spawn race", async () => {
    const custody = new ExecCustody();
    const prepared = custody.prepare({});
    await prepared.terminate();
    const spec = custody.wrap(
      {
        argv: [process.execPath, "-e", "process.exit(99)"],
        env: prepared.env,
        stdinMode: "pipe-open",
      },
      prepared.env,
    );
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), { env: spec.env, stdio: "ignore" });
    const [code] = (await once(child, "exit")) as [number];
    expect(code).toBe(1);
    await custody.finalize(spec.finalizeToken);
  });
});

describe.skipIf(process.platform === "win32")("exec custody runtime authority", () => {
  /** Authority that throws `revoked` once `calls` checks have passed. */
  function authorityRevokedAfter(calls: number) {
    const revoked = new Error("runtime authority revoked");
    let seen = 0;
    return {
      revoked,
      assertRuntimeCurrent: () => {
        seen += 1;
        if (seen > calls) {
          throw revoked;
        }
      },
    };
  }

  it("rethrows the host's original error at prepare and wrap", () => {
    const authority = authorityRevokedAfter(1);
    const custody = new ExecCustody(authority);
    try {
      const env = custody.prepare({}).env;
      let thrown: unknown;
      try {
        custody.wrap({ argv: ["/bin/true"], env, stdinMode: "pipe-open" }, env);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(authority.revoked);
      expect(() => custody.prepare({})).toThrow(authority.revoked);
    } finally {
      custody.dispose();
    }
  });

  it("fails closed when the authority check throws an unexpected value", async () => {
    const custody = new ExecCustody({
      assertRuntimeCurrent: () => {
        throw new TypeError("authority store unavailable");
      },
    });
    try {
      await expect(
        custody.run(
          { argv: ["/bin/true"], env: {}, stdinMode: "pipe-open" },
          { timeoutMs: 10_000, maxBufferBytes: 1024 },
        ),
      ).rejects.toThrow(TypeError);
    } finally {
      custody.dispose();
    }
  });

  it("runs both the incoming spec check and the scope authority at deferred admission", () => {
    let current = true;
    const revoked = new Error("runtime authority revoked");
    const custody = new ExecCustody({
      assertRuntimeCurrent: () => {
        if (!current) {
          throw revoked;
        }
      },
    });
    const callerStale = new Error("caller generation is stale");
    let callerCurrent = true;
    const callerCheck = vi.fn(() => {
      if (!callerCurrent) {
        throw callerStale;
      }
    });
    const env = custody.prepare({}).env;
    const spec = custody.wrap(
      { argv: ["/bin/true"], env, stdinMode: "pipe-open", assertCurrent: callerCheck },
      env,
    );
    try {
      spec.assertCurrent!();
      expect(callerCheck).toHaveBeenCalledTimes(1);
      current = false;
      expect(() => spec.assertCurrent!()).toThrow(revoked);
      expect(callerCheck).toHaveBeenCalledTimes(2);
      current = true;
      callerCurrent = false;
      expect(() => spec.assertCurrent!()).toThrow(callerStale);
    } finally {
      custody.dispose();
    }
  });

  it("rejects at the launch handshake with the original error before the command runs", async () => {
    const workspace = tempWorkspaceSync({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "srt-authority-handshake-",
    });
    const marker = workspace.path("ran");
    // prepare + wrap admit; the launcher handshake is the first rejected check.
    const authority = authorityRevokedAfter(2);
    const custody = new ExecCustody(authority);
    try {
      const started = performance.now();
      let thrown: unknown;
      try {
        await custody.run(
          { argv: ["/bin/sh", "-c", `touch '${marker}'`], env: {}, stdinMode: "pipe-open" },
          { timeoutMs: 30_000, maxBufferBytes: 1024 },
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(authority.revoked);
      // Immediate rejection, not a timeout-driven one.
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(existsSync(marker)).toBe(false);
    } finally {
      custody.dispose();
      workspace.cleanup();
    }
  });

  it("cancels the lease and closes the launcher socket on handshake rejection", async () => {
    let current = true;
    const custody = new ExecCustody({
      assertRuntimeCurrent: () => {
        if (!current) {
          throw new Error("runtime authority revoked");
        }
      },
    });
    const prepared = custody.prepare({});
    const spec = custody.wrap(
      {
        argv: [process.execPath, "-e", "process.exit(0)"],
        env: prepared.env,
        stdinMode: "pipe-open",
      },
      prepared.env,
    );
    current = false;
    try {
      const child = spawn(spec.argv[0]!, spec.argv.slice(1), { env: spec.env, stdio: "ignore" });
      const [code] = (await once(child, "exit")) as [number];
      expect(code).toBe(1);
      // A replayed handshake on the cancelled lease is closed without "ready",
      // even once authority is restored.
      current = true;
      const socket = createConnection(spec.env.SRT_CUSTODY_SOCKET!);
      let received = "";
      socket.on("data", (chunk) => {
        received += chunk.toString();
      });
      socket.on("error", () => {});
      socket.once("connect", () => socket.write(`${spec.env.SRT_CUSTODY_TOKEN}\n`));
      await once(socket, "close");
      expect(received).toBe("");
    } finally {
      custody.dispose();
      await custody.finalize(spec.finalizeToken);
    }
  });

  it("still terminates an overflowing command after authority is revoked mid-run", async () => {
    // prepare + wrap + handshake admit; the run is in flight when authority goes.
    const authority = authorityRevokedAfter(3);
    const limit = 1024;
    const custody = new ExecCustody(authority);
    try {
      await expect(
        custody.run(
          {
            argv: [
              process.execPath,
              "-e",
              "setTimeout(()=>process.stdout.write('x'.repeat(65536)),50); setInterval(()=>{},1000)",
            ],
            env: {},
            stdinMode: "pipe-open",
          },
          { timeoutMs: 30_000, maxBufferBytes: limit },
        ),
      ).rejects.toThrow(`srt-sandbox command stdout exceeded ${limit} bytes`);
      expect(() => custody.assertCurrent()).toThrow(authority.revoked);
    } finally {
      custody.dispose();
    }
  });

  it("releases only a lease it opened when a spec build is abandoned", async () => {
    let current = true;
    const custody = new ExecCustody({
      assertRuntimeCurrent: () => {
        if (!current) {
          throw new Error("runtime authority revoked");
        }
      },
    });
    try {
      const callerEnv = custody.prepare({}).env;
      const reused = custody.ensurePreparedEnv(callerEnv);
      const opened = custody.ensurePreparedEnv({});
      expect(reused.env).toBe(callerEnv);
      expect(existsSync(opened.env.SRT_CUSTODY_SOCKET!)).toBe(true);

      current = false;
      await reused.release();
      await opened.release();
      expect(existsSync(opened.env.SRT_CUSTODY_SOCKET!)).toBe(false);
      expect(existsSync(callerEnv.SRT_CUSTODY_SOCKET!)).toBe(true);
      current = true;
      // The caller's lease is still live for its own spec.
      expect(() =>
        custody.wrap({ argv: ["/bin/true"], env: callerEnv, stdinMode: "pipe-open" }, callerEnv),
      ).not.toThrow();
    } finally {
      custody.dispose();
    }
  });

  it("keeps terminate, finalize, and dispose working after revocation", async () => {
    let current = true;
    const custody = new ExecCustody({
      assertRuntimeCurrent: () => {
        if (!current) {
          throw new Error("runtime authority revoked");
        }
      },
    });
    const prepared = custody.prepare({});
    const spec = custody.wrap(
      { argv: ["/bin/true"], env: prepared.env, stdinMode: "pipe-open" },
      prepared.env,
    );
    current = false;
    await expect(prepared.terminate()).resolves.toBeUndefined();
    await expect(custody.finalize(spec.finalizeToken)).resolves.toBeUndefined();
    expect(() => custody.dispose()).not.toThrow();
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
