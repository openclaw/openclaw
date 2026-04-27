import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEBUG_PATH = "/tmp/openclaw-agent-exec-dispatch-debug.jsonl";
const append = (event, extra = {}) => {
  fs.appendFileSync(
    DEBUG_PATH,
    `${JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, event, ...extra })}\n`,
  );
};

const distDir = path.resolve(import.meta.dirname, "..", "dist");
const programModuleName = fs
  .readdirSync(distDir)
  .filter((name) => /^program-.*\.js$/.test(name) && !name.startsWith("program-context-"))
  .toSorted()
  .at(-1);

if (!programModuleName) {
  throw new Error("No built program module found in dist/");
}

append("micro_repro_program_module_selected", { program_module: programModuleName });
const imported = await import(pathToFileURL(path.join(distDir, programModuleName)).href);
append("micro_repro_program_module_exports", { exports: Object.keys(imported) });
const buildProgram = imported.buildProgram ?? imported.b;
if (typeof buildProgram !== "function") {
  throw new Error(`buildProgram export not found in ${programModuleName}`);
}

const argv = [
  "node",
  "openclaw",
  "agent-exec",
  "--agent",
  "klaus",
  "--job-id",
  "x",
  "--job-path",
  "y",
  "--timeout",
  "300",
];

process.argv = argv;
append("micro_repro_start", { argv });
const program = buildProgram();
append("micro_repro_after_build_program", {
  registered_commands: program.commands.map((command) => command.name()),
});
try {
  await program.parseAsync(argv);
  append("micro_repro_after_parse_async", {
    registered_commands: program.commands.map((command) => command.name()),
  });
} catch (error) {
  append("micro_repro_parse_async_catch", {
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === "object" && "code" in error ? error.code : undefined,
    exitCode:
      error && typeof error === "object" && "exitCode" in error ? error.exitCode : undefined,
  });
}
