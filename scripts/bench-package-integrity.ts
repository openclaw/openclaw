import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { createPackageIntegrityReader } from "../src/infra/package-update-integrity.js";

// Pass bundled baseline and candidate integrity modules; both scan the same inodes.
const modules = await Promise.all(
  process.argv.slice(2).map(async (file) => {
    const module = (await import(pathToFileURL(path.resolve(file)).href)) as {
      createPackageIntegrityReader: typeof createPackageIntegrityReader;
    };
    return { file, create: module.createPackageIntegrityReader };
  }),
);
if (modules.length !== 2) {
  throw new Error("Usage: bench-package-integrity.ts <baseline-module> <candidate-module>");
}
const root = await fs.mkdtemp(path.resolve(".artifacts/package-integrity-bench-"));
const lstat = fs.lstat;
try {
  await fs.writeFile(path.join(root, "package.json"), '{"version":"1.0.0"}');
  await fs.mkdir(path.join(root, "dist"));
  for (let index = 0; index < 2048; index++) {
    await fs.writeFile(path.join(root, "dist", `file-${index}.js`), "x".repeat(4096));
  }
  await fs.symlink("file-0.js", path.join(root, "dist", "link.js"));
  await fs.link(path.join(root, "dist", "file-0.js"), path.join(root, "dist", "hardlink.js"));
  let fingerprint: unknown;
  for (let sample = 0; sample < 6; sample++) {
    for (const { file, create } of modules) {
      const seen = new Set<string>();
      let calls = 0;
      let sweepStarted: number | undefined;
      let inFlight = 0;
      let peak = 0;
      fs.lstat = new Proxy(lstat, {
        apply(target, receiver, args) {
          const name = String(args[0]);
          if (name !== root && seen.has(name)) {
            sweepStarted ??= performance.now();
          }
          seen.add(name);
          calls++;
          peak = Math.max(peak, ++inFlight);
          return Reflect.apply(target, receiver, args).finally(() => inFlight--);
        },
      });
      const cpu = process.cpuUsage();
      const started = performance.now();
      const result = await create().rootEntry(root);
      const ended = performance.now();
      const cpuUsed = process.cpuUsage(cpu);
      if (fingerprint && JSON.stringify(fingerprint) !== JSON.stringify(result)) {
        throw new Error("Fingerprint changed between scans");
      }
      fingerprint = result;
      console.log(
        JSON.stringify({
          file,
          sample,
          phase: sample === 0 ? "cold" : "warm",
          elapsedMs: ended - started,
          sweepMs: ended - (sweepStarted ?? started),
          cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
          rss: process.memoryUsage().rss,
          calls,
          peak,
          fingerprint,
        }),
      );
      fs.lstat = lstat;
    }
  }
} finally {
  fs.lstat = lstat;
  await fs.rm(root, { recursive: true, force: true });
}
