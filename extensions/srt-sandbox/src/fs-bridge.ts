// SRT sandbox filesystem bridge (Stage S3, design v8 §1–§3).
//
// Implements the OpenClaw SandboxFsBridge contract
// (src/agents/sandbox/fs-bridge.types.ts) for the local SRT backend, providing
// the AC4 exact-location guarantee via 方案 2 (live directory handles):
//
//   - resolvePinnedMutationTarget walks the target's parent chain in the
//     sandboxed pin owner and KEEPS those directory fds open (§2). It returns a
//     pinnedPath that is a PURE CANONICAL PATH (§1) — the held-handle binding is
//     bridge/owner-internal state keyed by that path (an owner-assigned opId,
//     NEVER encoded into pinnedPath), so the carrier stays contract-compatible.
//   - the paired mutation runs relative to the held parent fd (leaf O_NOFOLLOW,
//     O_EXCL for exclusive create). Because a Unix fd binds the vnode (not the
//     path name or inode number), a post-resolve component swap cannot redirect
//     the write and a deleted target fails closed with ENOENT — no relaxation.
//
// Production tool callers invoke the mutation methods WITHOUT a pinnedPath (the
// resolve→pinnedPath→mutate sequence is exercised by core's own tests); both
// paths funnel through the same hold+mutate so the guarantee is uniform. The
// held-pin table enforces single-flight per canonical path, a per-scope cap on
// concurrent unfinalized pins, a max pin depth, and an idle timeout so a resolve
// with no following mutate can never leak fds.
import fs from "node:fs";
import path from "node:path";
import type {
  SandboxBackendHandle,
  SandboxFsBridge,
  SandboxFsStat,
  SandboxResolvedPath,
} from "openclaw/plugin-sdk/sandbox";
import { PinOwnerClient } from "./pin-owner-client.js";

/** Context the backend hands the bridge factory (derived from the SDK type). */
type SandboxFsBridgeContext = Parameters<
  NonNullable<SandboxBackendHandle["createFsBridge"]>
>[0]["sandbox"];

/** Fail-closed resource caps for the held-handle pin owner (v8 §3.3). */
export type SrtPinLimits = {
  /** Max concurrent unfinalized pins per scope; exceeding it fails closed. */
  maxHeldPins: number;
  /** Max held directory fds per pin (path depth); deeper fails closed. */
  maxPinDepth: number;
  /** A resolve with no paired mutate releases its fds after this idle window. */
  pinTimeoutMs: number;
};

export const DEFAULT_SRT_PIN_LIMITS: SrtPinLimits = {
  maxHeldPins: 64,
  maxPinDepth: 256,
  pinTimeoutMs: 30_000,
};

export type SrtFsBridgeDeps = {
  sandbox: SandboxFsBridgeContext;
  /** Writable roots — the exact allowWrite set the pin owner is sandboxed to. */
  writableRoots: readonly string[];
  /** Pin-owner RPC client (owns spawn/respawn + transport). */
  client: PinOwnerClient;
  limits?: SrtPinLimits;
};

type CanonicalRoot = { logical: string; canonical: string };

type TargetPlan = {
  /** Destination in the caller's policy namespace (logical). */
  policyPath: string;
  /** Canonical mutation target in the bridge runtime namespace (pure path). */
  pinnedPath: string;
  /** Canonical mount root the owner anchors the (no-follow) walk on. */
  canonicalRoot: string;
  /** Parent chain relative to canonicalRoot (file mode) or "" (dir mode). */
  rel: string;
  /** Basename to mutate (file mode) or the suffix to create (dir mode). */
  leaf: string;
  mode: "file" | "dir";
};

type HeldPin = { opId: number; timer?: ReturnType<typeof setTimeout> };

function normalizeAbsolute(value: string): string {
  return path.posix.normalize(value);
}

function isInside(root: string, target: string): boolean {
  if (root === target) {
    return true;
  }
  return target.startsWith(root.endsWith("/") ? root : `${root}/`);
}

