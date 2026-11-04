import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { closedObject } from "./closed-object.js";

const ResourceName = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
});
/** Resource sizing only: never credentials, images, mounts, helpers, endpoints, or identities. */
export const WorkerMachineResourcesSchema = Object.assign(
  closedObject({
    machineType: Type.Optional(ResourceName),
    region: Type.Optional(ResourceName),
    // This bound preserves integer precision; provider limits remain provider-owned.
    diskSizeGb: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    osDiskMode: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("managed"), Type.Literal("ephemeral")]),
    ),
    osDiskSku: Type.Optional(ResourceName),
  }),
  { minProperties: 1 },
);
export type WorkerMachineResources = Static<typeof WorkerMachineResourcesSchema>;

export function parseWorkerMachineResources(value: unknown): WorkerMachineResources {
  if (!Value.Check(WorkerMachineResourcesSchema, value)) {
    throw new Error("Invalid machine resource selection");
  }
  return value;
}
