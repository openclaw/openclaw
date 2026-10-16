import type { HealthCheck, HealthFinding } from "openclaw/plugin-sdk/health";
import type {
  OpenKeyedStoreOptions,
  PluginStateEntry,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  asOptionalRecord as readRecord,
  normalizeOptionalString as nonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { findCrabboxBinary } from "./crabbox-binary.js";
import * as managedBinary from "./crabbox-managed-binary.js";
import { CRABBOX_WORKER_PROVIDER_ID, parseCrabboxSetupSecrets } from "./crabbox-worker-profile.js";
import { WARM_IMAGE_MAX_ENTRIES } from "./crabbox-worker-warm-image-records.js";
import {
  admitCrabboxWarmImageProfile,
  crabboxWarmImageRecoveryHint,
  CRABBOX_WARM_IMAGE_WAIT_HINT,
  projectCrabboxWarmImage,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-store.js";

export const CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID = "crabbox/cloud-worker-profiles";
const CRABBOX_SETUP_SECRETS_CHECK_ID = "crabbox/setup-secrets";
const CRABBOX_WARM_IMAGES_CHECK_ID = "crabbox/warm-images";

export type CrabboxDoctorRegistrationHost = {
  readonly openclawRoot: string;
  readonly inspectSetupSecrets: (
    names: readonly string[],
    env?: NodeJS.ProcessEnv,
  ) => Promise<
    Array<{
      name: string;
      status: "ready" | "missing" | "missing-bindings" | "conflicting-value" | "unavailable";
    }>
  >;
  readonly getHealthCheck: (id: string) => HealthCheck | undefined;
  readonly registerHealthCheck: (check: HealthCheck) => void;
  readonly listPluginStateEntries: <T>(
    options: OpenKeyedStoreOptions,
  ) => Promise<PluginStateEntry<T>[]>;
};

function createCrabboxCloudWorkerProfileCheck(openclawRoot: string): HealthCheck {
  return {
    id: CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
    kind: "plugin",
    description: "Verify configured Crabbox cloud worker and sandbox binaries before use.",
    source: "crabbox",
    async detect(ctx) {
      const targets = Object.entries(ctx.cfg.cloudWorkers?.profiles ?? {})
        .filter(
          ([, profile]) => profile.provider.trim().toLowerCase() === CRABBOX_WORKER_PROVIDER_ID,
        )
        .map(([profileId, profile]) => ({
          id: profileId,
          label: `Cloud worker profile "${profileId}"`,
          settings: readRecord(profile.settings),
          ocPath: `cloudWorkers.profiles.${profileId}.settings.binary`,
        }));
      const sandbox = readRecord(readRecord(ctx.cfg.plugins?.entries?.crabbox?.config)?.sandbox);
      if (sandbox) {
        targets.push({
          id: "sandbox",
          label: "Crabbox sandbox",
          settings: sandbox,
          ocPath: "plugins.entries.crabbox.config.sandbox.binary",
        });
      }
      if (targets.length === 0) {
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
      let managed: ReturnType<typeof managedBinary.findManagedCrabboxBinary> | undefined;
      const findings: HealthFinding[] = [];
      for (const target of targets) {
        const explicitBinary = nonEmptyString(target.settings?.binary);
        const binary = findCrabboxBinary({
          ...(explicitBinary ? { explicit: explicitBinary } : {}),
          openclawRoot,
          pathEnv: ctx.env?.PATH ?? process.env.PATH,
        });
        const result = binary ? await probe(binary) : undefined;
        if (result?.status === "supported") {
          continue;
        }
        try {
          managed ??= managedBinary.findManagedCrabboxBinary({ env: ctx.env });
          if (await managed) {
            continue;
          }
        } catch (error) {
          findings.push({
            checkId: CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
            severity: "warning",
            source: "crabbox",
            target: target.id,
            message: error instanceof Error ? error.message : "Crabbox host is unsupported",
          });
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
          message: `${target.label} ${reason}. OpenClaw will install its managed Crabbox before use.`,
          ...((binary ?? explicitBinary) ? { path: binary ?? explicitBinary } : {}),
          ocPath: target.ocPath,
          target: target.id,
          requirement: `Crabbox ${managedBinary.CRABBOX_MIN_VERSION} or newer`,
          fixHint: `Run \`openclaw doctor --fix\` to install the managed Crabbox now, or provision Crabbox ${managedBinary.CRABBOX_MIN_VERSION} or newer using \`${target.ocPath}\`. The existing executable and configuration are preserved.`,
        });
      }
      return findings;
    },
    async repair(ctx, findings) {
      if (findings.length === 0 || ctx.dryRun) {
        return { status: "skipped", changes: [] };
      }
      try {
        const { binary } = await managedBinary.ensureManagedCrabboxBinary({
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

function createCrabboxSetupSecretsCheck(host: CrabboxDoctorRegistrationHost): HealthCheck {
  const repairHint =
    "Create or repair protected entries with explicit allowed hosts using openclaw secrets, then run openclaw doctor --fix. Store values and destination bindings are never inferred or overwritten.";
  const inspect = async (ctx: Parameters<HealthCheck["detect"]>[0]) => {
    const changes: string[] = [];
    const findings: HealthFinding[] = [];
    if (
      !Object.values(ctx.cfg.cloudWorkers?.profiles ?? {}).some(
        (profile) =>
          profile.provider.trim().toLowerCase() === CRABBOX_WORKER_PROVIDER_ID &&
          readRecord(profile.settings)?.setupEnv !== undefined,
      )
    ) {
      return { config: ctx.cfg, changes, findings };
    }
    const config = structuredClone(ctx.cfg);
    for (const [profileId, profile] of Object.entries(config.cloudWorkers?.profiles ?? {})) {
      const settings = readRecord(profile.settings);
      if (
        profile.provider.trim().toLowerCase() !== CRABBOX_WORKER_PROVIDER_ID ||
        !settings ||
        settings.setupEnv === undefined
      ) {
        continue;
      }
      const path = `cloudWorkers.profiles.${profileId}.settings.setupEnv`;
      let reason: string | undefined;
      const legacy = settings.setupEnv;
      if (
        !Array.isArray(legacy) ||
        legacy.length > 16 ||
        !legacy.every(
          (name): name is string =>
            typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name),
        ) ||
        new Set(legacy).size !== legacy.length
      ) {
        reason = "legacy setupEnv is not a bounded list of distinct environment names";
      } else {
        const facts = legacy.length ? await host.inspectSetupSecrets(legacy, ctx.env) : [];
        const problems = facts.filter(({ status }) => status !== "ready");
        if (facts.length !== legacy.length || problems.length) {
          reason = problems.length
            ? problems.map(({ name, status }) => `${name}: ${status}`).join(", ")
            : "secret-store inspection is incomplete";
        } else {
          try {
            const current = parseCrabboxSetupSecrets(settings.setupSecrets) ?? {};
            const provider = ctx.cfg.secrets?.defaults?.store ?? "default";
            const next = { ...current };
            for (const name of legacy) {
              const existing = current[name];
              if (existing && (existing.provider !== provider || existing.id !== name)) {
                throw new Error(
                  `setupSecrets mapping ${name} conflicts with its same-name store entry`,
                );
              }
              next[name] = { source: "store", provider, id: name };
            }
            settings.setupSecrets = parseCrabboxSetupSecrets(next);
            delete settings.setupEnv;
            changes.push(
              `Migrated ${path} to setupSecrets using existing protected, destination-bound store entries.`,
            );
          } catch (error) {
            reason =
              error instanceof Error ? error.message : "setupSecrets mapping requires repair";
          }
        }
      }
      findings.push({
        checkId: CRABBOX_SETUP_SECRETS_CHECK_ID,
        severity: "warning",
        source: "crabbox",
        target: profileId,
        ocPath: path,
        message: `Crabbox profile ${profileId} uses retired plaintext setupEnv${reason ? ` and needs repair (${reason})` : "; protected store entries are ready to migrate"}.`,
        fixHint: repairHint,
      });
    }
    return { config, changes, findings };
  };
  return {
    id: CRABBOX_SETUP_SECRETS_CHECK_ID,
    kind: "plugin",
    description: "Migrate retired setup environment forwarding to protected setup secrets.",
    source: "crabbox",
    async detect(ctx) {
      return (await inspect(ctx)).findings;
    },
    async repair(ctx) {
      const result = await inspect(ctx);
      if (ctx.dryRun) {
        return {
          status: "skipped",
          changes: [],
          reason: "Run openclaw doctor --fix to persist setup secret migration.",
        };
      }
      return {
        status: result.changes.length ? "repaired" : "skipped",
        config: result.changes.length ? result.config : ctx.cfg,
        changes: result.changes,
        warnings: result.findings
          .filter(({ target }) => {
            const settings = readRecord(
              result.config.cloudWorkers?.profiles?.[target ?? ""]?.settings,
            );
            return settings?.setupEnv !== undefined;
          })
          .map(({ message }) => `${message} ${repairHint}`),
      };
    },
  };
}

export function registerCrabboxWorkerProviderDoctorChecks(
  host: CrabboxDoctorRegistrationHost,
): void {
  // Lookup and registration must use the same host registry across artifact loaders.
  if (!host.getHealthCheck(CRABBOX_SETUP_SECRETS_CHECK_ID)) {
    host.registerHealthCheck(createCrabboxSetupSecretsCheck(host));
  }
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
        const entries = await host.listPluginStateEntries<WarmProfileRecord>({
          namespace: "warm-images",
          maxEntries: WARM_IMAGE_MAX_ENTRIES,
          overflowPolicy: "reject-new",
          ...(ctx.env ? { env: ctx.env } : {}),
        });
        for (const { key, value } of entries) {
          const image = projectCrabboxWarmImage(key, admitCrabboxWarmImageProfile(value)!);
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
          if (image.captureUnsupported) {
            findings.push({
              ...details,
              severity: "info",
              message: `Warm-image native capture${display} is unsupported: ${image.captureUnsupported.message}`,
              fixHint:
                "Workers use an existing compatible snapshot when one is available and otherwise provision cold; capture attempts are skipped until `warmImages.refreshAfter` has elapsed since the refusal. Set `settings.warmImage: false` on the profile to stop capture attempts, or use a Crabbox configuration that supports native checkpoints.",
            });
          }
          if (image.capture) {
            const uncertain = image.capture.phase === "uncertain";
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
