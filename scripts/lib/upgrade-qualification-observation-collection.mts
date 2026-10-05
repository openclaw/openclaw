import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { pointerSchema } from "../../src/infra/upgrade-recipes/retained-run-contract.js";
import { historicalObservationSchema } from "./upgrade-qualification-observation-contract.mjs";
import {
  assertNativeObservationSelectors,
  assertOwnerObservationProvenance,
} from "./upgrade-qualification-observation-files.mjs";

type Observation = z.infer<typeof historicalObservationSchema>;
export async function readHistoricalObservation(
  input: string,
  cell: { runId: string; apply: string[]; resume: string[] },
): Promise<Observation> {
  const observation = historicalObservationSchema.parse(
    JSON.parse(await fs.readFile(path.join(input, "observation.json"), "utf8")),
  );
  if (
    observation.runId !== cell.runId ||
    JSON.stringify(observation.apply) !== JSON.stringify(cell.apply) ||
    JSON.stringify(observation.resume) !== JSON.stringify(cell.resume)
  ) {
    throw new Error("External observation changed original cell run or native selectors.");
  }
  return observation;
}
export async function collectHistoricalObservation(options: {
  observation: Observation;
  result: string;
  directory: string;
  runId: string;
  execute: (argv: string[]) => Promise<string>;
}): Promise<void> {
  const { observation, result, directory, runId, execute } = options;
  // Verify the external tooling before executing it, not merely its own self-check.
  for (const artifact of [observation.runtime, ...observation.observerFiles]) {
    const digest = (await execute(["sha256sum", "--", artifact.path])).trim().split(/\s+/u);
    if (digest[0] !== artifact.sha256 || digest[1] !== artifact.path) {
      throw new Error("External observation executable changed before launch.");
    }
  }
  await execute([
    observation.runtime.path,
    observation.observer.path,
    "/qualification/input/observation.json",
    "/qualification/output/observation",
  ]);
  const receipt = parseHistoricalObservationReceipt(
    JSON.parse(await fs.readFile(path.join(result, "observation", "observation.json"), "utf8")),
    observation,
    runId,
  );
  await fs.writeFile(path.join(directory, "observation-receipt.json"), JSON.stringify(receipt), {
    flag: "wx",
    mode: 0o600,
  });
}

/** Admit only exact unchanged original-run custody from the reviewed external observer. */
export function parseHistoricalObservationReceipt(
  value: unknown,
  observation: Observation,
  runId: string,
) {
  const receipt = z
    .object({
      purpose: z.literal("unchanged-artifact-historical-observation"),
      observationId: z.literal(runId),
      originalRunId: z.string().uuid(),
      boundary: z.literal(observation.boundary),
      side: z.literal(observation.side),
      crashRecoveryObserved: z.literal(true),
      qualificationPassed: z.literal(false),
      admissions: z.array(z.unknown()).min(2),
      retained: z.array(z.unknown()).min(1),
      nativeSelectors: z.object({ apply: z.unknown(), resume: z.unknown() }),
      originalCustody: z.object({
        runId: z.string().uuid(),
        createdAtMs: z.number().int().nonnegative().safe(),
        pointer: pointerSchema,
      }),
      resumedCustody: z.unknown(),
      boundaryObservation: z
        .object({
          mappingId: z.string(),
          observedFacts: z.unknown().optional(),
          ownerProvenance: z.unknown().optional(),
          heldRuntime: z
            .object({
              maintenanceHeld: z.boolean(),
              suspensionPhase: z.string(),
              stage: z.literal("debugger-held-before-kernel-stop"),
            })
            .optional(),
        })
        .optional(),
    })
    .parse(value);
  if (
    receipt.originalCustody.runId !== receipt.originalRunId ||
    receipt.originalCustody.pointer.runId !== receipt.originalRunId ||
    receipt.originalCustody.pointer.originalCreatedAtMs !== receipt.originalCustody.createdAtMs ||
    receipt.originalCustody.pointer.ledgerAuthority.databasePath !== observation.ledger ||
    receipt.originalCustody.pointer.nativeAuthority.installKey !== observation.installation ||
    !isDeepStrictEqual(receipt.originalCustody, receipt.resumedCustody) ||
    !isDeepStrictEqual(receipt.nativeSelectors, assertNativeObservationSelectors(observation))
  ) {
    throw new Error("External receipt lost unchanged original retained custody.");
  }
  const selectedOwner = observation.mappings.find(
    (item) => item.id === observation.selectedMappingId,
  );
  if (selectedOwner && "kind" in selectedOwner.facts) {
    if (receipt.boundaryObservation?.mappingId !== selectedOwner.id) {
      throw new Error("Owner receipt selects another boundary mapping.");
    }
    assertOwnerObservationProvenance(
      selectedOwner,
      observation.boundary,
      receipt.originalRunId,
      receipt.boundaryObservation.observedFacts,
      receipt.boundaryObservation.ownerProvenance,
      receipt.originalCustody,
    );
  }
  if (observation.boundary === "gate-release") {
    const selected = observation.mappings.find((item) => item.id === observation.selectedMappingId);
    const held = receipt.boundaryObservation?.heldRuntime;
    if (
      receipt.boundaryObservation?.mappingId !== observation.selectedMappingId ||
      !held ||
      held.maintenanceHeld !== (observation.side === "before") ||
      held.suspensionPhase !== selected?.heldRuntime?.expected.suspensionPhase
    ) {
      throw new Error("Gate receipt lacks the side-specific held-runtime observation.");
    }
  }
  return receipt;
}

/** Docker image IDs bind local fixtures without inventing a registry manifest digest. */
export function assertQualificationImageIdentity(reference: string, identity: string): string {
  const actual = identity.trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(actual)) {
    throw new Error("Qualification image has no immutable Docker image identity.");
  }
  if (reference.startsWith("sha256:") && reference !== actual) {
    throw new Error("Qualification image differs from its pinned local image ID.");
  }
  return actual;
}

export function assertRootlessQualificationDaemon(observation: string): string {
  const info = z
    .object({ ID: z.string().min(1), SecurityOptions: z.array(z.string()) })
    .parse(JSON.parse(observation));
  if (!info.SecurityOptions.includes("name=rootless")) {
    throw new Error(
      "Qualification requires a rootless Docker daemon; rootful privileged execution is refused. Select a rootless local daemon before retrying.",
    );
  }
  return info.ID;
}
