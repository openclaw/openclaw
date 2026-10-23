import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const POLICY_INCLUDE = 'source "${BASH_SOURCE[0]%${BASH_SOURCE[0]##*/}}./install-policy.sh"';

// The source can come from a sealed archive. Never evaluate candidate shell code
// or load its generator while assembling a privileged install-smoke payload.
/**
 * @param {string} source
 * @param {() => string} readPolicy
 */
export function assembleStandaloneInstaller(source, readPolicy) {
  if (!source.includes(POLICY_INCLUDE)) {
    return source;
  }
  if (source.indexOf(POLICY_INCLUDE) !== source.lastIndexOf(POLICY_INCLUDE)) {
    throw new Error("Installer must include shared policy exactly once");
  }
  return source.replace(POLICY_INCLUDE, () => readPolicy().trimEnd());
}

export function readStandaloneInstaller(root, name) {
  if (name !== "install.sh" && name !== "install-cli.sh") {
    throw new Error(`Unknown installer: ${name}`);
  }
  const sourceRoot = realpathSync(root);
  const readSource = (basename) => {
    const file = path.join(sourceRoot, "scripts", basename);
    // Candidate checkouts are quiescent here; never follow their file or parent
    // symlinks into host-owned data while constructing a container payload.
    if (realpathSync(file) !== file) {
      throw new Error(`Installer source cannot contain symlinks: ${file}`);
    }
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) {
        throw new Error(`Installer source must be a regular file: ${file}`);
      }
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  };
  return assembleStandaloneInstaller(readSource(name), () => readSource("install-policy.sh"));
}

export function writeStandaloneInstallers(root, outputDir) {
  mkdirSync(outputDir, { recursive: true });
  for (const name of ["install.sh", "install-cli.sh"]) {
    writeFileSync(path.join(outputDir, name), readStandaloneInstaller(root, name), {
      mode: 0o755,
    });
  }
}
