import { createHash, randomUUID } from "node:crypto";
import type {
  CliBackendModelCatalogContext,
  CliBackendModelCatalogResult,
} from "openclaw/plugin-sdk/cli-backend";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { CLAUDE_CLI_ROUTE_PROBE_MODEL_IDS, CLAUDE_MODEL_ID_ALIASES } from "./cli-constants.js";
import {
  detectClaudeInstallation,
  probeClaudeVersion,
  updateClaudeInstallation,
} from "./cli-installation.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const UPDATE_LEASE_MS = 30 * 60 * 1_000;
const knownModels = new Set([
  ...CLAUDE_CLI_ROUTE_PROBE_MODEL_IDS,
  ...manifest.modelCatalog.providers.anthropic.models.map(({ id }) => id),
]);
// This is a vendor runtime requirement, independent of API model access. Keep
// new requirements here when adding catalog models that need a newer CLI.
const minimumVersions: Readonly<Record<string, string>> = {
  "claude-opus-5-5": "2.1.280",
};

type CheckRecord = {
  attemptId: string;
  attemptedAt: number;
  minimumVersion: string;
  pendingUntil?: number;
  message?: string;
};

type VersionFact = {
  version?: string;
  minimumChecked: string;
  nextCheckAt: number;
  message?: string;
};

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function canonicalModel(model: string): string {
  const id = model
    .toLowerCase()
    .replace(/\[1m\]$/u, "")
    .replace(/-\d{8}$/u, "");
  return CLAUDE_MODEL_ID_ALIASES.get(id) ?? id;
}

function requiredVersion(modelIds: readonly string[]): string {
  return modelIds.reduce((minimum, id) => {
    const requirement = minimumVersions[canonicalModel(id)] ?? "0.0.0";
    return compareVersions(requirement, minimum) > 0 ? requirement : minimum;
  }, "0.0.0");
}

function satisfies(version: string | undefined, minimum: string): boolean {
  return version !== undefined && compareVersions(version, minimum) >= 0;
}

function project(
  context: CliBackendModelCatalogContext,
  fact: VersionFact,
): CliBackendModelCatalogResult {
  return {
    models: Object.fromEntries(
      context.modelIds.map((id) => {
        const model = canonicalModel(id);
        if (!knownModels.has(model)) {
          return [
            id,
            {
              available: false,
              reason: `Claude CLI compatibility for ${id} is not known. Use its direct API route or update OpenClaw's model catalog.`,
            },
          ];
        }
        const minimum = minimumVersions[model] ?? "0.0.0";
        return [
          id,
          satisfies(fact.version, minimum)
            ? { available: true }
            : {
                available: false,
                reason:
                  fact.message ??
                  `Claude CLI${fact.version ? ` ${fact.version}` : ""} cannot run ${id}. ${minimum !== "0.0.0" ? `Version ${minimum} or newer is required. ` : ""}Update the configured Claude CLI installation and refresh models.`,
              },
        ];
      }),
    ),
    nextCheckAt: fact.nextCheckAt,
    ...(fact.version ? { runtimeVersion: fact.version } : {}),
  };
}

