import fs from "node:fs";
import path from "node:path";

const command = process.argv.slice(2);

function executable(name) {
  const candidates = name.includes(path.sep)
    ? [path.resolve(name)]
    : (process.env.PATH ?? "").split(path.delimiter).map((dir) => path.resolve(dir, name));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return fs.realpathSync(candidate);
      }
    } catch {
      // Match normal PATH lookup; exec reports an unavailable command below.
    }
  }
  return undefined;
}

function activate() {
  const program = command[0] && executable(command[0]);
  if (!program) {
    console.error("OpenClaw container activation command was not found");
    process.exitCode = 127;
    return;
  }
  // Replace the adapter so tini continues to supervise the original command directly.
  process.execve(program, command, process.env);
}

try {
  activate();
} catch (error) {
  console.error(
    `OpenClaw container activation failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
