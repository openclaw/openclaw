import { z } from "zod";
import type { DelegatedToolParameterPolicy } from "./inherited-tool-parameters.types.js";

const strings = z.array(z.string().min(1).max(4096)).max(256);
const positional = z.number().int().nonnegative().nullable();
const schema = z
  .object({
    fileTools: z
      .array(
        z
          .object({
            workspaceOnly: z.boolean(),
            readOnly: z.boolean(),
            applyPatchEnabled: z.boolean(),
            applyPatchWorkspaceOnly: z.boolean(),
            applyPatchAllowModels: strings.nullable(),
          })
          .strict(),
      )
      .max(128),
    exec: z
      .array(
        z
          .object({
            security: z.enum(["deny", "allowlist", "full"]),
            ask: z.enum(["off", "on-miss", "always"]),
            askFallback: z.enum(["deny", "allowlist", "full"]),
            autoReview: z.boolean(),
            bypassHostApprovalFloors: z.boolean(),
            host: z.enum(["auto", "gateway", "node", "sandbox"]),
            elevation: z.enum(["off", "ask", "full"]),
            strictInlineEval: z.boolean(),
            safeBins: strings,
            safeBinProfiles: z
              .array(
                z
                  .object({
                    name: z.string().min(1).max(256),
                    minPositional: positional,
                    maxPositional: positional,
                    allowedValueFlags: strings,
                    allowedBooleanFlags: strings,
                    deniedFlags: strings,
                  })
                  .strict(),
              )
              .max(256),
          })
          .strict(),
      )
      .max(128),
    sandbox: z
      .array(
        z
          .object({
            backend: z.enum(["docker", "podman"]),
            workspaceAccess: z.enum(["none", "ro", "rw"]),
            network: z.enum(["none", "bridge"]),
            readOnlyRoot: z.boolean(),
            capDrop: strings,
            tmpfs: strings,
            browserAllowHostControl: z.boolean(),
          })
          .strict(),
      )
      .max(128),
    unsupported: z
      .array(
        z
          .object({
            scope: z.enum(["exec", "fileTools", "applyPatch", "sandbox"]),
            reason: z.enum([
              "source-filesystem-root",
              "exec-node-binding",
              "exec-trusted-paths",
              "exec-reviewer-binding",
              "exec-sandbox-escape",
              "sandbox-backend",
              "sandbox-resource-binding",
            ]),
          })
          .strict(),
      )
      .max(128),
  })
  .strict();

export function parseDelegatedToolParameterPolicy(value: unknown): DelegatedToolParameterPolicy {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error("Invalid inherited tool parameter policy.");
  }
  const names = (values: readonly string[]) => [...new Set(values)].toSorted();
  const records = <T>(values: T[]): T[] => {
    const unique = new Map(values.map((entry) => [JSON.stringify(entry), entry]));
    if (unique.size > 64) {
      throw new Error("Too many inherited tool parameter restrictions.");
    }
    return [...unique.entries()]
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, entry]) => entry);
  };
  return {
    fileTools: records(
      result.data.fileTools.map((entry) => ({
        ...entry,
        applyPatchAllowModels:
          entry.applyPatchAllowModels === null
            ? null
            : names(
                entry.applyPatchAllowModels
                  .map((name) => name.trim().toLowerCase())
                  .filter(Boolean),
              ),
      })),
    ),
    exec: records(
      result.data.exec.map((entry) => {
        const profiles = entry.safeBinProfiles.map((profile) => ({
          ...profile,
          allowedValueFlags: names(profile.allowedValueFlags),
          allowedBooleanFlags: names(profile.allowedBooleanFlags),
          deniedFlags: names(profile.deniedFlags),
        }));
        const byName = new Map<string, (typeof profiles)[number]>();
        for (const profile of profiles) {
          const existing = byName.get(profile.name);
          if (existing && JSON.stringify(existing) !== JSON.stringify(profile)) {
            throw new Error("Conflicting inherited safe-bin profiles.");
          }
          byName.set(profile.name, profile);
        }
        return {
          ...entry,
          safeBins: names(entry.safeBins),
          safeBinProfiles: [...byName.values()].toSorted((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
          ),
        };
      }),
    ),
    sandbox: records(
      result.data.sandbox.map((entry) => ({
        ...entry,
        capDrop: names(entry.capDrop.map((cap) => cap.toUpperCase())),
      })),
    ),
    unsupported: records(result.data.unsupported),
  };
}
