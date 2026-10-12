import fs from "node:fs";
import path from "node:path";
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
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type {
  SandboxBackendHandle,
  SandboxFsBridge,
  SandboxFsStat,
  SandboxResolvedPath,
} from "openclaw/plugin-sdk/sandbox";
import { PinOwnerClient } from "./pin-owner-client.js";
import { buildSrtFilesystemPolicy } from "./srt-runtime-config.js";

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
  filesystem?: SandboxRuntimeConfig["filesystem"];
  /** Pin-owner RPC client (owns spawn/respawn + transport). */
  client: PinOwnerClient;
  limits?: SrtPinLimits;
};

type PathFlavor = "posix" | "win32";
type PathApi = typeof path.posix;

type CanonicalRoot = { logical: string; canonical: string; flavor: PathFlavor };

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

type HeldPin = {
  opId: number;
  mode: TargetPlan["mode"];
  expiresAt?: number;
  timer?: ReturnType<typeof setTimeout>;
};

function absolutePathFlavor(value: string): PathFlavor | undefined {
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(value)) {
    return "win32";
  }
  if (path.posix.isAbsolute(value)) {
    return "posix";
  }
  return undefined;
}

function pathApi(flavor: PathFlavor): PathApi {
  return flavor === "win32" ? path.win32 : path.posix;
}

function normalizeAbsolute(value: string, flavor: PathFlavor): string {
  return pathApi(flavor).normalize(value);
}

function isInside(root: string, target: string, flavor: PathFlavor): boolean {
  const api = pathApi(flavor);
  const comparableRoot = flavor === "win32" ? root.toLowerCase() : root;
  const comparableTarget = flavor === "win32" ? target.toLowerCase() : target;
  if (comparableRoot === comparableTarget) {
    return true;
  }
  return comparableTarget.startsWith(
    comparableRoot.endsWith(api.sep) ? comparableRoot : `${comparableRoot}${api.sep}`,
  );
}

class SrtSandboxFsBridge implements SandboxFsBridge {
  private readonly workspaceDir: string;
  private readonly workspaceFlavor: PathFlavor;
  private readonly writableRoots: CanonicalRoot[];
  private readonly deniedWrites: CanonicalRoot[];
  private readonly deniedReads: CanonicalRoot[];
  private readonly client: PinOwnerClient;
  private readonly limits: SrtPinLimits;
  private readonly heldPins = new Map<string, HeldPin>();
  private nextOpId = 1;
  private disposed = false;

  constructor(deps: SrtFsBridgeDeps) {
    this.workspaceFlavor =
      absolutePathFlavor(deps.sandbox.workspaceDir) ??
      (process.platform === "win32" ? "win32" : "posix");
    this.workspaceDir = normalizeAbsolute(deps.sandbox.workspaceDir, this.workspaceFlavor);
    this.client = deps.client;
    this.limits = deps.limits ?? DEFAULT_SRT_PIN_LIMITS;
    const filesystem =
      deps.filesystem ??
      buildSrtFilesystemPolicy(
        {
          workspaceDir: deps.sandbox.workspaceDir,
          agentWorkspaceDir: deps.sandbox.agentWorkspaceDir,
          skillsWorkspaceDir: deps.sandbox.skillsWorkspaceDir,
          workspaceAccess: deps.sandbox.workspaceAccess,
          readOnlyResourceMounts: deps.sandbox.readOnlyResourceMounts,
        },
        deps.writableRoots,
      );
    const canonicalize = (roots: readonly string[]) =>
      roots
        .map((root) => {
          const flavor = absolutePathFlavor(root) ?? this.workspaceFlavor;
          return { logical: normalizeAbsolute(root, flavor), flavor };
        })
        .map(({ logical, flavor }) => {
          let canonical = logical;
          const nativeFlavor = process.platform === "win32" ? "win32" : "posix";
          if (flavor === nativeFlavor) {
            try {
              canonical = normalizeAbsolute(fs.realpathSync(logical), flavor);
            } catch {
              // A not-yet-created writable root canonicalizes to itself; the owner
              // fails closed later if the anchor genuinely does not exist.
            }
          }
          return { logical, canonical, flavor };
        });
    this.writableRoots = canonicalize(filesystem.allowWrite);
    this.deniedWrites = canonicalize(filesystem.denyWrite);
    this.deniedReads = canonicalize(filesystem.denyRead);
  }

  // --- path planning ---------------------------------------------------------

