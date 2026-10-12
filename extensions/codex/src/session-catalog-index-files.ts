import { setImmediate as nextTurn } from "node:timers/promises";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import type { CodexThread } from "./app-server/protocol.js";
import type {
  CodexCatalogIndexRow,
  CodexCatalogRolloutFingerprint,
} from "./session-catalog-index-row.js";
import { projectCodexCatalogNativeThread } from "./session-catalog-native-projection.js";
import {
  mergeCodexCatalogRolloutRow,
  projectCodexCatalogPage,
} from "./session-catalog-projection.js";
import {
  type CodexCatalogRolloutScanner,
  isCodexCatalogRolloutPathCovered,
} from "./session-catalog-rollout-scanner.js";
import {
  codexCatalogRolloutLogicalPath,
  readCodexCatalogRollout,
} from "./session-catalog-rollouts.js";

type ReconciliationOwner = {
  rows: ReadonlyMap<string, CodexCatalogIndexRow>;
  observedFiles: ReadonlyMap<string, CodexCatalogRolloutFingerprint>;
  scanner: CodexCatalogRolloutScanner;
  assertCurrent(): void;
  requestNativeRefresh(): void;
  report(error: unknown): void;
  put(row: CodexCatalogIndexRow): void;
  remove(id: string): void;
};

/** Plan file reconciliation; the index retains every publication and lifetime decision. */
export async function reconcileCodexCatalogFiles(
  root: string,
  owner: ReconciliationOwner,
): Promise<Map<string, CodexCatalogRolloutFingerprint>> {
  const byPath = new Map<string, CodexCatalogIndexRow>();
  let processed = 0;
  for (const row of owner.rows.values()) {
    if (row.rolloutPath) {
      byPath.set(codexCatalogRolloutLogicalPath(row.rolloutPath), row);
    }
    if (++processed % 128 === 0) {
      await nextTurn();
      owner.assertCurrent();
    }
  }
  const { files, present } = await owner.scanner.scan(new Set(byPath.keys()));
  owner.assertCurrent();
  const observed = new Map(files);
  for (const [file, fingerprint] of files) {
    if (++processed % 128 === 0) {
      await nextTurn();
      owner.assertCurrent();
    }
    const previous = byPath.get(codexCatalogRolloutLogicalPath(file));
    const known = owner.observedFiles.get(file) ?? previous?.fingerprint;
    if (known?.mtimeMs === fingerprint.mtimeMs && known.size === fingerprint.size) {
      continue;
    }
    owner.requestNativeRefresh();
    // Failed reads retain their old fingerprint so the next scan can retry.
    observed.delete(file);
    if (known) {
      observed.set(file, known);
    }
    let thread: CodexThread | undefined;
    try {
      thread = await readCodexCatalogRollout(root, file);
    } catch (error) {
      owner.assertCurrent();
      owner.report(error);
      continue;
    }
    owner.assertCurrent();
    if (!thread) {
      observed.set(file, fingerprint);
      continue;
    }
    const existing = owner.rows.get(thread.id);
    if (
      existing?.rolloutPath &&
      codexCatalogRolloutLogicalPath(existing.rolloutPath) !== codexCatalogRolloutLogicalPath(file)
    ) {
      // Reverts retain older immutable files with the same thread id. Only
      // native metadata may change which rollout the catalog considers current.
      observed.set(file, fingerprint);
      continue;
    }
    if (!existing && !thread.preview) {
      observed.set(file, fingerprint);
      continue;
    }
    thread.preview ||= existing?.preview;
    const projected = await projectCodexCatalogPage(
      { data: [projectCodexCatalogNativeThread(thread, sanitizeTerminalText)] },
      { localSessionsRoot: root, sanitize: sanitizeTerminalText },
    );
    owner.assertCurrent();
    observed.set(file, fingerprint);
    const row = projected.rows[0];
    if (!row) {
      continue;
    }
    owner.put(mergeCodexCatalogRolloutRow(row, existing, fingerprint));
    await nextTurn();
  }
  for (const row of byPath.values()) {
    if (++processed % 128 === 0) {
      await nextTurn();
      owner.assertCurrent();
    }
    if (
      row.rolloutPath &&
      isCodexCatalogRolloutPathCovered(root, row.rolloutPath) &&
      !present.has(codexCatalogRolloutLogicalPath(row.rolloutPath)) &&
      owner.rows.get(row.threadId) === row
    ) {
      owner.requestNativeRefresh();
      owner.remove(row.threadId);
    }
  }
  return observed;
}
