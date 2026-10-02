import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { ExecCustody } from "./exec-custody.js";

describe.skipIf(process.platform === "win32")("normal exec lifecycle custody", () => {
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