  private resolveAbsolute(
    filePath: string,
    cwd: string | undefined,
  ): { absolute: string; flavor: PathFlavor } {
    const explicitFlavor = absolutePathFlavor(filePath);
    if (explicitFlavor) {
      return { absolute: normalizeAbsolute(filePath, explicitFlavor), flavor: explicitFlavor };
    }
    const base = cwd ?? this.workspaceDir;
    const flavor = absolutePathFlavor(base) ?? this.workspaceFlavor;
    return {
      absolute: pathApi(flavor).resolve(normalizeAbsolute(base, flavor), filePath),
      flavor,
    };
  }

  private assertNotDenied(
    target: string,
    flavor: PathFlavor,
    roots: CanonicalRoot[],
    ancestors = false,
  ): void {
    for (const root of roots) {
      if (root.flavor !== flavor) {
        continue;
      }
      for (const denied of [root.logical, root.canonical]) {
        if (isInside(denied, target, flavor) || (ancestors && isInside(target, denied, flavor))) {
          throw new Error(`Sandbox path is read-only or hidden: ${target}`);
        }
      }
    }
  }

  private assertReadable(target: string, flavor: PathFlavor): void {
    this.assertNotDenied(target, flavor, this.deniedReads);
    if (flavor === (process.platform === "win32" ? "win32" : "posix")) {
      let canonical: string;
      try {
        canonical = fs.realpathSync(target);
      } catch {
        return;
      }
      this.assertNotDenied(canonical, flavor, this.deniedReads);
    }
  }

  private matchWritableRoot(
    targetAbs: string,
    flavor: PathFlavor,
  ): { base: string; canonical: string; flavor: PathFlavor } {
    for (const root of this.writableRoots) {
      if (root.flavor !== flavor) {
        continue;
      }
      if (isInside(root.logical, targetAbs, flavor)) {
        return { base: root.logical, canonical: root.canonical, flavor };
      }
      if (root.canonical !== root.logical && isInside(root.canonical, targetAbs, flavor)) {
        return { base: root.canonical, canonical: root.canonical, flavor };
      }
    }
    throw new Error(`Sandbox path is read-only or outside the writable roots: ${targetAbs}`);
  }

