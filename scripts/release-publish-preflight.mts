#!/usr/bin/env node
// Read-only publication admission: gather all known blockers before dispatch.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizePublicationIntent } from "./full-release-publication-contract.mjs";
import {
  fetchNpmRegistryPackumentWithRetry,
  resolveNpmPublishPlan,
} from "./lib/npm-publish-plan.mjs";
import {
  inspectPublishReleasePage,
  inspectStableCloseoutPreflight,
} from "./lib/release-publish-closeout-preflight.mts";
import {
  evaluateReleaseBootstrapGate,
  evaluateReleasePublishGates,
  type ReleasePublishGate,
} from "./lib/release-publish-gates.mts";
import {
  createPublishPreflightEvidenceClient,
  createPublishPreflightGh,
  inspectPublishPreflightTelegramEvidence,
  preflightApi,
  requirePreflightRecord,
  resolvePreflightTag,
  validatePublishPreflightNpm,
  verifyPublishedPreflightTarball,
  verifyPublishSourceLineage,
  type PublishPreflightRecord,
} from "./lib/release-publish-preflight-evidence.mts";
import {
  buildReleasePublishDispatchCommand,
  formatReleasePublishPreflight,
  parsePublishPreflightArgs,
  type PreflightReport,
  type ReleasePublishPreflightOptions,
} from "./lib/release-publish-preflight-interface.mts";
import {
  observeReleaseGitHubState,
  observeReleaseNpmState,
  readReleasePublicationPackages,
} from "./lib/release-publish-state.mts";
import { verifyReleasePreflightToolingIdentity } from "./npm-preflight-tooling-identity.mjs";
import { validateNpmPublishBoundary } from "./openclaw-npm-extended-stable-release.mjs";
import { verifyOpenClawNpmResumeRun } from "./openclaw-npm-resume-run.mts";
import {
  authenticateFullReleaseValidationEvidence,
  validateFullReleaseValidationEvidence,
} from "./validate-full-release-validation-evidence.mjs";

type PreflightContext = {
  manifest?: PublishPreflightRecord;
  manifestPath?: string;
  run?: PublishPreflightRecord;
  targetSha?: string;
  toolingSha?: string;
  allowPlannedTag?: boolean;
  npmManifest?: PublishPreflightRecord;
  npmManifestPath?: string;
  npmPreflightRun?: PublishPreflightRecord;
  fullValidationEvidence?: unknown;
};
const SHA = /^[a-f0-9]{40}$/u;
const POSITIVE_ID = /^[1-9][0-9]*$/u;
const PUBLISH_REF = /^release-publish\/([a-f0-9]{12})-[1-9][0-9]*$/u;

