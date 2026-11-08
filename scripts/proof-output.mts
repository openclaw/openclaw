import fs from "node:fs";
import path from "node:path";

export const PROOF_OUTPUT_CLAIM = ".proof-output-claim.json";

export function proofOwnershipSkipReason() {
  return typeof process.getuid === "function"
    ? undefined
    : "UID ownership verification unavailable on this platform";
}

/** Validate all arguments before mutating the output. */
export function parseProofArgs(args: string[], cases?: readonly string[]) {
  let out: string | undefined;
  let selectedCase: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag !== "--out" && !(flag === "--case" && cases)) {
      throw new Error("Unknown argument: " + flag);
    }
    const value = args[++i];
    if (!value || value.startsWith("--") || value.includes("\0")) {
      throw new Error("Missing or invalid value for " + flag);
    }
    if (flag === "--out") {
      if (out !== undefined) {
        throw new Error("Duplicate --out");
      }
      out = value;
    } else {
      if (selectedCase !== undefined) {
        throw new Error("Duplicate --case");
      }
      if (!cases?.includes(value)) {
        throw new Error("Unknown case: " + value);
      }
      selectedCase = value;
    }
  }
  if (!out) {
    throw new Error("Required: --out <fresh-or-empty-owned-directory>");
  }
  return { out, selectedCase };
}

function sameDirectory(left: fs.Stats, right: fs.Stats) {
  return (
    right.isDirectory() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function physicalDirectory(directory: string) {
  const root = path.parse(directory).root;
  let current = root;
  for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Output parent must be a physical directory (no symlinks): " + current);
    }
  }
  if (fs.realpathSync(directory) !== directory) {
    throw new Error("Output parent must use its physical path: " + directory);
  }
  return fs.lstatSync(directory);
}

/** Claim once before fixture writes; never remove the claim, including on failure.
 * This protects operator-owned scratch, not a hostile concurrent-writer sandbox.
 */
export function claimProofOutput(output: string, proof: string) {
  if (!output || output.includes("\0")) {
    throw new Error("Invalid output directory");
  }
  const out = path.resolve(output);
  const parent = path.dirname(out);
  if (out === parent) {
    throw new Error("Cannot use a filesystem root as proof output");
  }
  const parentStat = physicalDirectory(parent);
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Proof output ownership cannot be verified on this platform");
  }
  if (parentStat.uid !== uid) {
    throw new Error("Output parent must be owned by the current user");
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(out);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    fs.mkdirSync(out, { mode: 0o700 });
    stat = fs.lstatSync(out);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Output must be a non-symlink directory");
  }
  if (stat.uid !== uid) {
    throw new Error("Output must be owned by the current user");
  }
  if (fs.readdirSync(out).length !== 0) {
    throw new Error("Output must be empty and never previously claimed");
  }
  if (
    !sameDirectory(parentStat, physicalDirectory(parent)) ||
    !sameDirectory(stat, fs.lstatSync(out))
  ) {
    throw new Error("Output directory identity changed before claim");
  }
  fs.writeFileSync(
    path.join(out, PROOF_OUTPUT_CLAIM),
    JSON.stringify({ proof, pid: process.pid, startedAt: new Date().toISOString() }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return out;
}

export type ProofCapabilities = {
  symlinks: boolean;
  permissions: boolean;
  hardlinks: boolean;
  reasons: Partial<Record<"symlinks" | "permissions" | "hardlinks", string>>;
};

/** Probe only inside claimed output; unsupported primitives are not passing evidence. */
export function probeProofCapabilities(out: string): ProofCapabilities {
  const root = path.join(out, ".capability-probe");
  fs.mkdirSync(root, { mode: 0o700 });
  const file = path.join(root, "file");
  fs.writeFileSync(file, "probe");
  const result: ProofCapabilities = {
    symlinks: false,
    permissions: false,
    hardlinks: false,
    reasons: {},
  };
  const probes = {
    symlinks: () => {
      fs.symlinkSync(file, path.join(root, "file-link"));
      fs.symlinkSync(root, path.join(root, "directory-link"), "dir");
    },
    permissions: () => {
      if (process.platform === "win32") {
        throw new Error("POSIX mode enforcement unavailable");
      }
      fs.chmodSync(file, 0o600);
      if ((fs.statSync(file).mode & 0o777) !== 0o600) {
        throw new Error("POSIX file modes unavailable");
      }
      fs.chmodSync(root, 0o700);
      if ((fs.statSync(root).mode & 0o777) !== 0o700) {
        throw new Error("POSIX directory modes unavailable");
      }
    },
    hardlinks: () => {
      fs.linkSync(file, path.join(root, "hardlink"));
      if (fs.statSync(file).nlink !== 2) {
        throw new Error("Hardlink counts unavailable");
      }
    },
  };
  try {
    for (const name of ["symlinks", "permissions", "hardlinks"] as const) {
      try {
        probes[name]();
        result[name] = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && !["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(code)) {
          throw error;
        }
        result.reasons[name] = String(error);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(out, "capabilities.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

export function unsupportedProofReason(capabilities: ProofCapabilities, hardlinks = false) {
  const required = hardlinks
    ? (["symlinks", "permissions", "hardlinks"] as const)
    : (["symlinks", "permissions"] as const);
  return required
    .filter((name) => !capabilities[name])
    .map((name) => name + ": " + capabilities.reasons[name])
    .join("; ");
}
