import path from "node:path";
import { z } from "zod";
import { assertNativeObservationSelectors } from "./upgrade-qualification-observation-files.mjs";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const pathname = z.string().startsWith("/qualification/");
const observationFileSchema = z.strictObject({
  path: pathname,
  sha256: digest,
  length: z.number().int().positive(),
});
const location = z.strictObject({
  lineNumber: z.number().int().nonnegative(),
  columnNumber: z.number().int().nonnegative(),
});
// Synchronous ancestor selection is exact; async stack traces cannot be evaluated.
const factFrame = z.strictObject({
  script: observationFileSchema,
  liveScript: pathname.optional(),
  functionName: z.string().min(1),
  location,
  source: observationFileSchema,
  sourceMap: observationFileSchema,
  sourceName: z.string().min(1),
  sourceLocation: location,
});
const boundaries = [
  "intent-persistence",
  "snapshot-completion",
  "migration-commit",
  "package-publication",
  "service-startup",
  "commit-intent",
  "gate-release",
  "terminal-receipt",
] as const;
const mapping = z.strictObject({
  id: z.string().min(1),
  phase: z.enum(["fresh", "retained"]),
  entry: observationFileSchema,
  script: observationFileSchema,
  // References stay immutable; these exact target paths become admissible only when loaded.
  liveTarget: z.strictObject({ entry: pathname, script: pathname }).optional(),
  worker: z
    .strictObject({ url: z.string().min(1), occurrence: z.number().int().positive() })
    .optional(),
  location: location.optional(),
  guardExpression: z.string().min(1).optional(),
  actionId: z.string().min(1),
  database: pathname.optional(),
  operation: z.string().min(1),
  semanticAudit: observationFileSchema,
  source: observationFileSchema,
  sourceMap: observationFileSchema,
  sourceName: z.string().min(1),
  sourceLocation: location,
  captureRunExpression: z.string().min(1).optional(),
  captureStage: z.literal("recipe-plan-uuid-before-ledger-admission").optional(),
  jobId: z.string().min(1).optional(),
  snapshotContract: z.literal("original-run-pre-migration-backup").optional(),
  factFrames: z
    .strictObject({
      guard: factFrame.optional(),
      runId: factFrame.optional(),
      actionId: factFrame.optional(),
      operation: factFrame.optional(),
      jobId: factFrame.optional(),
      database: factFrame.optional(),
      ownerPayload: factFrame.optional(),
    })
    .optional(),
  heldRuntime: z
    .strictObject({
      maintenanceHeldExpression: z.string().min(1),
      suspensionPhaseExpression: z.string().min(1),
      expected: z.strictObject({
        maintenanceHeld: z.boolean(),
        suspensionPhase: z.string().min(1),
      }),
    })
    .optional(),
  facts: z.union([
    z.strictObject({
      runId: z.string().min(1),
      actionId: z.string().min(1),
      operation: z.string().min(1),
      jobId: z.string().min(1).optional(),
      database: z.string().min(1).optional(),
    }),
    z.strictObject({
      kind: z.enum(["maintenance-binding", "publication-owner"]),
      payloadExpression: z.string().min(1),
    }),
  ]),
});
/** External reviewed inputs, never authorization injected into production artifacts. */
export const historicalObservationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    purpose: z.literal("unchanged-artifact-historical-observation"),
    runId: z.string().uuid(),
    boundary: z.enum(boundaries),
    side: z.enum(["before", "after"]),
    observer: observationFileSchema,
    observerFiles: z.array(observationFileSchema).length(3),
    runtime: observationFileSchema,
    nativeBootstrap: observationFileSchema,
    artifacts: z.array(observationFileSchema).min(1),
    targetInstallation: z
      .strictObject({
        manifest: observationFileSchema,
        releaseId: z.string().min(1),
        buildId: z.string().min(1),
        packageArtifactId: z.string().min(1),
      })
      .optional(),
    mappings: z.array(mapping).min(2),
    selectedMappingId: z.string().min(1),
    runCaptureMappingId: z.string().min(1),
    // The probe is a reviewed external read-only executable, not an artifact modification.
    durableProbe: z.strictObject({
      executable: observationFileSchema,
      argv: z.array(z.string()).min(1),
      expected: z.unknown(),
      audit: observationFileSchema,
    }),
    apply: z.array(z.string().min(1)).min(1),
    resume: z.array(z.string().min(1)).min(1),
    nativeArguments: z.array(z.string().min(1)).min(1),
    installation: pathname,
    ledger: pathname,
    protectedRoots: z.array(pathname).min(2),
    // A service child may be reparented to systemd. Its exact preallocated cgroup is explicit.
    serviceCgroups: z.array(z.string().regex(/^\/[a-zA-Z0-9/_.@-]+$/u)),
    timeoutMs: z.number().int().min(1000).max(7_200_000),
  })
  .superRefine((input, context) => {
    const refuse = (message: string) => context.addIssue({ code: "custom", message });
    try {
      assertNativeObservationSelectors(input);
    } catch (error) {
      refuse(error instanceof Error ? error.message : String(error));
    }
    const toolingRoot = input.observer.path.slice(0, input.observer.path.lastIndexOf("/"));
    const requiredTooling = [
      input.observer.path,
      `${toolingRoot}/upgrade-qualification-inspector.mjs`,
      `${toolingRoot}/upgrade-qualification-observation-files.mjs`,
    ];
    if (
      new Set(input.observerFiles.map((file) => file.path)).size !== 3 ||
      requiredTooling.some(
        (filename) => !input.observerFiles.some((file) => file.path === filename),
      ) ||
      !input.observerFiles.some(
        (file) =>
          file.path === input.observer.path &&
          file.sha256 === input.observer.sha256 &&
          file.length === input.observer.length,
      )
    ) {
      refuse(
        "External observer and both executable sidecars require exact immutable input bindings.",
      );
    }
    const selected = input.mappings.filter((item) => item.id === input.selectedMappingId);
    if (
      selected.length !== 1 ||
      !selected[0]?.location ||
      !selected[0].guardExpression ||
      selected[0].phase !== "fresh"
    ) {
      refuse("One exact fresh boundary mapping with read-only guard is required.");
    }
    const capture = input.mappings.filter((item) => item.id === input.runCaptureMappingId);
    if (
      capture.length !== 1 ||
      capture[0]?.phase !== "fresh" ||
      !capture[0]?.location ||
      !capture[0]?.captureRunExpression ||
      capture[0]?.captureStage !== "recipe-plan-uuid-before-ledger-admission" ||
      !/(?:^|\/)src\/cli\/update-cli\/recipe-plan\.ts$/u.test(capture[0]?.sourceName ?? "") ||
      input.runCaptureMappingId === input.selectedMappingId
    ) {
      refuse(
        "Require the exact recipe-plan UUID capture before ledger admission and protected mutation.",
      );
    }
    if (
      capture[0]?.script.path === selected[0]?.script.path &&
      capture[0]?.location?.lineNumber === selected[0]?.location?.lineNumber &&
      capture[0]?.location?.columnNumber === selected[0]?.location?.columnNumber
    ) {
      refuse("UUID capture must precede, not alias, the actual mutation boundary.");
    }
    if (
      !input.protectedRoots.includes(input.installation) ||
      !input.protectedRoots.some((root) => input.ledger.startsWith(`${root}/`))
    ) {
      refuse("Protected inventory must include installation and ledger-parent state root.");
    }
    if (new Set(input.mappings.map((item) => item.id)).size !== input.mappings.length) {
      refuse("Mapping IDs must be unique.");
    }
    if (
      !input.mappings.some(
        (item) => item.phase === "retained" && item.location && item.guardExpression,
      )
    ) {
      refuse("Original-run retained mappings must be separately audited.");
    }
    const files = new Map(input.artifacts.map((item) => [item.path, item]));
    for (const item of [
      input.runtime,
      input.nativeBootstrap,
      ...(input.targetInstallation ? [input.targetInstallation.manifest] : []),
      ...input.mappings.flatMap((observedMapping) => [
        observedMapping.entry,
        observedMapping.script,
        observedMapping.sourceMap,
        ...Object.values(observedMapping.factFrames ?? {}).flatMap((frame) =>
          frame ? [frame.script, frame.sourceMap] : [],
        ),
      ]),
    ]) {
      const artifact = files.get(item.path);
      if (!artifact || artifact.sha256 !== item.sha256 || artifact.length !== item.length) {
        refuse("Every observed executable/entry/script must belong to the immutable closure.");
      }
    }
    if (input.targetInstallation) {
      if (
        input.artifacts.some(
          (file) =>
            file.path === input.installation || file.path.startsWith(`${input.installation}/`),
        )
      ) {
        refuse("Target closure references must remain outside the historical installation.");
      }
    }
    for (const item of input.mappings.filter((observedMapping) => observedMapping.liveTarget)) {
      if (
        !input.targetInstallation ||
        [item.liveTarget!.entry, item.liveTarget!.script].some(
          (filename) =>
            path.resolve(filename) !== filename || !filename.startsWith(`${input.installation}/`),
        )
      ) {
        refuse(
          "Live target aliases require the exact manifest and canonical native installation root.",
        );
      }
    }
    for (const item of input.mappings) {
      if (
        "kind" in item.facts &&
        (item.id !== input.selectedMappingId ||
          item.phase !== "fresh" ||
          !item.location ||
          item.worker ||
          item.jobId ||
          item.database ||
          (item.facts.kind === "maintenance-binding"
            ? input.boundary !== "gate-release" || item.operation !== "core.gateway-maintenance"
            : input.boundary !== "package-publication" ||
              item.operation !== "core.package-publish"))
      ) {
        refuse("Owner joins require the exact fresh parent boundary and approved adapter.");
      }
      if (
        (item.worker &&
          item.location &&
          (!item.jobId || !("jobId" in item.facts && item.facts.jobId))) ||
        Boolean(item.jobId) !== Boolean("jobId" in item.facts && item.facts.jobId)
      ) {
        refuse(
          "Worker boundaries require a real job discriminator; optional parent jobs must match their expressions.",
        );
      }
      for (const frame of Object.values(item.factFrames ?? {})) {
        if (
          frame?.liveScript &&
          (!input.targetInstallation ||
            path.resolve(frame.liveScript) !== frame.liveScript ||
            !frame.liveScript.startsWith(`${input.installation}/`))
        ) {
          refuse(
            "Live frame aliases require the exact target manifest and canonical installation.",
          );
        }
      }
    }
    if (
      input.boundary === "snapshot-completion" &&
      (selected[0]?.snapshotContract !== "original-run-pre-migration-backup" ||
        !/(?:^|\/)src\/cli\/update-cli\/update-command-database-backup\.ts$/u.test(
          selected[0]?.sourceName ?? "",
        ))
    ) {
      refuse(
        "Snapshot observation must select the original execution backup owner, never planner rehearsal.",
      );
    }
    if (
      input.boundary === "gate-release" &&
      (!selected[0]?.heldRuntime ||
        selected[0].heldRuntime.expected.maintenanceHeld !== (input.side === "before") ||
        !/(?:^|\/)src\/process\/gateway-work-admission\.ts$/u.test(selected[0]?.sourceName ?? ""))
    ) {
      refuse(
        "Gate release requires side-specific held-runtime observation at the admission owner before kernel stop.",
      );
    }
    if (
      input.boundary === "migration-commit" &&
      (!(selected[0] && "database" in selected[0].facts && selected[0].facts.database) ||
        !selected[0]?.database ||
        selected[0]?.operation !== "state.schema.repair")
    ) {
      refuse("Migration requires the exact database and schema-repair operation discriminator.");
    }
  });
