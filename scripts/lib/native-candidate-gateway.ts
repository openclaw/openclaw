import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runManagedCommand } from "./managed-child-process.mjs";

const require = createRequire(import.meta.url);

/** Q owns source selection, staging and cleanup; C owns only isolated build/runtime state. */
export async function prepareNativeCandidateGateway(options: {
  candidateDir: string;
  targetSha: string;
  signal: AbortSignal;
}) {
  if (!/^[a-f0-9]{40}$/u.test(options.targetSha)) {
    throw new Error("Candidate isolation requires an exact source commit.");
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("Native candidate isolation supports only macOS and Linux.");
  }
  const helper = fileURLToPath(
    new URL(
      process.platform === "darwin" ? "./native-candidate-macos.py" : "./native-candidate-linux.py",
      import.meta.url,
    ),
  );
  // Q fixture roots are private (0700); the isolated UID needs its own traversable parent.
  const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : os.tmpdir();
  const root = path.join(
    await realpath(temporaryRoot),
    "openclaw-native-candidate-" + randomUUID(),
  );
  const pkg = z
    .object({ packageManager: z.string() })
    .parse(JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")));
  const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)(?:\+|$)/u.exec(pkg.packageManager)?.[1];
  if (!pnpmVersion) {
    throw new Error("Qualification toolchain must pin a pnpm version.");
  }
  const run = async (args: string[], signal?: AbortSignal) => {
    const code = await runManagedCommand({
      bin: "python3",
      args: [helper, ...args],
      cwd: path.resolve(options.candidateDir),
      env: { PATH: process.env.PATH, LANG: "en_US.UTF-8" },
      signal,
      timeoutMs: args[0] === "build" ? 1_860_000 : 60_000,
      requireProcessTreeExit: true,
      stdio: ["ignore", "pipe", "pipe"],
      onReady(child) {
        // Candidate bytes must never become Actions workflow commands.
        for (const stream of [child.stdout, child.stderr]) {
          stream?.on("data", (chunk: Buffer) => {
            process.stderr.write(
              "[candidate-isolation] " + JSON.stringify(chunk.toString("utf8")) + "\n",
            );
          });
        }
      },
    });
    if (code !== 0) {
      throw new Error("Candidate isolation " + args[0] + " failed (exit " + code + ").");
    }
  };
  const dispose = () => run(["cleanup", "--root", root]);
  try {
    await run(
      [
        "build",
        "--source-dir",
        path.resolve(options.candidateDir),
        "--target-sha",
        options.targetSha,
        "--root",
        root,
        "--node",
        process.execPath,
        "--npm-dir",
        path.dirname(require.resolve("npm/package.json")),
        "--pnpm-version",
        pnpmVersion,
      ],
      options.signal,
    );
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Candidate isolation and cleanup failed.", {
        cause: cleanupError,
      });
    }
    throw error;
  }
  return {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    entrypoint: [
      fileURLToPath(new URL("./native-candidate-entrypoint.mjs", import.meta.url)),
      "--helper",
      helper,
      "--root",
      root,
    ],
    identity: {
      kind: "candidate-source" as const,
      targetSha: options.targetSha,
      // This is Q's supplied source identity, not an attestation by C's build output.
      sourceSha: options.targetSha,
    },
    dispose,
  };
}