class SrtSandboxFsBridge implements SandboxFsBridge {
  private readonly workspaceDir: string;
  private readonly writableRoots: CanonicalRoot[];
  private readonly client: PinOwnerClient;
  private readonly limits: SrtPinLimits;
  private readonly heldPins = new Map<string, HeldPin>();
  private nextOpId = 1;
  private disposed = false;

  constructor(deps: SrtFsBridgeDeps) {
    this.workspaceDir = normalizeAbsolute(deps.sandbox.workspaceDir);
    this.client = deps.client;
    this.limits = deps.limits ?? DEFAULT_SRT_PIN_LIMITS;
    this.writableRoots = deps.writableRoots
      .map((root) => normalizeAbsolute(root))
      .map((logical) => {
        let canonical = logical;
        try {
          canonical = normalizeAbsolute(fs.realpathSync(logical));
        } catch {
          // A not-yet-created writable root canonicalizes to itself; the owner
          // fails closed later if the anchor genuinely does not exist.
        }
        return { logical, canonical };
      });
  }

  // --- path planning ---------------------------------------------------------

  private matchWritableRoot(targetAbs: string): { base: string; canonical: string } {
    for (const root of this.writableRoots) {
      if (isInside(root.logical, targetAbs)) {
        return { base: root.logical, canonical: root.canonical };
      }
      if (root.canonical !== root.logical && isInside(root.canonical, targetAbs)) {
        return { base: root.canonical, canonical: root.canonical };
      }
    }
    throw new Error(`Sandbox path is read-only or outside the writable roots: ${targetAbs}`);
  }

  private planTarget(filePath: string, cwd: string | undefined, mode: "file" | "dir"): TargetPlan {
    const targetAbs = normalizeAbsolute(path.resolve(cwd ?? this.workspaceDir, filePath));
    const { base, canonical } = this.matchWritableRoot(targetAbs);
    const relFull = path.posix.relative(base, targetAbs);
    if (relFull === ".." || relFull.startsWith("../") || path.posix.isAbsolute(relFull)) {
      throw new Error(`Sandbox path escapes the writable root: ${targetAbs}`);
    }
    const pinnedPath =
      relFull === "" ? canonical : normalizeAbsolute(path.posix.join(canonical, relFull));

    if (mode === "dir") {
      const depth = relFull === "" ? 0 : relFull.split("/").length;
      if (depth > this.limits.maxPinDepth) {
        throw new Error(`Sandbox pin depth exceeds the maximum (${this.limits.maxPinDepth})`);
      }
      return {
        policyPath: targetAbs,
        pinnedPath,
        canonicalRoot: canonical,
        rel: "",
        leaf: relFull,
        mode,
      };
    }

    const leaf = path.posix.basename(relFull);
    if (leaf === "" || leaf === "." || leaf === "..") {
      throw new Error(`Invalid sandbox mutation target: ${targetAbs}`);
    }
    const relParent = path.posix.dirname(relFull);
    const rel = relParent === "." ? "" : relParent;
    const depth = 1 + (rel === "" ? 0 : rel.split("/").length);
    if (depth > this.limits.maxPinDepth) {
      throw new Error(`Sandbox pin depth exceeds the maximum (${this.limits.maxPinDepth})`);
    }
    return { policyPath: targetAbs, pinnedPath, canonicalRoot: canonical, rel, leaf, mode };
  }

  private assertPinnedMatches(
    pinnedPath: string | undefined,
    plan: TargetPlan,
    directory = false,
  ): void {
    if (pinnedPath === undefined) {
      return;
    }
    const canonical = normalizeAbsolute(pinnedPath);
    if (!path.posix.isAbsolute(canonical)) {
      throw new Error(`Pinned sandbox destination is not an absolute path: ${pinnedPath}`);
    }
    // File-backed pins must preserve the requested basename so the mutation
    // lands on the authorized entry; directory pins authorize the directory
    // itself (an existing alias may have renamed it). Mirrors core's
    // authorizedPinnedTarget contract (src/agents/sandbox/fs-bridge.ts).
    if (!directory && path.posix.basename(canonical) !== plan.leaf) {
      throw new Error(
        `Pinned sandbox destination does not match the requested path: ${plan.policyPath}`,
      );
    }
  }