/** Discovery and turn admission share facts; ordinary reads never probe or install. */
export function createClaudeCliReadiness(
  api: OpenClawPluginApi,
  invalidateVersion: () => void,
): (context: CliBackendModelCatalogContext) => Promise<CliBackendModelCatalogResult> {
  const facts = new Map<string, VersionFact>();
  const pending = new Map<
    string,
    { promise: Promise<VersionFact>; reason: CliBackendModelCatalogContext["reason"] }
  >();

  const check = async (
    context: CliBackendModelCatalogContext,
    minimum: string,
  ): Promise<VersionFact> => {
    const assertCurrent = () => {
      context.signal.throwIfAborted();
      context.assertCurrent();
    };
    assertCurrent();
    const command = { ...context, assertCurrent };
    const version = await probeClaudeVersion(command);
    assertCurrent();
    const observedAt = Date.now();
    const fact: VersionFact = {
      version,
      minimumChecked: minimum,
      nextCheckAt: observedAt + CHECK_INTERVAL_MS,
    };
    if (satisfies(version, minimum) || minimum === "0.0.0") {
      return fact;
    }
    const detected = await detectClaudeInstallation(command);
    assertCurrent();
    if (detected.status !== "supported") {
      return { ...fact, message: detected.message };
    }
    if (!context.withMaintenance) {
      return {
        ...fact,
        message:
          "Claude CLI repair is waiting for host maintenance admission. Refresh models from the Gateway host.",
      };
    }
    // Cooldown reads do not admit maintenance: admitting it invalidates runtime
    // facts even if no updater runs, making every later turn probe again.
    const store = api.runtime.state
      .openKeyedStore<CheckRecord>({
        namespace: "claude-cli-compatibility",
        maxEntries: 64,
        env: context.env,
      })
      .withCurrent?.({ assertCurrent });
    if (!store) {
      return {
        ...fact,
        message:
          "Claude CLI automatic repair requires durable update state. Update OpenClaw or update Claude CLI manually, then refresh models.",
      };
    }
    const key = createHash("sha256").update(detected.installation.key).digest("hex");
    const deferred = (
      previous: CheckRecord | undefined,
      checkedAt: number,
    ): VersionFact | undefined => {
      if (previous?.pendingUntil && previous.pendingUntil > checkedAt) {
        return {
          ...fact,
          nextCheckAt: Math.min(previous.pendingUntil, checkedAt + 5_000),
          message:
            "Claude CLI compatibility repair is in progress. Refresh models when it finishes.",
        };
      }
      if (
        previous &&
        context.reason !== "manual" &&
        previous.attemptedAt + CHECK_INTERVAL_MS > checkedAt &&
        compareVersions(previous.minimumVersion, minimum) >= 0
      ) {
        return {
          ...fact,
          nextCheckAt: previous.attemptedAt + CHECK_INTERVAL_MS,
          message:
            previous.message ??
            "Claude CLI is still too old for this model. Automatic repair was already attempted today. Update the configured installation manually and refresh models to retry.",
        };
      }
      return undefined;
    };
    const previous = await store.observe(key);
    assertCurrent();
    const cooldown = deferred(previous.value, Date.now());
    if (cooldown) {
      return cooldown;
    }
    const maintained = await context.withMaintenance(async () => {
      assertCurrent();
      const refreshedVersion = await probeClaudeVersion(command);
      assertCurrent();
      if (satisfies(refreshedVersion, minimum)) {
        return { ...fact, version: refreshedVersion };
      }
      const attemptedAt = Date.now();
      // The cache must not expire before the persisted attempt becomes eligible.
      fact.nextCheckAt = attemptedAt + CHECK_INTERVAL_MS;
      // Persist attempts before installation so failure and process restarts do not
      // turn each model read into another package-manager invocation.
      let observation = await store.observe(key);
      assertCurrent();
      const attempt: CheckRecord = {
        attemptId: randomUUID(),
        attemptedAt,
        minimumVersion: minimum,
        pendingUntil: attemptedAt + UPDATE_LEASE_MS,
      };
      for (;;) {
        // Another owner may have claimed the installation while admission waited.
        const blocked = deferred(observation.value, attemptedAt);
        if (blocked) {
          return blocked;
        }
        assertCurrent();
        const claim = await store.compareAndApply(key, observation.comparison, {
          operation: "update",
          action: "set",
          value: attempt,
        });
        assertCurrent();
        if (claim.status !== "conflict") {
          break;
        }
        observation = claim.current;
      }
      let result: VersionFact;
      try {
        const updated = await updateClaudeInstallation(command, detected.installation);
        assertCurrent();
        if (updated.status === "updated") {
          // Even an ineffective channel update can change identity/capabilities.
          invalidateVersion();
          result = {
            ...fact,
            version: updated.version,
            ...(satisfies(updated.version, minimum)
              ? {}
              : {
                  message: `The installed Claude CLI channel still provides ${updated.version}; this model requires ${minimum}. Update the configured installation to a compatible release, then refresh models.`,
                }),
          };
        } else {
          result = {
            ...fact,
            version: await probeClaudeVersion(command),
            message: updated.message,
          };
        }
      } catch (error) {
        // The already-persisted attempt limits retries even if this owner retires.
        assertCurrent();
        throw error;
      }
      const completed = await store.observe(key);
      assertCurrent();
      if (completed.value?.attemptId === attempt.attemptId) {
        await store.compareAndApply(key, completed.comparison, {
          operation: "update",
          action: "set",
          value: {
            attemptId: attempt.attemptId,
            attemptedAt,
            minimumVersion: minimum,
            ...(result.message ? { message: result.message } : {}),
          },
        });
      }
      assertCurrent();
      return result;
    });
    return (
      maintained ?? {
        ...fact,
        nextCheckAt: Date.now() + 5_000,
        message:
          "Claude CLI repair is deferred while active turns finish. Refresh models after they complete.",
      }
    );
  };

  return async (context) => {
    context.assertCurrent();
    context.signal.throwIfAborted();
    const key = createHash("sha256")
      .update(
        JSON.stringify({
          command: context.command,
          runtimeGeneration: context.runtimeGeneration,
          cwd:
            /[\\/]/u.test(context.command) && !context.command.startsWith("/")
              ? context.cwd
              : undefined,
          // The selected installation and state store must share the execution host.
          env: Object.fromEntries(
            [
              "HOME",
              "USERPROFILE",
              "PATH",
              "Path",
              "XDG_DATA_HOME",
              "OPENCLAW_HOME",
              "OPENCLAW_STATE_DIR",
              "npm_config_prefix",
            ].map((name) => [name, context.env[name]]),
          ),
        }),
      )
      .digest("hex");
    const minimum = requiredVersion(context.modelIds);
    for (;;) {
      const current = pending.get(key);
      if (!current) {
        break;
      }
      const shared = await current.promise;
      context.assertCurrent();
      context.signal.throwIfAborted();
      if (
        satisfies(shared.version, minimum) ||
        ((context.reason !== "manual" || current.reason === "manual") &&
          compareVersions(shared.minimumChecked, minimum) >= 0)
      ) {
        return project(context, shared);
      }
      // A manual retry must follow an unavailable automatic check. Rejoin a
      // newer pending pass if another waiter already started that retry.
    }
    const cached = facts.get(key);
    if (
      cached &&
      context.reason !== "manual" &&
      cached.nextCheckAt > Date.now() &&
      (satisfies(cached.version, minimum) || compareVersions(cached.minimumChecked, minimum) >= 0)
    ) {
      return project(context, cached);
    }
    const promise = check(context, minimum);
    pending.set(key, { promise, reason: context.reason });
    try {
      const fact = await promise;
      context.assertCurrent();
      context.signal.throwIfAborted();
      if (cached && cached.version !== fact.version) {
        invalidateVersion();
      }
      if (facts.size >= 64 && !facts.has(key)) {
        const oldest = facts.keys().next().value;
        if (oldest !== undefined) {
          facts.delete(oldest);
        }
      }
      facts.set(key, fact);
      return project(context, fact);
    } finally {
      if (pending.get(key)?.promise === promise) {
        pending.delete(key);
      }
    }
  };
}
