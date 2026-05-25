#!/usr/bin/env node
/**
 * Release preflight — run before tagging ClaWorks.
 *
 * Usage:
 *   pnpm claworks:release:preflight
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: root, stdio: "inherit", ...opts });
}

function check(label, fn) {
  try {
    fn();
    console.log(`✅ ${label}`);
    return true;
  } catch (err) {
    console.error(`❌ ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

const results = [];

results.push(
  check("runtime tests", () => {
    run("pnpm claworks:runtime:test");
  }),
);

results.push(
  check("claworks smoke", () => {
    run("pnpm claworks:smoke", { env: { ...process.env, CLAWORKS_PRODUCT: "1" } });
  }),
);

results.push(
  check("robot plugin contract", () => {
    run("pnpm test extensions/claworks-robot");
  }),
);

results.push(
  check("OT connector dry-run", () => {
    run("pnpm claworks:ot-dry-run");
  }),
);

if (process.env.CLAWORKS_PREFLIGHT_EVOLUTION === "1") {
  results.push(
    check("evolution chain smoke", () => {
      run("pnpm claworks:evolution:smoke", { env: { ...process.env, CLAWORKS_PRODUCT: "1" } });
    }),
  );
} else {
  console.log("\n[preflight] skip evolution smoke (set CLAWORKS_PREFLIGHT_EVOLUTION=1 to include)");
}

if (process.env.CLAWORKS_PREFLIGHT_GATEWAY === "1") {
  results.push(
    check("gateway e2e", () => {
      run("pnpm claworks:gateway:e2e", { env: { ...process.env, CLAWORKS_PRODUCT: "1" } });
    }),
  );
} else {
  console.log("\n[preflight] skip gateway e2e (set CLAWORKS_PREFLIGHT_GATEWAY=1 to include)");
}

results.push(
  check("docker compose prod config", () => {
    if (!existsSync(path.join(root, "docker-compose.prod.yml"))) {
      throw new Error("docker-compose.prod.yml missing");
    }
    run("docker compose -f docker-compose.prod.yml config");
  }),
);

results.push(
  check("runtime publish dry-run", () => {
    run("pnpm claworks:runtime:publish:dry-run");
  }),
);

if (process.env.CLAWORKS_PREFLIGHT_ROOT_PACK !== "0") {
  results.push(
    check("root publish dry-run", () => {
      run("pnpm claworks:publish:dry-run");
    }),
  );
}

results.push(
  check("git working tree", () => {
    const status = execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim();
    if (status) {
      console.warn(
        "[preflight] working tree not clean:\n" + status.split("\n").slice(0, 10).join("\n"),
      );
      throw new Error("uncommitted changes present");
    }
  }),
);

const failed = results.filter((ok) => !ok).length;
if (failed > 0) {
  console.error(`\n[preflight] ${failed} check(s) failed`);
  process.exit(1);
}

console.log("\n[preflight] all checks passed — ready for maintainer tag + release notes");
