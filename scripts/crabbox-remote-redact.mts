import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants, homedir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  hasRegisteredSecretValuesForRedaction,
  registerSecretValueForRedaction,
} from "../src/logging/secret-redaction-registry.ts";
import { createStreamSecretRedactor } from "./lib/stream-secret-redaction.mts";

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";
}

function registerProfileValues(): boolean {
  const profilePath =
    process.env.OPENCLAW_TESTBOX_PROFILE_FILE ||
    path.join(process.env.HOME || homedir(), ".openclaw-testbox-live.profile");
  let profile: string;
  try {
    profile = readFileSync(profilePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
  const names = [...profile.matchAll(/^export ([A-Za-z_][A-Za-z0-9_]*)=/gm)].flatMap(([, name]) =>
    name ? [name] : [],
  );
  if (names.length === 0) {
    return false;
  }
  const values = execFileSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      'set -a; . "$1"; shift; for n; do printf "%s\\0" "${!n-}"; done',
      "_",
      profilePath,
      ...names,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  for (const value of values.split("\0")) {
    if (value) {
      registerSecretValueForRedaction(value);
      registerSecretValueForRedaction(Buffer.from(value, "utf8").toString("latin1"));
    }
  }
  return hasRegisteredSecretValuesForRedaction();
}

function forwardRedactedStream(source: Readable, destination: Writable): Promise<void> {
  return new Promise((resolve) => {
    const redactor = createStreamSecretRedactor((value) => `<redacted len=${value.length}>`);
    const write = (text: string) => {
      if (text && !destination.write(Buffer.from(text, "latin1"))) {
        source.pause();
        destination.once("drain", () => source.resume());
      }
    };
    source.on("data", (chunk: Buffer) => {
      write(redactor.push(chunk.toString("latin1")));
    });
    source.once("end", () => {
      write(redactor.end());
      resolve();
    });
  });
}

async function main(): Promise<number> {
  const [separator, command, ...args] = process.argv.slice(2);
  if (separator !== "--" || !command) {
    console.error("Usage: node scripts/crabbox-remote-redact.mjs -- <command> [args...]");
    return 2;
  }
  let redact: boolean;
  try {
    redact = registerProfileValues();
  } catch (error) {
    console.error(`crabbox-remote-redact: profile ${errorCode(error)}`);
    return 1;
  }
  const child = spawn(command, args, {
    env: process.env,
    stdio: redact ? ["inherit", "pipe", "pipe"] : "inherit",
  });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = signals.map((signal) => {
    const handler = () => child.kill(signal);
    process.on(signal, handler);
    return { signal, handler };
  });
  const output =
    redact && child.stdout && child.stderr
      ? [
          forwardRedactedStream(child.stdout, process.stdout),
          forwardRedactedStream(child.stderr, process.stderr),
        ]
      : [];
  const result = await new Promise<number>((resolve) => {
    child.once("error", (error) => {
      console.error(`crabbox-remote-redact: ${command} ${errorCode(error)}`);
      resolve(1);
    });
    child.once("close", (code, signal) =>
      resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)),
    );
  });
  await Promise.all(output);
  for (const { signal, handler } of handlers) {
    process.off(signal, handler);
  }
  return result;
}

process.exitCode = await main();
