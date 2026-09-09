import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = "1.4.0";
const archives = {
  "linux-x64": "2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452",
  "linux-x64-baseline": "184fb4595f0d401a217cf7c78c1bc430ba83314dab7a8b94805babbf7fa7097f",
};

async function optimizedSupported() {
  let cpuinfo;
  try {
    cpuinfo = await readFile("/proc/cpuinfo", "utf8");
  } catch {
    return false;
  }
  let cpu = false;
  let flags;
  let seen = false;
  let missing = false;
  function finishCpu() {
    if (cpu) {
      seen = true;
      if (!flags?.includes("avx") || !flags.includes("avx2")) {
        missing = true;
      }
    }
    cpu = false;
    flags = undefined;
  }
  // A later processor record without flags must not inherit an earlier CPU's evidence.
  for (const line of cpuinfo.split("\n")) {
    const colon = line.indexOf(":");
    const key = line.slice(0, colon).trim();
    if (!line.trim() || key === "processor") {
      finishCpu();
      cpu = key === "processor";
    } else if (key === "flags") {
      if (!cpu || flags) {
        missing = true;
      }
      flags = line
        .slice(colon + 1)
        .trim()
        .split(/\s+/u);
    }
  }
  finishCpu();
  return seen && !missing;
}

async function seed() {
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    !process.report.getReport().header.glibcVersionRuntime
  ) {
    return;
  }
  const variant = (await optimizedSupported()) ? "linux-x64" : "linux-x64-baseline";
  const name = `bun-v${version}-${variant}.zip`;
  let source;
  try {
    source = await open(
      join("/opt/crabbox/toolchain-archives", name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  let destination;
  let ready = false;
  try {
    if (!(await source.stat()).isFile()) {
      throw new Error(`${name} is not a regular archive`);
    }
    destination = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "openclaw-bun-"));
    const archive = join(destination, name);
    await writeFile(archive, await source.readFile(), { mode: 0o600, flag: "wx" });
    if (
      createHash("sha256")
        .update(await readFile(archive))
        .digest("hex") !== archives[variant]
    ) {
      throw new Error(`${name} failed SHA256 verification`);
    }
    const member = `bun-${variant}/bun`;
    const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" })
      .trim()
      .split("\n");
    if (
      entries.filter((entry) => entry === member).length !== 1 ||
      entries.some((entry) => entry !== member && entry !== `bun-${variant}/`)
    ) {
      throw new Error(`${name} has an unexpected archive layout`);
    }
    const bin = join(destination, "bin");
    await mkdir(bin, { mode: 0o700 });
    const executable = join(bin, "bun");
    const output = await open(executable, "wx", 0o600);
    try {
      // Stream only the authenticated member into a new regular file, never archive paths.
      execFileSync("unzip", ["-p", archive, member], { stdio: ["ignore", output.fd, "pipe"] });
    } finally {
      await output.close();
    }
    await chmod(executable, 0o755);
    const actual = execFileSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    if (actual !== version) {
      throw new Error(`Expected Bun ${version}, got ${actual}`);
    }
    await symlink("bun", join(bin, "bunx"));
    await rm(archive);
    ready = true;
    process.stdout.write(`${bin}\n`);
  } finally {
    await source.close();
    if (destination && !ready) {
      await rm(destination, { recursive: true, force: true });
    }
  }
}

try {
  await seed();
} catch (error) {
  console.error(`Bun image cache: ${error.message}`);
  process.exitCode = 1;
}
