import { isDeepStrictEqual } from "node:util";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type CrabboxRuntimeInstallationIdentity = {
  nodeBootstrap: {
    sha256: string;
    bytes: number;
    manifestSha256: string;
    buildId: string;
    openclawVersion: string;
    enabledPluginIds: readonly string[];
  };
  workerBundle: { sha256: string; bytes: number; packageRelativePath: string };
};

/** A completed install result, never live authority or permission to skip native verification. */
export type CrabboxRuntimeInstallation = CrabboxRuntimeInstallationIdentity & {
  schema: "openclaw.runtime-installation.v1";
  disposition: "installed" | "existing-verified";
  installationVerified: true;
};

/** Parse the same owner result from the existing producer manifest or capture input. */
export function parseCrabboxRuntimeInstallation(
  value: unknown,
  expected: CrabboxRuntimeInstallationIdentity,
): CrabboxRuntimeInstallation {
  if (
    !isRecord(value) ||
    value.schema !== "openclaw.runtime-installation.v1" ||
    value.installationVerified !== true ||
    (value.disposition !== "installed" && value.disposition !== "existing-verified") ||
    !isDeepStrictEqual(value.nodeBootstrap, expected.nodeBootstrap) ||
    !isDeepStrictEqual(value.workerBundle, expected.workerBundle)
  ) {
    throw new Error("Runtime installation result differs from the admitted artifacts");
  }
  return {
    schema: "openclaw.runtime-installation.v1",
    disposition: value.disposition === "installed" ? "installed" : "existing-verified",
    installationVerified: true,
    nodeBootstrap: expected.nodeBootstrap,
    workerBundle: expected.workerBundle,
  };
}

/** Consume only stdout from one successful native installer command. */
export function readCrabboxRuntimeInstallation(
  output: string,
  expected: CrabboxRuntimeInstallationIdentity,
): CrabboxRuntimeInstallation {
  const lines = output.split("\n").filter((line) => line.startsWith("openclaw.runtime-installed:"));
  if (lines.length !== 1 || Buffer.byteLength(lines[0]!, "utf8") > 16384) {
    throw new Error("Native installer must return one bounded runtime installation result");
  }
  return parseCrabboxRuntimeInstallation(
    JSON.parse(lines[0]!.slice("openclaw.runtime-installed:".length)),
    expected,
  );
}

/** Shared native verification and result reporting, not a full installed-payload hash. */
export const CRABBOX_RUNTIME_VERIFICATION_SOURCE = `
  const verifyRuntime = async (root, fresh = false) => {
    setPhase("runtime verification");
    if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root) throw new Error("Cloud worker bootstrap runtime path is unsafe");
    const packageRoot = path.join(root, "node_modules", "openclaw");
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== "openclaw" || manifest.version !== bootstrap.openclawVersion) throw new Error("Cloud worker bootstrap package identity does not match the Gateway");
    if (bootstrap.install !== "npm") {
    const inventoryBytes = fs.readFileSync(path.join(packageRoot, "node-runtime.manifest.json"));
    if (!bootstrap.manifestSha256 || crypto.createHash("sha256").update(inventoryBytes).digest("hex") !== bootstrap.manifestSha256) throw new Error("Cloud worker runtime inventory does not match the Gateway");
    const metadataBytes = fs.readFileSync(path.join(packageRoot, "node-runtime.json"));
    const metadata = JSON.parse(metadataBytes);
    if (!bootstrap.buildId || metadata.buildId !== bootstrap.buildId || metadata.openclawVersion !== bootstrap.openclawVersion) throw new Error("Cloud worker runtime build identity does not match the Gateway");
    if ((metadata.install ?? "bundle") !== (bootstrap.install ?? "bundle")) throw new Error("Cloud worker runtime installation mode does not match the Gateway");
    const target = metadata.platforms.find((item) => item.platform === process.platform && item.arch === process.arch);
    if (!target) throw new Error("Cloud worker runtime has no prepared dependencies for " + process.platform + "/" + process.arch + "; prepare the matching runtime on the Gateway before provisioning");
    if (fresh && target.prefix) {
      fs.renameSync(path.join(packageRoot, "node_modules"), path.join(packageRoot, ".host-node_modules"));
      fs.renameSync(path.join(packageRoot, target.prefix, "node_modules"), path.join(packageRoot, "node_modules"));
    }
    }
    const probe = spawnSync(process.execPath, [path.join(packageRoot, "openclaw.mjs"), "--version"], { env: nodeEnv, encoding: "utf8", timeout: 60000 });
    const version = probe.stdout?.trim();
    const expected = "OpenClaw " + bootstrap.openclawVersion;
    if (probe.status !== 0 || (version !== expected && !version?.startsWith(expected + " "))) throw subprocessError("Cloud worker bootstrap CLI could not verify its Gateway version", probe);
  };

  const verifyArchive = async (source, artifact) => {
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    for await (const chunk of source) {
      bytes += chunk.byteLength;
      if (bytes > artifact.bytes) throw new Error("Cloud worker bootstrap archive exceeds its declared size");
      hash.update(chunk);
    }
    if (bytes !== artifact.bytes || hash.digest("hex") !== artifact.sha256) throw new Error("Cloud worker bootstrap archive failed integrity verification");
  };

  const workerArchivePath = (root) => {
    const relative = workerBundle.packageRelativePath;
    const parts = relative.split("/");
    if (parts.length !== 2 || !/^[a-z][a-z-]*$/.test(parts[0]) || parts[1] !== workerBundle.sha256 + ".tgz" || !/^[a-f0-9]{64}$/.test(workerBundle.sha256)) throw new Error("Cloud worker archive package path is invalid");
    return path.join(root, "node_modules", "openclaw", ...parts);
  };
  const verifyWorkerArchive = async (root) => {
    setPhase("worker archive verification");
    const archive = workerArchivePath(root);
    let handle;
    // A non-regular artifact (including a FIFO) must reject without blocking preparation.
    try { handle = await fsp.open(archive, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== workerBundle.bytes || fs.realpathSync(archive) !== archive) throw new Error("Cloud worker prepared archive path or length is unsafe");
      const source = handle.createReadStream({ autoClose: false });
      try { await verifyArchive(source, workerBundle); }
      finally { source.destroy(); }
    } finally { await handle.close(); }
    return true;
  };

  // Project only verification/publication already completed by the installer.
  const reportRuntimeInstallation = (disposition) => {
    const line = "openclaw.runtime-installed:" + JSON.stringify({
    schema: "openclaw.runtime-installation.v1", installationVerified: true, disposition,
    nodeBootstrap: {
      sha256: bootstrap.sha256, bytes: bootstrap.bytes,
      manifestSha256: bootstrap.manifestSha256, buildId: bootstrap.buildId,
      openclawVersion: bootstrap.openclawVersion, enabledPluginIds: bootstrap.enabledPluginIds,
    },
    workerBundle: { sha256: workerBundle.sha256, bytes: workerBundle.bytes,
      packageRelativePath: workerBundle.packageRelativePath },
    });
    if (Buffer.byteLength(line, "utf8") > 16384) throw new Error("Runtime installation result exceeds its size limit");
    console.log(line);
  };

`;
