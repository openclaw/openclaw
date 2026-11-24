#!/usr/bin/env node
// Git release survivor helpers: what serves, and kill -9 of an updater at a named point.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const readdir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};
const readlink = (file) => {
  try {
    return fs.readlinkSync(file);
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return !stat.slice(stat.lastIndexOf(") ") + 2).startsWith("Z");
  } catch {
    return false;
  }
};
const releaseIds = (prefix) =>
  readdir(path.join(prefix, "releases")).filter((name) => !name.startsWith("."));

/** The link, the release it resolves to, and every release a live process holds a lease on. */
function serving(prefix) {
  const slot = path.join(prefix, "openclaw");
  let realpath = null;
  try {
    realpath = fs.realpathSync(slot);
  } catch {}
  const leases = path.join(prefix, "releases", ".leases");
  const leased = {};
  for (const id of readdir(leases)) {
    for (const name of readdir(path.join(leases, id))) {
      const pid = Number(/^(\d+)-/u.exec(name)?.[1]);
      if (pid && alive(pid)) {
        (leased[id] ??= []).push(pid);
      }
    }
  }
  return {
    link: readlink(slot),
    linkId: realpath ? path.basename(path.dirname(realpath)) : null,
    realpath,
    leased,
    releases: releaseIds(prefix),
  };
}

function processArgv(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Run an updater in its own process group and SIGKILL the whole group once `point` is
 * reached. Each point is recognized by what the updater leaves on disk or runs:
 * - stage: the new release's worktree exists (`releases/<id>/openclaw/.git`), no `node_modules` yet
 * - build: the new release's `node_modules` exists (pnpm install has started)
 * - publish: the release smoke (`<release>/openclaw.mjs --version`) runs; the link has not moved
 * - link-switch: the link names the new release
 */
async function killAt(point, prefix, out, stdout, stderr, argv) {
  const before = new Set(releaseIds(prefix));
  const slot = path.join(prefix, "openclaw");
  const linkBefore = readlink(slot);
  const started = Date.now();
  const child = spawn(argv[0], argv.slice(1), {
    detached: true,
    stdio: ["ignore", fs.openSync(stdout, "w"), fs.openSync(stderr, "w")],
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  // The detached child leads its own process group; killing the group takes its descendants too.
  const group = -Number(child.pid);
  const run = { done: false };
  void exited.then(() => {
    run.done = true;
  });
  const record = { point, linkBefore, command: argv.join(" ") };
  const fresh = () => releaseIds(prefix).find((id) => !before.has(id));
  while (!run.done && Date.now() - started < 3_600_000) {
    const id = fresh();
    const root = id ? path.join(prefix, "releases", id, "openclaw") : null;
    const link = readlink(slot);
    const linkMoved = Boolean(id && link?.split(/[\\/]/u).includes(id));
    let observed = null;
    if (root && point === "stage") {
      if (
        fs.existsSync(path.join(root, ".git")) &&
        !fs.existsSync(path.join(root, "node_modules"))
      ) {
        observed = { worktreeEntries: readdir(root).length };
      }
    } else if (root && point === "build") {
      if (fs.existsSync(path.join(root, "node_modules"))) {
        observed = {
          nodeModulesEntries: readdir(path.join(root, "node_modules")).length,
          distIndex: fs.existsSync(path.join(root, "dist", "index.js")),
        };
      }
    } else if (root && point === "publish") {
      if (linkMoved) {
        record.missed = "the link moved before the release smoke was seen";
        break;
      }
      const smoke = path.join(root, "openclaw.mjs");
      for (const pid of readdir("/proc").filter((name) => /^\d+$/u.test(name))) {
        const args = processArgv(pid);
        const at = args.indexOf(smoke);
        if (at > 0 && args[at + 1] === "--version") {
          observed = { smokePid: Number(pid), smoke: args.join(" ") };
          break;
        }
      }
    } else if (root && point === "link-switch" && linkMoved) {
      observed = { link };
    }
    if (observed) {
      try {
        // The lane simulates a crash at this point: a graceful stop would defeat it.
        process.kill(group, "SIGKILL"); // nosemgrep: security.opengrep.ghsa-jfv4-h8mc-jcp8.immediate-process-tree-sigkill
      } catch {}
      Object.assign(record, {
        reached: true,
        releaseId: id,
        reachedAfterMs: Date.now() - started,
        observed,
        linkAtKill: readlink(slot),
      });
      break;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  if (!record.reached && !run.done) {
    try {
      process.kill(group, "SIGKILL"); // nosemgrep: security.opengrep.ghsa-jfv4-h8mc-jcp8.immediate-process-tree-sigkill
    } catch {}
  }
  record.exit = await exited;
  record.linkAfter = readlink(slot);
  fs.writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record));
  if (!record.reached) {
    process.exitCode = 1;
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "serving") {
  console.log(JSON.stringify(serving(args[0])));
} else if (command === "kill") {
  const separator = args.indexOf("--");
  const [point, prefix, out, stdout, stderr] = args.slice(0, separator);
  await killAt(point, prefix, out, stdout, stderr, args.slice(separator + 1));
} else {
  console.error(
    "usage: git-release.mjs serving <prefix> | kill <point> <prefix> <out> <stdout> <stderr> -- <argv>",
  );
  process.exitCode = 2;
}
