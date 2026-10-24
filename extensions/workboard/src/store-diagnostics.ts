import type { WorkboardCard, WorkboardDiagnostic } from "@openclaw/workboard-contract";
import { WorkboardCardConflictError, WorkboardCoreStore } from "./store-core.js";
import { metadataIsEmpty, trimMetadataToBudget } from "./store-normalizers.js";

export class WorkboardDiagnosticsStore extends WorkboardCoreStore {
  /**
   * Persist refreshed diagnostics without treating the sweep as card activity:
   * the parent row keeps its activity timestamp and event history while the
   * diagnostic observations (first/last seen, count) stay current. Keeps the
   * revision compare-and-swap so concurrent writers are not clobbered.
   */
  protected async recordCardDiagnostics(
    id: string,
    compute: (current: WorkboardCard) => WorkboardDiagnostic[] | undefined,
  ): Promise<{ card: WorkboardCard; updated: boolean }> {
    const current = await this.requireCard(id);
    const diagnostics = compute(current);
    if (diagnostics === undefined) {
      return { card: current, updated: false };
    }
    const metadata = { ...current.metadata };
    if (diagnostics.length > 0) {
      metadata.diagnostics = diagnostics;
    } else {
      delete metadata.diagnostics;
    }
    const trimmed = trimMetadataToBudget(metadata, {});
    const next: WorkboardCard = { ...current };
    if (metadataIsEmpty(trimmed)) {
      delete next.metadata;
    } else {
      next.metadata = trimmed;
    }
    const updated = await this.store.registerIfUpdatedAt(
      id,
      { version: 1, card: next },
      current.updatedAt,
    );
    if (!updated) {
      const latest = await this.get(id);
      if (!latest) {
        throw new Error(`card not found: ${id}`);
      }
      throw new WorkboardCardConflictError(latest);
    }
    return { card: next, updated: true };
  }
}