  // --- held-pin lifecycle ----------------------------------------------------

  private async holdForResolve(plan: TargetPlan): Promise<void> {
    if (this.heldPins.size >= this.limits.maxHeldPins) {
      throw new Error(
        `Sandbox held-pin table is full (${this.limits.maxHeldPins}); cannot pin ${plan.policyPath}`,
      );
    }
    if (this.heldPins.has(plan.pinnedPath)) {
      // Single-flight per (scope, canonical path): a second unfinalized resolve
      // of a held path is rejected fail-closed rather than double-holding.
      throw new Error(`Sandbox path is already pinned: ${plan.pinnedPath}`);
    }
    const opId = this.nextOpId++;
    const entry: HeldPin = { opId };
    // Reserve synchronously so a concurrent resolve of the same path sees it.
    this.heldPins.set(plan.pinnedPath, entry);
    try {
      await this.client.resolvePin(opId, {
        root: plan.canonicalRoot,
        rel: plan.rel,
        leaf: plan.leaf,
        mode: plan.mode,
      });
    } catch (error) {
      this.heldPins.delete(plan.pinnedPath);
      throw error;
    }
    entry.timer = setTimeout(() => {
      const current = this.heldPins.get(plan.pinnedPath);
      if (current !== entry) {
        return;
      }
      this.heldPins.delete(plan.pinnedPath);
      void this.client.release(entry.opId).catch(() => {});
    }, this.limits.pinTimeoutMs);
  }

  private async runMutation(
    plan: TargetPlan,
    mutation: Parameters<PinOwnerClient["mutate"]>[1],
  ): Promise<string> {
    const held = this.heldPins.get(plan.pinnedPath);
    if (held) {
      // Reuse the fds pinned by an earlier resolvePinnedMutationTarget; the
      // owner releases them when the mutation completes.
      if (held.timer) {
        clearTimeout(held.timer);
      }
      this.heldPins.delete(plan.pinnedPath);
      const { result } = await this.client.mutate(held.opId, mutation);
      return result;
    }
    // Fresh atomic hold+mutate (the production path — no prior resolve). The
    // fds live only for the duration of this single mutation.
    if (this.heldPins.size >= this.limits.maxHeldPins) {
      throw new Error(
        `Sandbox held-pin table is full (${this.limits.maxHeldPins}); cannot mutate ${plan.policyPath}`,
      );
    }
    const opId = this.nextOpId++;
    await this.client.resolvePin(opId, {
      root: plan.canonicalRoot,
      rel: plan.rel,
      leaf: plan.leaf,
      mode: plan.mode,
    });
    try {
      const { result } = await this.client.mutate(opId, mutation);
      return result;
    } catch (error) {
      await this.client.release(opId).catch(() => {});
      throw error;
    }
  }

  private async ensureParentDir(plan: TargetPlan, cwd: string | undefined): Promise<void> {
    const parent = path.posix.dirname(plan.policyPath);
    const parentPlan = this.planTarget(parent, cwd, "dir");
    await this.runMutation(parentPlan, { kind: "mkdir" });
  }

  private static toBuffer(data: Buffer | string, encoding?: BufferEncoding): Buffer {
    return typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : data;
  }

  // --- SandboxFsBridge surface ----------------------------------------------

  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath {
    const abs = normalizeAbsolute(path.resolve(params.cwd ?? this.workspaceDir, params.filePath));
    return {
      // Local backend: host and container namespaces coincide.
      hostPath: abs,
      containerPath: abs,
      relativePath: path.posix.relative(this.workspaceDir, abs),
    };
  }

  async resolvePinnedMutationTarget(params: {
    filePath: string;
    cwd?: string;
    action: "write" | "create" | "mkdir" | "remove" | "copy-destination";
    signal?: AbortSignal;
  }): Promise<{ policyPath: string; pinnedPath: string }> {
    params.signal?.throwIfAborted();
    const plan = this.planTarget(
      params.filePath,
      params.cwd,
      params.action === "mkdir" ? "dir" : "file",
    );
    await this.holdForResolve(plan);
    return { policyPath: plan.policyPath, pinnedPath: plan.pinnedPath };
  }

