import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  inspectNpmPackageTarball,
  validatePrepublishPluginRegistryArtifact,
} from "../../prepublish-plugin-registry-artifact.mjs";
import { classifyReleaseTrain, parseReleaseVersion } from "../release-version.mjs";
import { hasChildExited, registerActiveChildProcessTree } from "./process.ts";

type CrossOsCompanionPackage = {
  name: string;
  tarballPath: string;
};

type CrossOsRegistryPackage = {
  name: string;
  version: string;
  tarballPath: string;
};

export function resolveCrossOsPackageSet(params: {
  artifactDir: string;
  candidateVersion: string;
  manifestSha256: string;
  requiredPackages: string[];
  sourceSha: string;
}) {
  const artifactDir = resolve(params.artifactDir);
  const { manifest } = validatePrepublishPluginRegistryArtifact({
    artifactDir,
    expectedCandidateVersion: params.candidateVersion,
    expectedManifestSha256: params.manifestSha256,
    expectedSourceSha: params.sourceSha,
    requiredPackages: params.requiredPackages,
  });
  const requiredPackages = new Set(params.requiredPackages);
  const companions: CrossOsCompanionPackage[] = manifest.packages
    .filter((entry: { name: string; tarball: string }) => requiredPackages.has(entry.name))
    .map((entry: { name: string; tarball: string }) => ({
      name: entry.name,
      tarballPath: resolve(artifactDir, entry.tarball),
    }));
  return {
    companions,
    packages: manifest.packages.map(
      (entry: { name: string; version: string; tarball: string }) => ({
        name: entry.name,
        version: entry.version,
        tarballPath: resolve(artifactDir, entry.tarball),
      }),
    ),
  };
}

export function resolveCrossOsRegistryDistTags(
  packages: ReturnType<typeof resolveCrossOsPackageSet>["packages"],
): string | undefined {
  const rootVersion = packages.find((entry) => entry.name === "openclaw")?.version;
  const parsed = rootVersion ? parseReleaseVersion(rootVersion) : null;
  if (!parsed || classifyReleaseTrain(parsed) !== "extended-stable") {
    return undefined;
  }
  return `extended-stable=${rootVersion}`;
}

export function bindCrossOsCandidateRootPackage(
  packages: CrossOsRegistryPackage[],
  candidate: { version: string; tarballPath: string },
): CrossOsRegistryPackage[] {
  const inspectedCandidate = inspectNpmPackageTarball(candidate.tarballPath);
  if (
    inspectedCandidate.packageJson.name !== "openclaw" ||
    inspectedCandidate.packageJson.version !== candidate.version
  ) {
    throw new Error("Candidate root tarball identity differs from the selected release candidate.");
  }
  const artifactRoot = packages.find((entry) => entry.name === "openclaw");
  if (artifactRoot) {
    const inspectedArtifactRoot = inspectNpmPackageTarball(artifactRoot.tarballPath);
    if (
      artifactRoot.version !== candidate.version ||
      inspectedArtifactRoot.sha256 !== inspectedCandidate.sha256
    ) {
      throw new Error("Candidate root registry bytes differ from the selected package artifact.");
    }
  }
  return [
    ...packages.filter((entry) => entry.name !== "openclaw"),
    { name: "openclaw", version: candidate.version, tarballPath: candidate.tarballPath },
  ].toSorted((a, b) => a.name.localeCompare(b.name));
}

export function omitCrossOsCandidateRootPackage(
  packages: CrossOsRegistryPackage[],
): CrossOsRegistryPackage[] {
  return packages.filter((entry) => entry.name !== "openclaw");
}

export async function startCrossOsPackageRegistry(
  packages: ReturnType<typeof resolveCrossOsPackageSet>["packages"],
  logsDir: string,
  options: { upstreamRegistry?: string } = {},
) {
  if (packages.length === 0) {
    return undefined;
  }
  const directory = mkdtempSync(join(logsDir, "package-registry-"));
  const portFile = join(directory, "port");
  const log = openSync(join(directory, "server.log"), "w");
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../../e2e/lib/plugins/npm-registry-server.mjs", import.meta.url)),
      portFile,
      ...packages.flatMap((entry) => [entry.name, entry.version, entry.tarballPath]),
    ],
    {
      env: {
        ...process.env,
        OPENCLAW_NPM_REGISTRY_BIND_HOST: "127.0.0.1",
        OPENCLAW_NPM_REGISTRY_DIST_TAGS: resolveCrossOsRegistryDistTags(packages),
        OPENCLAW_NPM_REGISTRY_PORT: "0",
        OPENCLAW_NPM_REGISTRY_MERGE_UPSTREAM: "1",
        OPENCLAW_NPM_REGISTRY_UPSTREAM: options.upstreamRegistry ?? "https://registry.npmjs.org",
      },
      stdio: ["ignore", log, log],
      detached: process.platform !== "win32",
    },
  );
  closeSync(log);
  const lifecycle = registerActiveChildProcessTree(child);
  let failure: Error | undefined;
  child.once("error", (error) => {
    failure = error;
  });
  const closed = new Promise<void>((resolveClose) => {
    child.once("close", () => resolveClose());
  });
  const close = async () => {
    if (!hasChildExited(child)) {
      lifecycle.killChildTree("SIGTERM");
      await Promise.race([closed, delay(2_000)]);
      if (!hasChildExited(child)) {
        lifecycle.killChildTree("SIGKILL");
      }
    }
    await closed;
    lifecycle.unregister();
    rmSync(portFile, { force: true });
  };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failure || hasChildExited(child)) {
        throw failure ?? new Error("Candidate npm registry exited before readiness.");
      }
      if (existsSync(portFile)) {
        const port = Number(readFileSync(portFile, "utf8"));
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          return { url: `http://127.0.0.1:${port}`, close };
        }
      }
      await delay(100);
    }
    throw new Error("Candidate npm registry did not become ready.");
  } catch (error) {
    await close();
    throw error;
  }
}
