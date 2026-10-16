// Image activation owns unattended retained-volume repair; ordinary CLI startup only admits state.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCommandOptionsWithRootOptions } from "./cli-root-options.mjs";
import {
  GATEWAY_RUN_BOOLEAN_FLAGS,
  GATEWAY_RUN_VALUE_FLAGS,
  isForegroundGatewayRunArgv,
} from "./gateway-run-argv.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
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

function gatewayInvocation(program) {
  if (!command.length) {
    throw new Error("Docker entrypoint requires a command");
  }
  let argv;
  if (program === fs.realpathSync(process.execPath) && command[1]) {
    let entry;
    try {
      entry = fs.realpathSync(command[1]);
    } catch {
      return undefined;
    }
    if (
      !["openclaw.mjs", "dist/index.js", "dist/entry.js", "dist/entry.mjs"].some(
        (file) => entry === path.join(root, file),
      )
    ) {
      return undefined;
    }
    argv = [process.execPath, entry, ...command.slice(2)];
  } else if (program === path.join(root, "openclaw.mjs")) {
    argv = [process.execPath, program, ...command.slice(1)];
  } else {
    return undefined;
  }
  if (!isForegroundGatewayRunArgv(argv)) {
    return undefined;
  }
  const options = getCommandOptionsWithRootOptions(argv, {
    commandPath: ["gateway"],
    booleanFlags: [...GATEWAY_RUN_BOOLEAN_FLAGS],
    valueFlags: [...GATEWAY_RUN_VALUE_FLAGS],
    mode: "command-path",
  });
  // Reset owns deletion before initialization; do not migrate state it will discard.
  return options && !options.commandOptions.includes("--reset") ? options : undefined;
}

// Doctor reads this fact to skip a repeated full pre-repair capture; repairs still run.
const ACTIVATION_REPEAT_ENV = "OPENCLAW_IMAGE_ACTIVATION_REPEAT";

// A container keeps its image, environment, and mounts across stop/start, and its
// writable layer survives them. A marker there records that this container already
// completed Doctor activation, whose first run retained the pre-repair originals.
// A new image or recreated container starts without it and captures again.
function activationMarker(rootOptions) {
  const key = createHash("sha256")
    .update(JSON.stringify([root, rootOptions]))
    .digest("hex")
    .slice(0, 32);
  return path.join(os.tmpdir(), `openclaw-image-activation-${process.getuid?.() ?? "user"}-${key}`);
}

function activationCompleted(marker) {
  try {
    const stat = fs.lstatSync(marker);
    return stat.isFile() && (process.getuid === undefined || stat.uid === process.getuid());
  } catch {
    return false;
  }
}

function recordActivationCompleted(marker) {
  try {
    fs.writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
  } catch {
    // Best effort: without the marker the next start retains another capture.
  }
}

async function activate() {
  const program = command[0] && executable(command[0]);
  if (!program) {
    console.error("OpenClaw container activation command was not found");
    process.exitCode = 127;
    return;
  }
  const invocation = gatewayInvocation(program);
  if (invocation) {
    let interrupted;
    let child;
    const listeners = new Map();
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"]) {
      const listener = () => {
        interrupted ??= signal;
        // Doctor's maintenance barriers own INT/TERM; HUP/QUIT must use that drain too.
        child?.kill(signal === "SIGHUP" || signal === "SIGQUIT" ? "SIGTERM" : signal);
      };
      process.on(signal, listener);
      listeners.set(signal, listener);
    }
    const marker = activationMarker(invocation.rootOptions);
    const env = { ...process.env };
    delete env[ACTIVATION_REPEAT_ENV];
    if (activationCompleted(marker)) {
      env[ACTIVATION_REPEAT_ENV] = "1";
    }
    try {
      child = spawn(
        process.execPath,
        [
          path.join(root, "openclaw.mjs"),
          ...invocation.rootOptions,
          "doctor",
          "--fix",
          "--non-interactive",
        ],
        { stdio: "inherit", env },
      );
      /** @type {Error | undefined} */
      let failure;
      child.on("error", (error) => {
        failure = error;
      });
      const outcome = await new Promise((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      if (failure) {
        throw failure;
      }
      const signal = interrupted ?? outcome.signal;
      if (signal || outcome.code !== 0) {
        process.exitCode = signal ? 128 + os.constants.signals[signal] : (outcome.code ?? 1);
        return;
      }
      recordActivationCompleted(marker);
    } finally {
      for (const [signal, listener] of listeners) {
        process.off(signal, listener);
      }
    }
  }
  // Replace the adapter so tini continues to supervise the original command directly.
  process.execve(program, command, process.env);
}

try {
  await activate();
} catch (error) {
  console.error(
    `OpenClaw container activation failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