  async readFile(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
    maxBytes?: number;
  }): Promise<Buffer> {
    params.signal?.throwIfAborted();
    const abs = path.resolve(params.cwd ?? this.workspaceDir, params.filePath);
    return this.client.read(abs, params.maxBytes);
  }

  async writeFile(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    pinnedPath?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    params.signal?.throwIfAborted();
    const plan = this.planTarget(params.filePath, params.cwd, "file");
    this.assertPinnedMatches(params.pinnedPath, plan);
    if (params.mkdir) {
      await this.ensureParentDir(plan, params.cwd);
    }
    await this.runMutation(plan, {
      kind: "write",
      data: SrtSandboxFsBridge.toBuffer(params.data, params.encoding),
    });
  }

  async createFileExclusive(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    pinnedPath?: string;
    signal?: AbortSignal;
  }): Promise<"created" | "exists"> {
    params.signal?.throwIfAborted();
    const plan = this.planTarget(params.filePath, params.cwd, "file");
    this.assertPinnedMatches(params.pinnedPath, plan);
    if (params.mkdir) {
      await this.ensureParentDir(plan, params.cwd);
    }
    const result = await this.runMutation(plan, {
      kind: "create",
      data: SrtSandboxFsBridge.toBuffer(params.data, params.encoding),
    });
    return result === "exists" ? "exists" : "created";
  }

  async copyFile(params: {
    sourcePath: string;
    destinationPath: string;
    cwd?: string;
    mkdir?: boolean;
    pinnedPath?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    params.signal?.throwIfAborted();
    const sourceAbs = path.resolve(params.cwd ?? this.workspaceDir, params.sourcePath);
    const data = await this.client.read(sourceAbs);
    const plan = this.planTarget(params.destinationPath, params.cwd, "file");
    this.assertPinnedMatches(params.pinnedPath, plan);
    if (params.mkdir) {
      await this.ensureParentDir(plan, params.cwd);
    }
    await this.runMutation(plan, { kind: "write", data });
  }

  async mkdirp(params: {
    filePath: string;
    cwd?: string;
    pinnedPath?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    params.signal?.throwIfAborted();
    const plan = this.planTarget(params.filePath, params.cwd, "dir");
    this.assertPinnedMatches(params.pinnedPath, plan, true);
    await this.runMutation(plan, { kind: "mkdir" });
  }

  async remove(params: {
    filePath: string;
    cwd?: string;
    recursive?: boolean;
    force?: boolean;
    pinnedPath?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    params.signal?.throwIfAborted();
    const plan = this.planTarget(params.filePath, params.cwd, "file");
    this.assertPinnedMatches(params.pinnedPath, plan);
    await this.runMutation(plan, {
      kind: "remove",
      recursive: params.recursive === true,
      // Default idempotent (force) unless the caller explicitly disables it,
      // matching the core pinned-remove default.
      force: params.force !== false,
    });
  }

  async rename(params: {
    from: string;
    to: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    params.signal?.throwIfAborted();
    const fromPlan = this.planTarget(params.from, params.cwd, "file");
    const toPlan = this.planTarget(params.to, params.cwd, "file");
    await this.client.rename({
      fromRoot: fromPlan.canonicalRoot,
      fromRel: fromPlan.rel,
      fromLeaf: fromPlan.leaf,
      toRoot: toPlan.canonicalRoot,
      toRel: toPlan.rel,
      toLeaf: toPlan.leaf,
    });
  }

  async stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null> {
    params.signal?.throwIfAborted();
    const abs = path.resolve(params.cwd ?? this.workspaceDir, params.filePath);
    return this.client.stat(abs);
  }

  /** Release every held pin and detach the owner client (scope teardown). */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const entry of this.heldPins.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
    }
    this.heldPins.clear();
    this.client.dispose();
  }
}

/** Create the SRT sandbox filesystem bridge for one scope. */
export function createSrtFsBridge(deps: SrtFsBridgeDeps): SandboxFsBridge & { dispose(): void } {
  return new SrtSandboxFsBridge(deps);
}