  private planTarget(
    filePath: string,
    cwd: string | undefined,
    mode: "file" | "dir",
    destructive = false,
  ): TargetPlan {
    const { absolute: targetAbs, flavor } = this.resolveAbsolute(filePath, cwd);
    this.assertNotDenied(targetAbs, flavor, this.deniedWrites, destructive);
    const { base, canonical } = this.matchWritableRoot(targetAbs, flavor);
    const api = pathApi(flavor);
    const relFull = api.relative(base, targetAbs);
    if (relFull === ".." || relFull.startsWith(`..${api.sep}`) || api.isAbsolute(relFull)) {
      throw new Error(`Sandbox path escapes the writable root: ${targetAbs}`);
    }
    const pinnedPath = relFull === "" ? canonical : api.normalize(api.join(canonical, relFull));
    this.assertNotDenied(pinnedPath, flavor, this.deniedWrites, destructive);

    if (mode === "dir") {
      const depth = relFull === "" ? 0 : relFull.split(api.sep).length;
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

    const leaf = api.basename(relFull);
    if (leaf === "" || leaf === "." || leaf === "..") {
      throw new Error(`Invalid sandbox mutation target: ${targetAbs}`);
    }
    const relParent = api.dirname(relFull);
    const rel = relParent === "." ? "" : relParent;
    const depth = 1 + (rel === "" ? 0 : rel.split(api.sep).length);
    if (depth > this.limits.maxPinDepth) {
      throw new Error(`Sandbox pin depth exceeds the maximum (${this.limits.maxPinDepth})`);
    }
    return { policyPath: targetAbs, pinnedPath, canonicalRoot: canonical, rel, leaf, mode };
  }

  private assertPinnedMatches(pinnedPath: string | undefined, plan: TargetPlan): void {
    if (pinnedPath === undefined) {
      return;
    }
    const flavor = absolutePathFlavor(plan.pinnedPath) ?? this.workspaceFlavor;
    const api = pathApi(flavor);
    const canonical = normalizeAbsolute(pinnedPath, flavor);
    const expected = normalizeAbsolute(plan.pinnedPath, flavor);
    if (!api.isAbsolute(canonical)) {
      throw new Error(`Pinned sandbox destination is not an absolute path: ${pinnedPath}`);
    }
    const matches =
      flavor === "win32"
        ? canonical.toLowerCase() === expected.toLowerCase()
        : canonical === expected;
    if (!matches) {
      throw new Error(
        `Pinned sandbox destination does not match the requested path: ${plan.policyPath}`,
      );
    }
    const held = this.heldPins.get(plan.pinnedPath);
    if (held?.expiresAt !== undefined && performance.now() >= held.expiresAt) {
      clearTimeout(held.timer);
      this.heldPins.delete(plan.pinnedPath);
      void this.client.release(held.opId).catch(() => {});
    } else if (held?.expiresAt !== undefined && held.mode === plan.mode) {
      return;
    }
    throw new Error(
      "Supplied sandbox mutation pin has expired, been consumed, or has no live matching binding",
    );
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
    const entry: HeldPin = { opId, mode: plan.mode };
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
    entry.expiresAt = performance.now() + this.limits.pinTimeoutMs;
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
    pinnedPath?: string,
  ): Promise<string> {
    if (pinnedPath !== undefined) {
      // A supplied authorization can only consume its live binding. Never
      // resolve a replacement after expiry, replay or a mismatched target.
      this.assertPinnedMatches(pinnedPath, plan);
      const held = this.heldPins.get(plan.pinnedPath)!;
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
    const flavor = absolutePathFlavor(plan.policyPath) ?? this.workspaceFlavor;
    const parent = pathApi(flavor).dirname(plan.policyPath);
    const parentPlan = this.planTarget(parent, cwd, "dir");
    await this.runMutation(parentPlan, { kind: "mkdir" });
  }

  private static toBuffer(data: Buffer | string, encoding?: BufferEncoding): Buffer {
    return typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : data;
  }

  // --- SandboxFsBridge surface ----------------------------------------------

  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath {
    const { absolute: abs, flavor } = this.resolveAbsolute(params.filePath, params.cwd);
    const relativePath =
      flavor === this.workspaceFlavor ? pathApi(flavor).relative(this.workspaceDir, abs) : abs;
    return {
      // Local backend: host and container namespaces coincide.
      hostPath: abs,
      containerPath: abs,
      relativePath,
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
      params.action === "remove",
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
    const { absolute: abs, flavor } = this.resolveAbsolute(params.filePath, params.cwd);
    this.assertReadable(abs, flavor);
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
    if (params.mkdir && params.pinnedPath === undefined) {
      await this.ensureParentDir(plan, params.cwd);
    }
    await this.runMutation(
      plan,
      {
        kind: "write",
        data: SrtSandboxFsBridge.toBuffer(params.data, params.encoding),
      },
      params.pinnedPath,
    );
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
    if (params.mkdir && params.pinnedPath === undefined) {
      await this.ensureParentDir(plan, params.cwd);
    }
    const result = await this.runMutation(
      plan,
      {
        kind: "create",
        data: SrtSandboxFsBridge.toBuffer(params.data, params.encoding),
      },
      params.pinnedPath,
    );
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
    const { absolute: sourceAbs, flavor } = this.resolveAbsolute(params.sourcePath, params.cwd);
    this.assertReadable(sourceAbs, flavor);
    const plan = this.planTarget(params.destinationPath, params.cwd, "file");
    this.assertPinnedMatches(params.pinnedPath, plan);
    const data = await this.client.read(sourceAbs);
    if (params.mkdir && params.pinnedPath === undefined) {
      await this.ensureParentDir(plan, params.cwd);
    }
    await this.runMutation(plan, { kind: "write", data }, params.pinnedPath);
  }

  async mkdirp(params: {
    filePath: string;
    cwd?: string;
    pinnedPath?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    params.signal?.throwIfAborted();
    const plan = this.planTarget(params.filePath, params.cwd, "dir");
    this.assertPinnedMatches(params.pinnedPath, plan);
    await this.runMutation(plan, { kind: "mkdir" }, params.pinnedPath);
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
    const plan = this.planTarget(params.filePath, params.cwd, "file", true);
    this.assertPinnedMatches(params.pinnedPath, plan);
    await this.runMutation(
      plan,
      {
        kind: "remove",
        recursive: params.recursive === true,
        // Default idempotent (force) unless the caller explicitly disables it,
        // matching the core pinned-remove default.
        force: params.force !== false,
      },
      params.pinnedPath,
    );
  }

  async rename(params: {
    from: string;
    to: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    params.signal?.throwIfAborted();
    const fromPlan = this.planTarget(params.from, params.cwd, "file", true);
    const toPlan = this.planTarget(params.to, params.cwd, "file", true);
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
    const { absolute: abs, flavor } = this.resolveAbsolute(params.filePath, params.cwd);
    this.assertReadable(abs, flavor);
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
