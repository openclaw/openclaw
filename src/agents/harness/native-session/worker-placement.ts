import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value && !value.includes("\0"));
/** Physical ownership stays stable while placement transition generations advance. */
export const NativeWorkerPlacementOwnerSchema = z.strictObject({
  agentId: id,
  sessionKey: z
    .string()
    .min(1)
    .refine((value) => value.trim() === value),
  sessionId: id,
  environmentId: id,
  ownerEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  retentionOwnerBinding: id.optional(),
});
export type NativeWorkerPlacementOwner = z.infer<typeof NativeWorkerPlacementOwnerSchema>;
export const NativeWorkerLossRecoverySchema = z.strictObject({
  version: z.literal(1),
  predecessor: NativeWorkerPlacementOwnerSchema,
  predecessorGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  replacementDispatchGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type NativeWorkerLossRecovery = z.infer<typeof NativeWorkerLossRecoverySchema>;
export type NativeWorkerPlacement = {
  owner: NativeWorkerPlacementOwner;
  recovery?: NativeWorkerLossRecovery;
};
