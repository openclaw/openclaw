import type { CrabboxOperatingSystem } from "./crabbox-worker-profile.js";

export type CrabboxOfflineRuntimeSetupOptions = {
  nodeBootstrap: {
    install?: "bundle";
    localPath: string;
    sha256: string;
    bytes: number;
    openclawVersion: string;
    buildId: string;
    manifestSha256: string;
    enabledPluginIds: readonly string[];
  };
  workerBundle: { localPath: string; sha256: string; bytes: number; packageRelativePath: string };
  target?: CrabboxOperatingSystem;
};

export function validateCrabboxOfflineRuntimeArchives(
  params: CrabboxOfflineRuntimeSetupOptions,
): void {
  if (params.nodeBootstrap.install !== undefined && params.nodeBootstrap.install !== "bundle") {
    throw new Error("Offline runtime installation requires a preassembled bundle");
  }
  for (const artifact of [params.nodeBootstrap, params.workerBundle]) {
    if (
      !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      !artifact.localPath
    ) {
      throw new Error("Offline runtime archive identity is invalid");
    }
  }
}

// Embedded in the shared installer so local and downloaded archives use the same integrity check.
export const CRABBOX_LOCAL_RUNTIME_ARCHIVE_SOURCE = `      if (artifact.localPath !== undefined) {
        reportPhase("local archive verification");
        if (!path.isAbsolute(artifact.localPath)) throw new Error("Cloud worker local archive path is invalid");
        const source = await fsp.open(artifact.localPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          const stat = await source.stat();
          if (!stat.isFile() || stat.nlink !== 1 || stat.size !== artifact.bytes || fs.realpathSync(artifact.localPath) !== artifact.localPath || (process.platform !== "win32" && stat.uid !== process.getuid())) throw new Error("Cloud worker local archive path, owner or length is unsafe");
          const output = await fsp.open(partial, "wx", 0o600);
          const input = source.createReadStream({ autoClose: false });
          try {
            let bytes = 0;
            for await (const chunk of input) {
              bytes += chunk.byteLength;
              if (bytes > artifact.bytes) throw new Error("Cloud worker bootstrap archive exceeds its declared size");
              await output.writeFile(chunk);
            }
          } finally { input.destroy(); await output.close(); }
        } finally { await source.close(); }
        await verifyArchive(fs.createReadStream(partial), artifact);
        fs.renameSync(partial, archive);
        return;
      }`;
