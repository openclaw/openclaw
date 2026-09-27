import { isUtf8 } from "node:buffer";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";

const stdoutLimit = 4 * 1024 * 1024;
const stderrLimit = 64 * 1024;
const commandTimeoutMs = 5_000;
const inspectionBudgetMs = 10_000;
const pathSchema = z
  .string()
  .min(1)
  .max(8192)
  .refine((path) => isAbsolute(path) && !path.includes("\0"));

export const claimNamespaceSchema = z.strictObject({
  version: z.literal(1),
  platform: z.string(),
  cwd: pathSchema,
  directory: pathSchema,
  anchor: z.strictObject({ path: pathSchema, dev: z.string(), ino: z.string() }),
});
export type ClaimNamespace = z.infer<typeof claimNamespaceSchema>;

const inventorySchema = z.object({
  version: z.literal(1),
  source: z.literal("local-claims"),
  claims: z
    .array(
      z.object({
        leaseId: z.string().min(1).max(512),
        repoRoot: pathSchema,
      }),
    )
    .max(10_000),
  problems: z.array(z.unknown()).max(100),
});

type ClaimVerification =
  | { ok: true }
  | { ok: false; reason: string; error: unknown; unjoined?: true; matchingLeaseIds?: string[] };

class ClaimInventoryHold extends Error {
  matchingLeaseIds?: string[];

  constructor(reason: string, matchingLeaseIds?: string[]) {
    super(reason);
    this.matchingLeaseIds = matchingLeaseIds;
  }
}

function envValue(env: NodeJS.ProcessEnv, key: string) {
  if (process.platform !== "win32") {
    return env[key] ?? "";
  }
  const values = Object.entries(env)
    .filter(([name]) => name.toUpperCase() === key.toUpperCase())
    .map(([, value]) => value ?? "");
  if (new Set(values).size > 1) {
    throw new ClaimInventoryHold("The native claims environment has ambiguous location variables.");
  }
  return values[0] ?? "";
}

function nativeLocation(cwd: string, env: NodeJS.ProcessEnv) {
  let key: string;
  let value = envValue(env, "XDG_STATE_HOME");
  let suffix: string[];
  if (value !== "") {
    key = "XDG_STATE_HOME";
    suffix = ["crabbox", "claims"];
  } else if (process.platform === "win32") {
    key = "AppData";
    value = envValue(env, key);
    suffix = ["crabbox", "state", "claims"];
  } else if (process.platform === "darwin") {
    key = "HOME";
    value = envValue(env, key);
    suffix = ["Library", "Application Support", "crabbox", "state", "claims"];
  } else {
    key = "XDG_CONFIG_HOME";
    value = envValue(env, key);
    if (value !== "") {
      if (!isAbsolute(value)) {
        throw new ClaimInventoryHold("Native claims require an absolute XDG_CONFIG_HOME.");
      }
      suffix = ["crabbox", "state", "claims"];
    } else {
      key = "HOME";
      value = envValue(env, key);
      suffix = [".config", "crabbox", "state", "claims"];
    }
  }
  if (!value || value.includes("\0")) {
    throw new ClaimInventoryHold("The native claims state location is unavailable.");
  }
  // Drive-relative paths depend on Windows' per-drive working directories, which
  // this receipt cannot establish after the original process has gone away.
  if (process.platform === "win32" && /^[a-z]:(?:[^\\/]|$)/iu.test(value)) {
    throw new ClaimInventoryHold(
      "A drive-relative native claims location cannot be preserved safely.",
    );
  }
  const base = resolve(cwd, value);
  return { key, base, directory: join(base, ...suffix) };
}