export async function runReleasePublishPreflight(
  options: ReleasePublishPreflightOptions,
  context: PreflightContext = {},
): Promise<PreflightReport> {
  const rows: ReleasePublishGate[] = [];
  const runGh = createPublishPreflightGh();
  const api = (endpoint: string) => preflightApi(runGh, options.repo, endpoint);
  const check = async <T,>(
    id: string,
    message: string,
    remediation: string,
    action: () => T | Promise<T>,
  ): Promise<T | undefined> => {
    console.error(`[release-publish-preflight] checking ${id}`);
    try {
      const value = await action();
      rows.push({ id, status: "PASS", message, remediation: "" });
      return value;
    } catch (error) {
      rows.push({
        id,
        status: "FAIL",
        message: error instanceof Error ? error.message : String(error),
        remediation,
      });
      return undefined;
    }
  };
  const warn = (id: string, message: string, remediation: string) =>
    rows.push({ id, status: "WARN", message, remediation });
  await check(
    "dispatch.inputs",
    "Publication inputs are consistent.",
    "Correct the named dispatch inputs and repeat preflight.",
    () => {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(options.repo)) {
        throw new Error("repo must be owner/name.");
      }
      if (
        !/^v[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*((-(alpha|beta)\.[1-9][0-9]*)|(-[1-9][0-9]*))?$/u.test(
          options.tag,
        )
      ) {
        throw new Error("Invalid release tag.");
      }
      validateNpmPublishBoundary(options.tag.slice(1), options.npmDistTag);
      if (
        options.publishOpenclawNpm !== false &&
        options.pluginPublishScope !== "all-publishable"
      ) {
        throw new Error("Core npm publication requires plugin_publish_scope=all-publishable.");
      }
      if (options.publishOpenclawNpm !== false && options.npmDistTag === "extended-stable") {
        throw new Error(
          "Extended-stable core npm publication uses its canonical extended-stable workflow.",
        );
      }
      if (
        options.pluginPublishScope === "selected"
          ? !options.plugins?.trim()
          : Boolean(options.plugins?.trim())
      ) {
        throw new Error(
          "Selected scope requires plugins; all-publishable must not supply plugins.",
        );
      }
      if (
        !["from-validation", "beta", "stable", "full"].includes(
          options.releaseProfile ?? "from-validation",
        )
      ) {
        throw new Error("Invalid release_profile.");
      }
      for (const [key, value] of Object.entries({
        full_release_validation_run_id: options.fullReleaseValidationRunId,
        full_release_validation_run_attempt: options.fullReleaseValidationRunAttempt,
        preflight_run_id: options.preflightRunId,
        openclaw_npm_resume_run_id: options.openclawNpmResumeRunId,
        npm_telegram_run_id: options.npmTelegramRunId,
      })) {
        if (value !== undefined && value !== "" && !POSITIVE_ID.test(String(value))) {
          throw new Error(`${key} must be a positive integer.`);
        }
      }
      if (options.openclawNpmResumeRunId && options.publishOpenclawNpm === false) {
        throw new Error("openclaw_npm_resume_run_id requires publish_openclaw_npm=true.");
      }
      if (Boolean(options.windowsNodeTag) !== Boolean(options.windowsNodeInstallerDigests)) {
        throw new Error(
          "windows_node_tag and windows_node_installer_digests must be supplied together.",
        );
      }
    },
  );
  // Unsafe identifiers must not be interpolated into API paths or Git expressions.
  if (rows.some((row) => row.status === "FAIL")) {
    return {
      rows,
      command: "# Correct invalid inputs before constructing a dispatch command.",
      failed: true,
    };
  }
  const releaseSha =
    context.allowPlannedTag && context.targetSha
      ? context.targetSha
      : await check(
          "release.tag",
          "Release tag resolves to an exact commit.",
          `Verify refs/tags/${options.tag}; never move an already-published tag.`,
          () => resolvePreflightTag(runGh, options.repo, options.tag),
        );
  if (context.allowPlannedTag) {
    warn(
      "release.tag",
      "Candidate tag has not been published yet.",
      `Create ${options.tag} at ${releaseSha} only after candidate validation and explicit release authorization, then rerun standalone preflight.`,
    );
  }
  const sourceSha = releaseSha ?? context.targetSha;
  let workflowRef = options.workflowRef.replace(/^refs\/(?:heads|tags)\//u, "");
  let toolingSha = context.toolingSha ?? "";
  await check(
    "publisher.tooling",
    "Protected publisher identity is valid.",
    "Use an existing protected lightweight release-publish/<sha12>-<provenance> tag at the approved tooling SHA.",
    () => {
      if (PUBLISH_REF.test(workflowRef)) {
        toolingSha = resolvePreflightTag(runGh, options.repo, workflowRef);
        verifyReleasePreflightToolingIdentity({
          repository: options.repo,
          publisherSha: toolingSha,
          workflowFullRef: `refs/tags/${workflowRef}`,
          workflowRef,
          workflowSha: toolingSha,
          runGh,
        });
      } else if (
        options.tag.includes("-alpha.") &&
        options.npmDistTag === "alpha" &&
        /^tideclaw\/alpha\/[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}Z$/u.test(workflowRef)
      ) {
        const ref = requirePreflightRecord(api(`git/ref/heads/${workflowRef}`), "Tideclaw ref");
        const object = requirePreflightRecord(ref.object, "Tideclaw ref object");
        if (object.type !== "commit" || typeof object.sha !== "string" || !SHA.test(object.sha)) {
          throw new Error("Invalid Tideclaw workflow commit.");
        }
        toolingSha = object.sha;
      } else if (workflowRef === "main") {
        const main = requirePreflightRecord(
          requirePreflightRecord(api("git/ref/heads/main"), "main").object,
          "main object",
        );
        toolingSha ||= String(main.sha);
        const proposed = `release-publish/${toolingSha.slice(0, 12)}-${Math.floor(Date.now() / 1000)}`;
        workflowRef = proposed;
        const remediation = `After explicit release authorization: git tag ${proposed} ${toolingSha} && git push origin refs/tags/${proposed}; repeat preflight with --workflow-ref ${proposed}.`;
        if (!context.allowPlannedTag) {
          throw new Error(`Mutating publish cannot dispatch from main. ${remediation}`);
        }
        warn("publisher.planned-tooling", "Protected tooling tag is still pending.", remediation);
      } else {
        throw new Error(
          "This preflight supports the regular protected-tag publication route; use the alpha or extended-stable owner workflow for other routes.",
        );
      }
    },
  );
  if (options.npmTelegramRunId && options.publishOpenclawNpm !== false) {
    rows.push(
      inspectPublishPreflightTelegramEvidence({
        repo: options.repo,
        runId: options.npmTelegramRunId,
        workflowRef,
        runGh,
      }),
    );
  }
  if (sourceSha) {
    await check(
      "release.source-lineage",
      "Release source is reachable from a trusted release branch.",
      "Use the frozen source on its canonical release branch; do not move the release tag.",
      () =>
        verifyPublishSourceLineage({
          repo: options.repo,
          sourceSha,
          workflowRef,
          releaseTag: options.tag,
          runGh,
        }),
    );
  }
  const client = createPublishPreflightEvidenceClient(options.repo);
  const evidenceRequired =
    options.publishOpenclawNpm !== false ||
    options.pluginPublishScope === "all-publishable" ||
    Boolean(options.fullReleaseValidationRunId || options.preflightRunId);
  let manifest = context.manifest;
  let attempt = String(options.fullReleaseValidationRunAttempt ?? "");
  if (evidenceRequired) {
    const run = await check(
      "validation.run",
      "Exact successful validation attempt selected.",
      "Supply the successful Full Release Validation run and exact attempt; use pnpm frv status --run <id> to inspect.",
      () => {
        if (!POSITIVE_ID.test(options.fullReleaseValidationRunId)) {
          throw new Error("full_release_validation_run_id is required.");
        }
        const selectedRun = requirePreflightRecord(
          api(`actions/runs/${options.fullReleaseValidationRunId}`),
          "validation run",
        );
        if (
          selectedRun.status !== "completed" ||
          selectedRun.conclusion !== "success" ||
          !POSITIVE_ID.test(String(selectedRun.run_attempt))
        ) {
          throw new Error("Validation run is not completed/success with an exact attempt.");
        }
        if (attempt && attempt !== String(selectedRun.run_attempt)) {
          throw new Error(
            `Validation attempt ${attempt} is no longer current; GitHub reports ${String(selectedRun.run_attempt)}.`,
          );
        }
        attempt ||= String(selectedRun.run_attempt);
        return selectedRun;
      },
    );
    if (!manifest && run) {
      manifest = await check(
        "validation.manifest",
        "Validation manifest downloaded once.",
        "Restore the exact unexpired full-release-validation-<run>-<attempt> artifact.",
        () => {
          const loaded = client.loadManifest(options.fullReleaseValidationRunId, Number(attempt));
          if (!loaded) {
            throw new Error("Full Release Validation manifest artifact is missing.");
          }
          return requirePreflightRecord(loaded.manifest, "validation manifest");
        },
      );
    }
    if (manifest) {
      const fullManifest = manifest;
      for (const consumer of [
        "publisher",
        ...(options.publishOpenclawNpm === false ? [] : ["core-npm"]),
        ...(!options.tag.includes("-alpha.") &&
        !options.tag.includes("-beta.") &&
        options.publishOpenclawNpm !== false
          ? ["stable-closeout"]
          : []),
      ] as const) {
        rows.push(
          ...evaluateReleasePublishGates({
            manifest,
            consumer: consumer as "publisher" | "core-npm" | "stable-closeout",
            releaseTag: options.tag,
            npmDistTag: options.npmDistTag,
            stableSoakWaiver: options.stableSoakWaiver,
            expectedSha: sourceSha,
            expectedReleaseProfile: options.releaseProfile,
          }),
        );
      }
      if (run && sourceSha && SHA.test(toolingSha)) {
        await check(
          "validation.provenance",
          "Full Release Validation provenance and publication selection authenticated.",
          "Use evidence admitted for this exact release source, tooling lineage, publication route and package selection.",
          async () => {
            const selection = normalizePublicationIntent(
              "publish",
              JSON.stringify({
                route:
                  options.publicationRoute === "prepared"
                    ? "prepared"
                    : options.npmDistTag === "alpha"
                      ? "alpha"
                      : options.npmDistTag === "extended-stable"
                        ? "extended-stable"
                        : "normal",
                npmDistTag: options.npmDistTag,
                publishOpenclawNpm: options.publishOpenclawNpm !== false,
                pluginPublishScope: options.pluginPublishScope,
                plugins: (options.plugins ?? "").split(/[\s,]+/u).filter(Boolean),
                ...(options.windowsNodeTag
                  ? {
                      windowsNodeTag: options.windowsNodeTag,
                      windowsNodeInstallerDigests: JSON.parse(
                        options.windowsNodeInstallerDigests ?? "",
                      ),
                    }
                  : {}),
              }),
            ).publicationSelection;
            if (!selection) {
              throw new Error("Publication intent must include an exact package selection.");
            }
            const validationOptions = {
              run,
              manifest: fullManifest,
              expectedRepository: options.repo,
              expectedRunId: options.fullReleaseValidationRunId,
              expectedRunAttempt: attempt,
              expectedTargetSha: sourceSha,
              expectedReleaseTag: options.tag,
              expectedTrustedWorkflowFullRef: `refs/${PUBLISH_REF.test(workflowRef) ? "tags" : "heads"}/${workflowRef}`,
              expectedTrustedWorkflowSha: toolingSha,
              expectedWorkflowBranch: workflowRef,
              expectedPublicationSelection: selection,
              verifierSourceSha: execFileSync(
                "git",
                ["-C", fileURLToPath(new URL("../", import.meta.url)), "rev-parse", "HEAD"],
                {
                  encoding: "utf8",
                },
              ).trim(),
              verifierSourceContent: readFileSync(
                new URL("./release-ci-summary.mjs", import.meta.url),
              ),
              isTrustedMainAncestor: (sha: string) => {
                const result = requirePreflightRecord(
                  api(`compare/${sha}...main?per_page=1`),
                  "ancestry",
                );
                return result.status === "ahead" || result.status === "identical";
              },
            };
            if (context.fullValidationEvidence) {
              const prior = requirePreflightRecord(
                context.fullValidationEvidence,
                "authenticated candidate evidence",
              );
              const evidence = requirePreflightRecord(prior.evidence, "strict candidate evidence");
              return validateFullReleaseValidationEvidence({
                ...validationOptions,
                getWorkflowSource: (sha: string) => client.getWorkflowSource(sha),
                validateEvidenceReuseStrictly: () => evidence,
              });
            }
            return authenticateFullReleaseValidationEvidence(validationOptions, client);
          },
        );
      }
    }
  }
  const inventory = sourceSha
    ? await check(
        "packages.inventory",
        "Exact release source package metadata and selection are valid.",
        `Make ${sourceSha} available with git fetch --no-tags origin ${sourceSha}; repair package metadata before cutting a new tag.`,
        () => {
          const result = readReleasePublicationPackages({
            rootDir: process.cwd(),
            sourceSha,
            npmDistTag: options.npmDistTag,
            pluginPublishScope: options.pluginPublishScope,
            plugins: options.plugins,
          });
          if (options.publishOpenclawNpm !== false && result.version !== options.tag.slice(1)) {
            throw new Error(
              `Tagged package version ${result.version} does not match ${options.tag}.`,
            );
          }
          return result;
        },
      )
    : undefined;
  const registry = inventory
    ? await check(
        "registry.observation",
        "npm registry reads completed.",
        "Retry read-only preflight after registry/network recovery; do not infer missing packages from authentication or transport errors.",
        () =>
          observeReleaseNpmState({
            version: inventory.version,
            npmDistTag: options.npmDistTag,
            plugins: inventory.npmPlugins,
            corePackages: inventory.corePackages,
            publishOpenclawNpm: options.publishOpenclawNpm,
          }),
      )
    : undefined;
  if (registry) {
    rows.push(...registry.gates);
    if (registry.bootstrapCandidates.length > 0) {
      for (const pkg of registry.bootstrapCandidates) {
        const plan = resolveNpmPublishPlan(
          pkg.version,
          undefined,
          options.npmDistTag === "extended-stable" ? "extended-stable" : undefined,
        );
        const gate: ReleasePublishGate =
          plan.channel === "beta" && plan.publishTag === "beta"
            ? {
                id: "plugin-npm.beta-bootstrap",
                status: "PASS",
                message: "Beta package is eligible for token bootstrap on beta.",
                remediation: "",
              }
            : evaluateReleaseBootstrapGate({
                releaseTag: options.tag,
                publishTag: plan.publishTag,
                packageVersion: pkg.version,
                releaseProfile: manifest?.releaseProfile,
                stableSoakWaiver: options.stableSoakWaiver,
              });
        rows.push({ ...gate, id: `plugin-npm.bootstrap.${pkg.packageName}` });
      }
      warn(
        "plugin-npm.token-liveness",
        `${registry.bootstrapCandidates.length} package(s) are not visible in npm and may need the repository NPM_TOKEN bootstrap path; token liveness is unverified locally.`,
        "Run the isolated npm whoami --registry=https://registry.npmjs.org probe documented in docs/reference/RELEASING.md using the exact repository secret. A local login or secret updated_at is not proof. Do not publish or rotate credentials during preflight.",
      );
    }
  }
  const npmEvidence =
    evidenceRequired && sourceSha && SHA.test(toolingSha)
      ? await check(
          "npm.preflight",
          "Prepared npm artifact, producer, channel and current SDK predecessor verified.",
          "Supply the exact successful preflight_run_id; acknowledge the reported SDK digest or regenerate evidence if its registry predecessor changed.",
          async () => {
            const result = await fetchNpmRegistryPackumentWithRetry({
              packageName: "openclaw",
              packageUrl: "https://registry.npmjs.org/openclaw",
              maxBytes: 16 * 1024 * 1024,
            });
            const packument = requirePreflightRecord(
              result.packument,
              "openclaw registry metadata",
            );
            const tags = requirePreflightRecord(packument["dist-tags"], "openclaw dist-tags");
            const version = tags[options.npmDistTag];
            if (typeof version !== "string") {
              throw new Error(`openclaw@${options.npmDistTag} is missing.`);
            }
            return validatePublishPreflightNpm(
              {
                repo: options.repo,
                tag: options.tag,
                targetSha: sourceSha,
                toolingSha,
                workflowRef,
                npmDistTag: options.npmDistTag,
                preflightRunId: options.preflightRunId ?? options.fullReleaseValidationRunId,
                fullReleaseValidationRunId: options.fullReleaseValidationRunId,
                fullReleaseValidationRunAttempt: attempt,
                fullManifest: manifest,
                pluginSdkApiAcknowledgement: options.pluginSdkApiAcknowledgement ?? "",
                currentSelectorRef: `v${version}`,
                currentSelectorSha: resolvePreflightTag(runGh, options.repo, `v${version}`),
                runGh,
              },
              context,
            );
          },
        )
      : undefined;
  if (sourceSha) {
    if (options.publishOpenclawNpm !== false) {
      await check(
        "github.release-admission",
        "Visible release metadata passed initial publication checks.",
        "Reconcile the exact public release's canonical notes and dependency evidence; leave docs-published bodies with their publication owner.",
        () => inspectPublishReleasePage({ repo: options.repo, tag: options.tag, sourceSha, runGh }),
      );
    }
    const github = await check(
      "github.observation",
      "GitHub release and active publication runs inspected.",
      "Restore read access to Actions, releases and repository variables; repeat preflight.",
      () =>
        observeReleaseGitHubState({
          repository: options.repo,
          releaseTag: options.tag,
          sourceSha,
          npmDistTag: options.npmDistTag,
          runGh,
        }),
    );
    if (github) {
      rows.push(...github.gates);
    }
  }
  let resume = options.openclawNpmResumeRunId ?? "";
  if (registry?.corePublished && options.publishOpenclawNpm !== false && npmEvidence) {
    const tarballSha512 = await check(
      "core-npm.immutable-bytes",
      "Published core tarball matches the prepared release bytes.",
      "Cut a correction version if the published immutable bytes differ; never republish the same version.",
      () =>
        verifyPublishedPreflightTarball({
          packageName: "openclaw",
          version: options.tag.slice(1),
          tarballSha256: String(npmEvidence.manifest.tarballSha256),
        }),
    );
    if (tarballSha512) {
      await check(
        "core-npm.resume",
        "Exact original npm publication run selected for resume.",
        "Reconcile the published package's provenance and original successful npm run; never republish an immutable version.",
        async () => {
          const version = options.tag.slice(1);
          const provenance = await fetchNpmRegistryPackumentWithRetry({
            packageName: "openclaw",
            packageUrl: `https://registry.npmjs.org/-/npm/v1/attestations/openclaw@${version}`,
            maxBytes: 4 * 1024 * 1024,
          });
          if (!provenance.ok) {
            throw new Error(`Published npm provenance returned HTTP ${provenance.status}.`);
          }
          const original = await verifyOpenClawNpmResumeRun({
            repo: options.repo,
            runId: resume,
            publication: { version, tarballSha512, document: provenance.packument },
            runGh,
          });
          resume = original.runId;
          warn(
            "core-npm.resume-input",
            `Core package exists. Resume run ${resume}.`,
            `-f openclaw_npm_resume_run_id=${resume}`,
          );
        },
      );
    }
  }
  if (
    !options.tag.includes("-alpha.") &&
    !options.tag.includes("-beta.") &&
    options.publishOpenclawNpm !== false
  ) {
    if (sourceSha) {
      rows.push(
        ...inspectStableCloseoutPreflight({
          repo: options.repo,
          tag: options.tag,
          sourceSha,
          attempt,
          runId: options.fullReleaseValidationRunId,
          runGh,
        }),
      );
    }
  }
  warn(
    "publication.runtime-authority",
    "Environment approval, exact parent/child authority, bootstrap attestation, registry byte readback and final selector state are checked again at their mutation boundaries.",
    "Approve only the intended run after preflight; keep release/tooling refs frozen. Resolve any child gate using its exact run evidence. This read-only report grants no publication authority.",
  );
  return {
    rows,
    command: buildReleasePublishDispatchCommand(options, attempt, workflowRef, resume),
    failed: rows.some((row) => row.status === "FAIL"),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const parsed = parsePublishPreflightArgs(process.argv.slice(2));
    if (parsed) {
      const report = await runReleasePublishPreflight(parsed.options);
      console.log(
        parsed.json ? JSON.stringify(report, null, 2) : formatReleasePublishPreflight(report),
      );
      if (report.failed) {
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  if (process.exitCode) {
    console.error("[release-publish-preflight] FAILED (exit 1)");
  }
}
