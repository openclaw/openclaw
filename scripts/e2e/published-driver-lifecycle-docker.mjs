#!/usr/bin/env node
// Exercise the registered Docker caller with real processes, without installing OpenClaw.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCancelableCommand } from "../lib/cancelable-command.mts";
import { hasUnjoinedWork, runManagedCommand } from "../lib/managed-child-process.mts";

assert.equal(process.platform, "linux", "Run the Docker lifecycle regression on a Linux host");
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-published-driver-lifecycle-"));
const id = randomUUID();
const image = `openclaw-driver-lifecycle-${id}`;
const base = process.env.OPENCLAW_DOCKER_E2E_IMAGE || `${image}-base`;
const env = { ...process.env, TMPDIR: path.join(root, "tmp") };
fs.mkdirSync(env.TMPDIR);
fs.chmodSync(root, 0o755);
const failures = [];

async function run(name, bin, args, options = {}) {
  const out = fs.openSync(path.join(root, `${name}.stdout`), "w");
  const err = fs.openSync(path.join(root, `${name}.stderr`), "w");
  try {
    return await runManagedCommand({
      bin,
      args,
      cwd: source,
      env,
      stdio: ["ignore", out, err],
      requireProcessTreeExit: true,
      ...options,
    });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
}

function json(directory, name) {
  const file = path.join(directory, `${name}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

process.exitCode = await runCancelableCommand(async (signal) => {
  try {
    const context = path.join(root, "image");
    fs.mkdirSync(context);
    fs.copyFileSync(
      path.join(source, "scripts/e2e/lib/upgrade-survivor/published-driver-process-fixture.mjs"),
      path.join(context, "fixture.mjs"),
    );
    fs.writeFileSync(
      path.join(context, "npm"),
      '#!/bin/sh\nexec node /proof/fixture.mjs npm "$@"\n',
    );
    fs.writeFileSync(
      path.join(context, "Dockerfile"),
      `FROM ${base}\nUSER root\nCOPY fixture.mjs /proof/fixture.mjs\nCOPY --chmod=0755 npm /proof/bin/npm\nRUN ln -s /tmp/published-driver-artifacts /fixture\nENV PATH="/proof/bin:\${PATH}"\nUSER appuser\n`,
    );
    assert.equal(
      await run(
        "image",
        "bash",
        [
          "-c",
          'set -euo pipefail; source scripts/lib/docker-e2e-image.sh; docker_e2e_build_or_reuse "$1" driver-lifecycle "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" bare; docker_build_run driver-lifecycle-fixture -t "$2" "$3"',
          "fixture",
          base,
          image,
          context,
        ],
        { signal },
      ),
      0,
      "Lifecycle fixture image failed",
    );
    const payload = path.join(root, "package/dist");
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(
      path.join(payload, "build-info.json"),
      JSON.stringify({ version: "2026.10.1", commit: "synthetic-lifecycle-candidate" }),
    );
    const candidate = path.join(root, "candidate.tgz");
    assert.equal(
      await run("package", "tar", ["-czf", candidate, "-C", root, "package"], { signal }),
      0,
    );
    fs.chmodSync(candidate, 0o644);
    for (const mode of [
      "success",
      "interrupt",
      "timeout",
      "status-failure",
      "success-status-failure",
      "stop-failure",
    ]) {
      const directory = path.join(root, mode);
      fs.mkdirSync(directory, { mode: 0o777 });
      fs.chmodSync(directory, 0o777);
      fs.writeFileSync(path.join(directory, "control.json"), JSON.stringify({ mode }));
      // A tiny inherited deadline exercises the same absolute-budget path without a sleep.
      const seconds = mode === "timeout" ? 64 : 525;
      const started = Date.now();
      const code = await run(
        mode,
        "timeout",
        [
          "--signal=TERM",
          "--kill-after=15s",
          `${seconds}s`,
          "bash",
          "scripts/e2e/published-driver-update-docker.sh",
          candidate,
          directory,
          "2026.9.7",
        ],
        {
          signal,
          env: {
            ...env,
            CELL_DEADLINE_EPOCH_SECONDS: String(Math.floor(Date.now() / 1000) + seconds),
            OPENCLAW_DOCKER_E2E_IMAGE: image,
            OPENCLAW_SKIP_DOCKER_BUILD: "1",
            OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE: "1",
          },
        },
      );
      const events = fs
        .readFileSync(path.join(directory, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const status = events.filter((event) => event.event === "status");
      const update = json(directory, "update-exit");
      const recorded = json(directory, "recorded-run-exit");
      const summary = json(directory, "summary");
      const failure = json(directory, "failure");
      console.log(
        JSON.stringify({ mode, code, durationMs: Date.now() - started, update, recorded, failure }),
      );
      assert.equal(status.length, 1, `${mode}: public status must run exactly once`);
      assert.equal(status[0].runtimeExists, true, `${mode}: runtime removed before status`);
      if (mode === "success") {
        assert.equal(code, 0);
        assert.equal(summary.phase, "finished");
      } else {
        assert.equal(summary, null, `${mode}: failure must not publish success`);
        if (mode === "interrupt" || mode === "timeout") {
          assert.equal(status[0].childSettled, true);
          assert.equal(status[0].childGone, true);
          assert.equal(status[0].updaterGone, true);
          assert.equal(code, mode === "interrupt" ? 143 : 124);
          if (mode === "interrupt") {
            assert.equal(update.receivedSignal, "SIGTERM");
          } else {
            assert.equal(update.code, "ETIMEDOUT");
          }
        } else if (mode === "success-status-failure") {
          assert.equal(code, 9);
          assert.equal(update.status, 0);
          assert.equal(recorded.status, 9);
        } else {
          assert.equal(code, 7);
          assert.equal(update.status, 7);
          assert.deepEqual(
            failure.failures.map((entry) => entry.command),
            ["update", mode === "status-failure" ? "recorded-run" : "stop-service"],
          );
          if (mode === "status-failure") {
            assert.equal(recorded.status, 9);
          } else {
            assert.equal(json(directory, "stop-service-exit").status, 11);
            assert(json(directory, "retained-runtime"));
          }
        }
      }
      assert.equal(
        await run(`${mode}-containers`, "docker", ["ps", "-aq", "--filter", `ancestor=${image}`], {
          signal,
        }),
        0,
      );
      assert.equal(
        fs.readFileSync(path.join(root, `${mode}-containers.stdout`), "utf8").trim(),
        "",
        `${mode}: native caller leaked a container`,
      );
    }
  } catch (error) {
    failures.push(error);
  }
  if (!failures.some(hasUnjoinedWork)) {
    try {
      const images = process.env.OPENCLAW_DOCKER_E2E_IMAGE ? [image] : [image, base];
      // These UUID tags belong exclusively to this invocation; preserve supplied base images.
      assert.equal(
        await run("remove-images", "docker", ["image", "rm", ...images]),
        0,
        "Owned lifecycle image removal failed",
      );
      assert.equal(
        await run("remaining-images", "docker", [
          "image",
          "ls",
          "--format",
          "{{.Repository}}:{{.Tag}}",
        ]),
        0,
      );
      const remainingImages = fs
        .readFileSync(path.join(root, "remaining-images.stdout"), "utf8")
        .trim()
        .split("\n");
      for (const ownedImage of images) {
        assert(
          !remainingImages.includes(`${ownedImage}:latest`),
          `Owned image remains: ${ownedImage}`,
        );
      }
      if (failures.length) {
        for (const name of fs.readdirSync(root).filter((entry) => entry.endsWith(".stderr"))) {
          console.error(fs.readFileSync(path.join(root, name), "utf8"));
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    console.error(`Lifecycle regression failed; retained resources, if any: ${root}`);
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Lifecycle proof and cleanup failed", { cause: failures[0] });
  }
  console.log(
    "PASS registered published-driver lifecycle: six cases, no product package installed",
  );
  return 0;
});