function directoryLocation(path: string) {
  let ancestor = resolve(path);
  const missing: string[] = [];
  for (let depth = 0; depth < 128; depth += 1) {
    const entry = lstatSync(ancestor, { bigint: true, throwIfNoEntry: false });
    if (entry) {
      const physical = realpathSync(ancestor);
      const stat = statSync(physical, { bigint: true });
      if (!stat.isDirectory()) {
        throw new ClaimInventoryHold("A native claims path is not a readable directory.");
      }
      return {
        directory: resolve(physical, ...missing),
        anchor: { path: physical, dev: String(stat.dev), ino: String(stat.ino) },
        generation: `${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
      };
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      break;
    }
    missing.unshift(relative(parent, ancestor));
    ancestor = parent;
  }
  throw new ClaimInventoryHold("The native claims directory cannot be established.");
}

/** Bind discovery to the original native child's location without creating state. */
export function captureClaimNamespace(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ClaimNamespace {
  const originalCwd = realpathSync(cwd);
  if (!statSync(originalCwd).isDirectory()) {
    throw new ClaimInventoryHold("The original native working directory is unavailable.");
  }
  const location = directoryLocation(nativeLocation(originalCwd, env).directory);
  return claimNamespaceSchema.parse({
    version: 1,
    platform: process.platform,
    cwd: originalCwd,
    directory: location.directory,
    anchor: location.anchor,
  });
}

function inspectNamespace(namespace: ClaimNamespace, env: NodeJS.ProcessEnv) {
  if (namespace.platform !== process.platform) {
    throw new ClaimInventoryHold("The native claims namespace belongs to a different platform.");
  }
  const anchor = lstatSync(namespace.anchor.path, { bigint: true });
  if (
    !anchor.isDirectory() ||
    String(anchor.dev) !== namespace.anchor.dev ||
    String(anchor.ino) !== namespace.anchor.ino ||
    realpathSync(namespace.anchor.path) !== namespace.anchor.path
  ) {
    throw new ClaimInventoryHold("The original native claims namespace was replaced.");
  }
  const selected = nativeLocation(namespace.cwd, env);
  const current = directoryLocation(selected.directory);
  if (current.directory !== namespace.directory) {
    throw new ClaimInventoryHold(
      "The native claims state location changed since staging was created.",
    );
  }
  return { selected, current };
}

function childEnvironment(env: NodeJS.ProcessEnv, key: string, base: string) {
  const result = { ...env };
  for (const name of Object.keys(result)) {
    if (
      name === key ||
      (process.platform === "win32" && name.toUpperCase() === key.toUpperCase())
    ) {
      delete result[name];
    }
  }
  // Only normalize the selected location for this child. Relative values retain
  // their original cwd meaning even when recovery runs from another checkout.
  result[key] = base;
  return result;
}

function within(root: string, path: string) {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep));
}

/** Read the native public inventory; absence is not a provider-liveness claim. */
export async function verifyNoStagingClaims(params: {
  binary: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  namespace: ClaimNamespace;
  sourceRoot: string;
}): Promise<ClaimVerification> {
  try {
    params.signal?.throwIfAborted();
    const parsedNamespace = claimNamespaceSchema.safeParse(params.namespace);
    if (!parsedNamespace.success) {
      throw new ClaimInventoryHold("The recorded native claims namespace is invalid.");
    }
    const namespace = parsedNamespace.data;
    const env = { ...(params.env ?? process.env) };
    const before = inspectNamespace(namespace, env);
    if (!isAbsolute(params.sourceRoot) || params.sourceRoot.includes("\0")) {
      throw new ClaimInventoryHold("The staging source path must be absolute.");
    }
    const sourceRoot = directoryLocation(params.sourceRoot).directory;
    const deadline = Date.now() + inspectionBudgetMs;
    const abort = new AbortController();
    const signal = params.signal ? AbortSignal.any([params.signal, abort.signal]) : abort.signal;
    let captureFailure: ClaimInventoryHold | undefined;
    const output = Buffer.alloc(stdoutLimit);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const exceedLimit = () => {
      captureFailure ??= new ClaimInventoryHold(
        "Native claim inventory exceeded its output limit.",
      );
      abort.abort(captureFailure);
    };
    let status: number;
    try {
      status = await runManagedCommand({
        bin: params.binary,
        args: ["claims", "list", "--json"],
        cwd: params.cwd,
        env: childEnvironment(env, before.selected.key, before.selected.base),
        stdio: ["ignore", "pipe", "pipe"],
        timeoutMs: commandTimeoutMs,
        signal,
        requireProcessTreeExit: process.platform !== "win32",
        onReady(child) {
          if (!child.stdout || !child.stderr) {
            throw new ClaimInventoryHold("Native claim inventory output is unavailable.");
          }
          child.stdout.on("data", (chunk: Buffer) => {
            if (captureFailure) {
              return;
            }
            if (stdoutBytes + chunk.length > stdoutLimit) {
              exceedLimit();
              return;
            }
            stdoutBytes += chunk.copy(output, stdoutBytes);
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderrBytes += chunk.length;
            if (stderrBytes > stderrLimit) {
              exceedLimit();
            }
          });
        },
      });
    } catch (error) {
      if (captureFailure && captureFailure !== error) {
        throw new AggregateError([captureFailure, error], captureFailure.message, { cause: error });
      }
      throw error;
    }
    if (captureFailure) {
      throw captureFailure;
    }
    if (status !== 0) {
      throw new ClaimInventoryHold(
        "Native claim inventory failed or returned only partial results.",
      );
    }
    const bytes = output.subarray(0, stdoutBytes);
    let document: unknown;
    try {
      if (!isUtf8(bytes)) {
        throw new Error("invalid encoding");
      }
      document = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new ClaimInventoryHold("Native claim inventory did not return valid JSON.");
    }
    const parsed = inventorySchema.safeParse(document);
    if (!parsed.success) {
      throw new ClaimInventoryHold(
        "Native claim inventory has an unsupported or malformed schema.",
      );
    }
    if (parsed.data.problems.length > 0) {
      throw new ClaimInventoryHold(
        "Native claim inventory reports unreadable or invalid local records.",
      );
    }
    const matches = new Set<string>();
    for (const claim of parsed.data.claims) {
      if (Date.now() >= deadline) {
        throw new ClaimInventoryHold("Native claim inventory exceeded its inspection budget.");
      }
      if (within(sourceRoot, directoryLocation(claim.repoRoot).directory)) {
        matches.add(claim.leaseId);
        if (matches.size === 16) {
          break;
        }
      }
    }
    if (matches.size > 0) {
      throw new ClaimInventoryHold(
        "Local claims still name this staging source; stop or reclaim the matching leases before retrying.",
        [...matches],
      );
    }
    const after = inspectNamespace(namespace, env);
    if (JSON.stringify(after.current) !== JSON.stringify(before.current)) {
      throw new ClaimInventoryHold("The native claims namespace changed during inventory.");
    }
    params.signal?.throwIfAborted();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof ClaimInventoryHold
          ? error.message
          : "Native claim inventory could not be verified.",
      error,
      ...(hasUnjoinedWork(error) ? { unjoined: true as const } : {}),
      ...(error instanceof ClaimInventoryHold && error.matchingLeaseIds
        ? { matchingLeaseIds: error.matchingLeaseIds }
        : {}),
    };
  }
}
