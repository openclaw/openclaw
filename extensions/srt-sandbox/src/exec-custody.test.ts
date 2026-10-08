import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, tempWorkspaceSync } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, it } from "vitest";
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
            { timeoutMs: 2000 },
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
