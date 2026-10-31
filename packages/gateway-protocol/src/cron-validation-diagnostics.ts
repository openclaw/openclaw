import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type, type TSchema } from "typebox";
import { Errors } from "typebox/schema";
import { CronAddParamsSchema, CronUpdateParamsSchema } from "./schema/cron.js";
import type { ValidationError } from "./validation-errors.js";

type CronTaggedSchema =
  | typeof CronAddParamsSchema.properties.schedule
  | typeof CronAddParamsSchema.properties.payload
  | (typeof CronUpdateParamsSchema.anyOf)[0]["properties"]["patch"]["properties"]["payload"];

function taggedVariants(schema: CronTaggedSchema, instancePath: string) {
  const variants = new Map<string, TSchema>();
  for (const branch of schema.anyOf) {
    const kind = branch.properties?.kind?.const;
    if (typeof kind !== "string" || !branch.required?.includes("kind") || variants.has(kind)) {
      return (_value: unknown) => ({ schema, invalidKind: undefined });
    }
    variants.set(kind, branch);
  }
  const kinds = [...variants.keys()];
  const unknownKind = Type.Object(
    { kind: Type.String({ enum: kinds }) },
    { additionalProperties: true },
  );
  return (value: unknown): { schema: TSchema; invalidKind?: ValidationError } => {
    if (!isRecord(value) || kinds.length === 0) {
      return { schema };
    }
    const selected = typeof value.kind === "string" ? variants.get(value.kind) : undefined;
    return selected
      ? { schema: selected }
      : {
          schema: unknownKind,
          invalidKind: {
            keyword: "enum",
            instancePath: `${instancePath}/kind`,
            params: { allowedValues: kinds },
            message: "must be equal to one of the allowed values",
          },
        };
  };
}

// Only these two authored unions need branch-aware diagnostics. The original
// protocol schema still owns admission; no schema traversal or repair runs here.
function cronDiagnostics(update: boolean) {
  const fields = update
    ? CronUpdateParamsSchema.anyOf[0].properties.patch.properties
    : CronAddParamsSchema.properties;
  const prefix = update ? "/patch" : "";
  const scheduleFor = taggedVariants(fields.schedule, `${prefix}/schedule`);
  const payloadFor = taggedVariants(fields.payload, `${prefix}/payload`);
  const views = new Map<TSchema, Map<TSchema, TSchema>>();
  return (value: unknown): ValidationError[] | undefined => {
    const job = isRecord(value) ? (update ? value.patch : value) : undefined;
    if (!isRecord(job)) {
      return undefined;
    }
    const schedule = scheduleFor(job.schedule);
    const payload = payloadFor(job.payload);
    if (schedule.schema === fields.schedule && payload.schema === fields.payload) {
      return undefined;
    }
    let byPayload = views.get(schedule.schema);
    if (!byPayload) {
      byPayload = new Map();
      views.set(schedule.schema, byPayload);
    }
    let view = byPayload.get(payload.schema);
    if (!view) {
      const properties = { ...fields, schedule: schedule.schema, payload: payload.schema };
      if (update) {
        const branches: TSchema[] = [];
        for (const branch of CronUpdateParamsSchema.anyOf) {
          branches.push({
            ...branch,
            properties: {
              ...branch.properties,
              patch: { ...branch.properties.patch, properties },
            },
          });
        }
        view = { ...CronUpdateParamsSchema, anyOf: branches };
      } else {
        view = { ...CronAddParamsSchema, properties };
      }
      byPayload.set(payload.schema, view);
    }
    const invalidKinds = [schedule.invalidKind, payload.invalidKind].filter(
      (error): error is ValidationError => error !== undefined,
    );
    const invalidPaths = [
      ...(schedule.invalidKind ? [`${prefix}/schedule`] : []),
      ...(payload.invalidKind ? [`${prefix}/payload`] : []),
    ];
    const errors = Errors(view, value)[1].filter(
      (error) =>
        !invalidPaths.some(
          (path) => error.instancePath === path || error.instancePath?.startsWith(`${path}/`),
        ),
    );
    const diagnostics = [...invalidKinds, ...errors];
    return diagnostics.length > 0 ? diagnostics : undefined;
  };
}

export const cronAddDiagnostics = cronDiagnostics(false);
export const cronUpdateDiagnostics = cronDiagnostics(true);
