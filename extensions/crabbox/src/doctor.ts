import type { HealthCheck, HealthFinding } from "openclaw/plugin-sdk/health";
import {
  asOptionalRecord as readRecord,
  normalizeOptionalString as nonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import * as managedBinary from "./crabbox-managed-binary.js";
import { CRABBOX_WORKER_PROVIDER_ID, findCrabboxBinary } from "./crabbox-worker-profile.js";
import {
  crabboxWarmImageRecoveryHint,
  CRABBOX_WARM_IMAGE_WAIT_HINT,
  isCrabboxWarmImageCaptureUncertain,
  listCrabboxWarmImages,
} from "./crabbox-worker-warm-image-store.js";

export const CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID = "crabbox/cloud-worker-profiles";
const CRABBOX_WARM_IMAGES_CHECK_ID = "crabbox/warm-images";

type CrabboxDoctorRegistrationHost = {
  readonly openclawRoot: string;
  readonly getHealthCheck: (id: string) => HealthCheck | undefined;
  readonly registerHealthCheck: (check: HealthCheck) => void;
};

function createCrabboxCloudWorkerProfileCheck(openclawRoot: string): HealthCheck {
  return {
    id: CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
    kind: "plugin",
    description: "Verify configured Crabbox cloud worker profiles before dispatch.",
    source: "crabbox",
    async detect(ctx) {
      const profiles = Object.entries(ctx.cfg.cloudWorkers?.profiles ?? {}).filter(
        ([, profile]) => profile.provider.trim().toLowerCase() === CRABBOX_WORKER_PROVIDER_ID,
      );
      if (profiles.length === 0) {
        return [];
      }
      const probes = new Map<string, ReturnType<typeof managedBinary.probeCrabboxVersion>>();
      const probe = (binary: string) => {
        let pending = probes.get(binary);
        if (!pending) {
          pending = managedBinary.probeCrabboxVersion(binary);
          probes.set(binary, pending);
        }
        return pending;
      };
      const findings: HealthFinding[] = [];
      for (const [profileId, profile] of profiles) {
        const explicitBinary = nonEmptyString(readRecord(profile.settings)?.binary);
        const binary = findCrabboxBinary({
          ...(explicitBinary ? { explicit: explicitBinary } : {}),
          openclawRoot,
          pathEnv: ctx.env?.PATH ?? process.env.PATH,
        });
        const result = binary ? await probe(binary) : undefined;
        if (result?.status === "supported") {
          continue;
        }
        let managedPath: string;
        try {
          managedPath = managedBinary.resolveManagedCrabboxBinaryPath(ctx.env);
        } catch (error) {
          findings.push({
            checkId: CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
            severity: "warning",
            source: "crabbox",
            target: profileId,
            message: error instanceof Error ? error.message : "Crabbox host is unsupported",
          });
          continue;
        }
        const installed = findCrabboxBinary({ explicit: managedPath, openclawRoot });
        if (installed && (await probe(installed)).status === "supported") {
          continue;
        }
        const reason = !result
          ? "has no executable Crabbox binary"
          : result.status === "outdated"
            ? `uses outdated Crabbox ${result.version}`
            : `could not determine its Crabbox version: ${result.reason}`;
        findings.push({
          checkId: CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
          severity: "warning",
          source: "crabbox",
          message: `Cloud worker profile "${profileId}" ${reason}. OpenClaw will install its managed Crabbox before use.`,
          ...((binary ?? explicitBinary) ? { path: binary ?? explicitBinary } : {}),
          ocPath: `cloudWorkers.profiles.${profileId}.settings.binary`,
          target: profileId,
          requirement: `Crabbox ${managedBinary.CRABBOX_MIN_VERSION} or newer`,
          fixHint: `Run \`openclaw doctor --fix\` to install the managed Crabbox now, or provision Crabbox ${managedBinary.CRABBOX_MIN_VERSION} or newer using \`cloudWorkers.profiles.${profileId}.settings.binary\`. The existing executable and profile configuration are preserved.`,
        });
      }
      return findings;
    },
    async repair(ctx, findings) {
      if (findings.length === 0 || ctx.dryRun) {
        return { status: "skipped", changes: [] };
      }
      try {
        const binary = await managedBinary.ensureManagedCrabboxBinary({
          binary: managedBinary.resolveManagedCrabboxBinaryPath(ctx.env),
          env: ctx.env,
        });
        return {
          status: "repaired",
          changes: [`Installed managed Crabbox at ${binary}`],
          effects: [{ kind: "package", action: "install", target: binary }],
        };
      } catch (error) {
        return {
          status: "failed",
          changes: [],
          warnings: [
            error instanceof Error ? error.message : "Managed Crabbox installation failed",
          ],
        };
      }
    },
  };
}

export function registerCrabboxWorkerProviderDoctorChecks(
  host: CrabboxDoctorRegistrationHost,
): void {
  // Lookup and registration must use the same host registry across artifact loaders.
  if (!host.getHealthCheck(CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID)) {
    host.registerHealthCheck(createCrabboxCloudWorkerProfileCheck(host.openclawRoot));
  }
  if (!host.getHealthCheck(CRABBOX_WARM_IMAGES_CHECK_ID)) {
    host.registerHealthCheck({
      id: CRABBOX_WARM_IMAGES_CHECK_ID,
      kind: "plugin",
      description: "Report paused Crabbox warm-image captures and retained cleanup obligations.",
      source: "crabbox",
      async detect(ctx) {
        const findings: HealthFinding[] = [];
        for (const image of listCrabboxWarmImages(ctx.env)) {
          const facts = [
            image.profileId,
            image.backend,
            image.machineClass,
            image.os,
            image.projectLabel,
          ].filter(Boolean);
          const display = facts.length ? ` (${facts.join(" · ")})` : "";
          const details = {
            checkId: CRABBOX_WARM_IMAGES_CHECK_ID,
            severity: "warning",
            source: "crabbox",
            target: image.profileKey,
          } as const;
          if (image.capture) {
            const uncertain = isCrabboxWarmImageCaptureUncertain(image.capture);
            findings.push({
              ...details,
              severity: uncertain || image.capture.stale ? "warning" : "info",
              message: uncertain
                ? `Warm-image capture ${image.capture.selector}${display} is paused; its provider outcome requires manual reconciliation.`
                : image.capture.stale
                  ? `Warm-image capture ${image.capture.selector}${display} is taking longer than usual.`
                  : `Warm-image capture ${image.capture.selector}${display} is in progress.`,
              fixHint: uncertain
                ? crabboxWarmImageRecoveryHint(image.capture.selector)
                : CRABBOX_WARM_IMAGE_WAIT_HINT,
            });
          }
          if (image.retirement) {
            findings.push({
              ...details,
              message: `Warm-image checkpoint ${image.retirement.checkpointId}${display} is still awaiting deletion.`,
              fixHint:
                "Cleanup retries during the next warm-image capture or worker teardown. Inspect `openclaw crabbox warm-images --json` and resolve provider deletion errors if it remains pending.",
            });
          }
        }
        return findings;
      },
    });
  }
}
