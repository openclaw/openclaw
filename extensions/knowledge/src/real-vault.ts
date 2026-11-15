import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import type { VaultAccess } from "./access.js";
import { readText } from "./files.js";
import { Manifest, checkpointKey } from "./store-manifest.js";
import { SampleVault, type ScanCache } from "./vault.js";

/** One physical store as resolved through the registry. Paths are registry
 * facts, never authored configuration. */
export type StoreConfig = {
  root: string;
  statePath: string;
  vaultId: string;
  publicationId: string;
  writesEnabled: boolean;
  /** Degree percentile at which a page counts as a hub for its body budget. */
  hubPercentile?: number;
};
export type IdentityStore = {
  lookup(key: string): Promise<Manifest | undefined>;
  registerIfAbsent(key: string, value: Manifest): Promise<boolean>;
};
const unavailable = () =>
  new Error("Knowledge store identity or storage is unavailable; recovery review is required.");

/** Manifest/checkpoint equality fences publication, replacement, and rollback. */
export class RealVault {
  // One scan cache per scope directory. Entries self-validate against file
  // stamps, so a replaced vault or scope simply misses and rescans.
  private readonly scans = new Map<string, ScanCache>();
  constructor(
    readonly config: StoreConfig,
    private readonly identities: IdentityStore,
    private readonly observe?: (
      records: import("./model.js").LoadedRecord[],
      access: VaultAccess,
      evidence: import("./evidence-files.js").EvidenceInspector,
    ) => void,
  ) {}
  async identity() {
    try {
      const rootPath = await realpath(this.config.root),
        stat = await lstat(this.config.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw unavailable();
      }
      const value: unknown = JSON.parse(await readText(rootPath, "vault.json"));
      if (
        !Check(Manifest, value) ||
        value.vaultId !== this.config.vaultId ||
        (value.generation === 0 && value.publicationId !== this.config.publicationId)
      ) {
        throw unavailable();
      }
      return {
        manifest: {
          format: value.format,
          vaultId: value.vaultId,
          generation: value.generation,
          publicationId: value.publicationId,
        },
        rootPath,
        dev: stat.dev,
        ino: stat.ino,
      };
    } catch {
      throw unavailable();
    }
  }
  /** `checked` is for callers that asserted authority in the same synchronous
   * span; each assertion is a blocking round trip to the main thread. */
  async run<T>(
    access: VaultAccess,
    operation: (vault: SampleVault) => Promise<T>,
    checked = false,
  ): Promise<T> {
    if (!checked) {
      access.assertCurrent();
    }
    const before = await this.identity(),
      key = checkpointKey(this.config.vaultId);
    const existing = await this.identities.lookup(key);
    if (!existing) {
      if (before.manifest.generation !== 0) {
        throw unavailable();
      }
      access.assertCurrent();
      await this.identities.registerIfAbsent(key, before.manifest);
    }
    const checkpoint = await this.identities.lookup(key);
    if (JSON.stringify(checkpoint) !== JSON.stringify(before.manifest)) {
      throw unavailable();
    }
    const relative =
      access.scope.visibility === "private" ? "private" : `conversations/${access.scope.sessionId}`;
    const scopedPath = path.join(before.rootPath, relative);
    let missing = false,
      scopeStamp = "";
    const inspectScope = async () => {
      let current = before.rootPath;
      for (const part of relative.split("/")) {
        current = path.join(current, part);
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(current)) !== current) {
          throw unavailable();
        }
      }
      const info = await lstat(current);
      return `${info.dev}:${info.ino}`;
    };
    try {
      scopeStamp = await inspectScope();
    } catch (e) {
      if (
        // SAFETY: lstat, realpath and unavailable() throw Error objects; code is optional on ErrnoException.
        (e as NodeJS.ErrnoException).code === "ENOENT" &&
        access.scope.visibility === "conversation"
      ) {
        missing = true;
      } else {
        throw unavailable();
      }
    }
    let cache = this.scans.get(scopedPath);
    if (!cache) {
      this.scans.set(scopedPath, (cache = {}));
    }
    const result = await operation(
      new SampleVault(
        scopedPath,
        access.scope,
        missing,
        this.observe
          ? (records, _, evidence) => this.observe!(records, access, evidence)
          : undefined,
        cache,
      ),
    );
    access.assertCurrent();
    const after = await this.identity();
    if (
      JSON.stringify(after) !== JSON.stringify(before) ||
      (!missing && (await inspectScope()) !== scopeStamp) ||
      JSON.stringify(await this.identities.lookup(key)) !== JSON.stringify(checkpoint)
    ) {
      throw unavailable();
    }
    return result;
  }
}
