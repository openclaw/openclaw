import type { WorkboardCard } from "@openclaw/workboard-contract";
import { appendComment, assertCanMutateClaimedCard } from "./store-card-helpers.js";
import { WorkboardEnrichmentStore } from "./store-enrichment.js";
import type { WorkboardMutationScope, WorkboardPromoteInput } from "./store-inputs.js";
import { clearDiagnostics, normalizeBoundedString } from "./store-normalizers.js";

export class WorkboardPromoteStore extends WorkboardEnrichmentStore {
  async move(
    id: string,
    status: unknown,
    position: unknown,
    scope?: WorkboardMutationScope,
    options: { expectedUpdatedAt?: number; assertOwnerCurrent?: () => void } = {},
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(
        id,
        (current) => {
          // Recheck after every cross-host CAS conflict so a worker cannot move
          // a card claimed between the read and write.
          assertCanMutateClaimedCard(current, scope);
          return { status, position };
        },
        {
          allowMetadataDependencyLinks: false,
          enforceStatusHolds: true,
          expectedUpdatedAt: options.expectedUpdatedAt,
        },
      );
      return result.card;
    }, options.assertOwnerCurrent);
  }

  async promote(
    id: string,
    input: WorkboardPromoteInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const reason = normalizeBoundedString(input.reason, undefined, 1000, "promote reason");
      const result = await this.updateLatestCard(
        id,
        (current) => {
          if (current.status !== "todo") {
            throw new Error(`Cannot promote Workboard card in ${current.status}; expected todo.`);
          }
          assertCanMutateClaimedCard(current, scope === null ? undefined : scope);
          return {
            status: "ready",
            metadata: {
              ...clearDiagnostics(current.metadata, ["stranded_ready", "blocked_too_long"]),
              comments: appendComment(current.metadata?.comments, reason),
              stale: null,
            },
          };
        },
        { enforceStatusHolds: input.force !== true },
      );
      return result.card;
    });
  }
}
