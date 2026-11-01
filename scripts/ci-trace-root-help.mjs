// Temporary instrumentation for the pinned Grok package diagnostic branch.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

const sourceSha = "70dff2b10c3a896ea6ef14f6d87e38f6479babc8";
const prefix = "[root-help-phase] ";
const traceName = "grok-root-help-phase.jsonl";

if (process.argv[2] === "--verify") {
  const bytes = fs.readFileSync(process.argv[3]);
  assert(bytes.length <= 65536, "phase trace exceeded its diagnostic budget");
  const events = bytes.toString("utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    events.map((event) => event.phase).sort(),
    [
      "parent-spawn-request",
      "parent-spawn",
      "import-start",
      "import-end",
      "render-start",
      "render-end",
      "exit-request",
      "parent-exit",
      "parent-close",
      "observer-finish",
    ].sort(),
  );
  assert.equal(events[0].sourceSha, sourceSha);
  assert.equal(events.at(-1).matches, 1);
  assert.equal(events.at(-1).code, 0);
  for (const phase of ["parent-exit", "parent-close"]) {
    const event = events.find((entry) => entry.phase === phase);
    assert.equal(event.code, 0);
    assert.equal(event.signal, null);
    if (phase === "parent-close") assert(event.stdoutBytes > 0);
  }
  console.log("Verified one complete bundled root-help phase observation.");
} else if (isMainThread && process.argv[1] && process.env.RUNNER_TEMP) {
  const script = path.resolve(process.argv[1]);
  const sourceRoot = path.dirname(path.dirname(script));
  const temporaryRoot = fs.realpathSync(process.env.RUNNER_TEMP);
  if (
    script === path.join(sourceRoot, "scripts/write-cli-startup-metadata.ts") &&
    path.dirname(sourceRoot) === temporaryRoot &&
    /^openclaw-package-source-\d+$/.test(path.basename(sourceRoot))
  ) {
    assert.equal(
      childProcess
        .execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        })
        .trim(),
      sourceSha,
    );
    const tracePath = path.join(temporaryRoot, traceName);
    const record = (event) => {
      const line = JSON.stringify(event) + "\n";
      fs.appendFileSync(tracePath, line, { mode: 0o600 });
      fs.writeSync(2, prefix + line);
    };
    const mark = (phase, extra = {}) => record({ phase, at: Date.now(), ...extra });
    const original = childProcess.spawn;
    let matches = 0;
    childProcess.spawn = function (command, args, options) {
      const index = Array.isArray(args) ? args.indexOf("--eval") : -1;
      const payload = index >= 0 ? args[index + 1] : undefined;
      if (
        typeof payload !== "string" ||
        !payload.includes("const mod = await import(") ||
        !payload.includes("/dist/root-help-") ||
        !payload.includes("await mod.outputRootHelp(")
      ) {
        return original.call(this, command, args, options);
      }
      assert.equal(++matches, 1);
      assert.equal(command, process.execPath);
      assert.equal(options.cwd, path.join(sourceRoot, "dist"));
      assert(args.includes("--input-type=module"));
      const lines = payload.split("\n");
      const importLine = lines.find((line) => line.startsWith("const mod = await import("));
      const renderLine = lines.find((line) => line.startsWith("await mod.outputRootHelp("));
      assert(importLine && renderLine);
      assert.equal(lines.filter((line) => line === "process.exit(0);").length, 1);
      const imported = fileURLToPath(
        JSON.parse(importLine.slice("const mod = await import(".length, -2)),
      );
      assert.equal(path.dirname(imported), path.join(sourceRoot, "dist"));
      assert(/^root-help-[A-Za-z0-9_-]+\.mjs$/.test(path.basename(imported)));
      const childMark = (phase) => `__ocPhase(${JSON.stringify(phase)});`;
      const observedArgs = args.slice();
      observedArgs[index + 1] = [
        'import { writeSync as __ocWrite } from "node:fs";',
        `const __ocPhase = phase => __ocWrite(2, "\\n${prefix}" + JSON.stringify({phase, at:Date.now()}) + "\\n");`,
        ...lines.flatMap((line) =>
          line === importLine
            ? [childMark("import-start"), line, childMark("import-end")]
            : line === renderLine
              ? [childMark("render-start"), line, childMark("render-end")]
              : line === "process.exit(0);"
                ? [childMark("exit-request"), line]
                : [line],
        ),
      ].join("\n");
      mark("parent-spawn-request", {
        sourceSha,
        bundle: path.basename(imported),
        node: process.version,
      });
      const child = original.call(this, command, observedArgs, options);
      let stdoutBytes = 0;
      let pending = "";
      child.stdout?.on("data", (chunk) => {
        stdoutBytes += Buffer.byteLength(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        const lines = (pending + chunk.toString()).split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith(prefix)) record(JSON.parse(line.slice(prefix.length)));
        }
        if (pending.length > 8192) pending = "";
      });
      child.once("spawn", () => mark("parent-spawn"));
      child.once("error", (error) => mark("parent-error", { code: error.code }));
      child.once("exit", (code, signal) => mark("parent-exit", { code, signal, stdoutBytes }));
      child.once("close", (code, signal) => mark("parent-close", { code, signal, stdoutBytes }));
      return child;
    };
    syncBuiltinESMExports();
    process.once("exit", (code) => mark("observer-finish", { matches, code }));
  }
}
