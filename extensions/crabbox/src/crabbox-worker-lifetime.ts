import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  crabboxCommandError,
  crabboxCommandOutput,
  parseCrabboxJson,
  runCrabboxCommand,
  sanitizeCrabboxNotice,
  type LeaseCommandContext,
} from "./crabbox-worker-command.js";
import { parseCrabboxLeaseLifetime, type ParsedInspect } from "./crabbox-worker-inspect.js";
import { parseCrabboxDurationMs, type parseCrabboxProfile } from "./crabbox-worker-profile.js";
import { inspectWithContext, isNonRunnableState } from "./crabbox-worker-provision-commands.js";
import {
  resolveCrabboxCheckpointCaptureTimeoutMs,
  resolveCrabboxLifecycleTimeoutMs,
  WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS,
} from "./crabbox-worker-timeouts.js";

type CaptureContext = LeaseCommandContext & {
  profile: ReturnType<typeof parseCrabboxProfile>;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  sourcePreparationTimeoutMs: number;
};

// Admission only: the existing heartbeat owner protects idle time. No recurring
// extension, replacement lease, or independent lifetime policy is created here.
export async function prepareCrabboxCaptureLifetime(
  context: CaptureContext,
  dependencies: {
    observe: (inspect: ParsedInspect) => void;
  },
): Promise<void> {
  const assertCurrent = () => {
    context.signal?.throwIfAborted();
    context.assertCurrent?.();
  };
  const command = (action: string, args: string[]) => {
    assertCurrent();
    return runCrabboxCommand({
      ...context,
      action,
      args,
      timeoutMs: resolveCrabboxLifecycleTimeoutMs(context.provider),
    });
  };
  const inspect = async () => {
    assertCurrent();
    const observed = await inspectWithContext(context);
    assertCurrent();
    if (!observed || isNonRunnableState(observed.state)) {
      throw new Error(
        "Crabbox capture preparation failed: lease_not_active; the source lease is no longer active",
      );
    }
    dependencies.observe(observed);
    return observed;
  };
  // Scrub, native capture/source recovery, and runtime preparation each keep
  // their existing budgets. Image collection has already run before admission.
  const windowMs =
    context.sourcePreparationTimeoutMs +
    WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS +
    resolveCrabboxCheckpointCaptureTimeoutMs(context.provider);
  const failure = (reason: string, observed: ParsedInspect): never => {
    const expiry = observed.lifetime?.expiresAtMs;
    throw new Error(
      `Crabbox capture preparation failed: ${reason}; source expiry ${expiry ? new Date(expiry).toISOString() : "unknown"}. Request sufficient TTL at creation or finish without a new image.`,
    );
  };
  await inspect();
  const heartbeat = await command("capture heartbeat", [
    "heartbeat",
    "--provider",
    context.provider,
    "--id",
    context.id,
    "--json",
  ]);
  crabboxCommandOutput("capture heartbeat", heartbeat);
  let observed = await inspect();
  const notice = sanitizeCrabboxNotice(heartbeat.stderr);
  if (notice) {
    dependencies.observe({ ...observed, lifetime: { ...observed.lifetime, policyNotice: notice } });
  }
  if ((observed.lifetime?.expiresAtMs ?? 0) - Date.now() >= windowMs) {
    return;
  }

  const totalDeadline = async (current: ParsedInspect): Promise<number | undefined> => {
    const lifetime = current.lifetime;
    if (lifetime?.createdAtMs !== undefined && lifetime.ttlMs !== undefined) {
      return (
        lifetime.createdAtMs + Math.min(lifetime.ttlMs, lifetime.maxLifetimeMs ?? lifetime.ttlMs)
      );
    }
    // Coordinator inspect's expiry can be idle-limited and omits the creation
    // anchor. Its live list exposes both; retain only this exact lease's fields.
    const result = await command("capture lifetime", [
      "list",
      "--provider",
      context.provider,
      "--json",
    ]);
    if (result.termination !== "exit" || result.code !== 0) {
      throw crabboxCommandError("capture lifetime", { ...result, stdout: "" });
    }
    const rows = parseCrabboxJson(result.stdout, "list");
    assertCurrent();
    if (!Array.isArray(rows)) {
      return undefined;
    }
    const matches = rows.filter(
      (row) => isRecord(row) && row.id === context.id && row.provider === context.provider,
    );
    if (matches.length !== 1 || !isRecord(matches[0])) {
      return undefined;
    }
    const facts = parseCrabboxLeaseLifetime(matches[0]);
    // Never carry unrelated list/connection material into the lifecycle owner.
    const effective = { ...current.lifetime, ...facts };
    observed = { ...current, lifetime: effective };
    dependencies.observe(observed);
    return effective.createdAtMs !== undefined && effective.ttlMs !== undefined
      ? effective.createdAtMs +
          Math.min(effective.ttlMs, effective.maxLifetimeMs ?? effective.ttlMs)
      : undefined;
  };
  let deadline = await totalDeadline(observed);
  assertCurrent();
  if (deadline === undefined) {
    // An expiry beyond the complete source window is a sufficient lower bound.
    deadline = observed.lifetime?.expiresAtMs;
  }
  if (deadline !== undefined && deadline - Date.now() >= windowMs) {
    return;
  }
  const lifetime = observed.lifetime;
  if (lifetime?.runtimeExtension === false || context.provider === "daytona") {
    failure("lease_extension_unsupported_provider (creation-fixed lifetime)", observed);
  }
  if (lifetime?.extension === "deny") {
    failure("lease_extension_denied", observed);
  }
  if (lifetime?.createdAtMs === undefined || lifetime.ttlMs === undefined) {
    return failure("cannot establish the remaining total lifetime", observed);
  }
  const requestedMs = parseCrabboxDurationMs(context.profile.ttl)!;
  // Reserve both bounded extension attempts and the following inspect/list
  // readback; those calls consume lifetime before source capture can begin.
  const settlementMs = 4 * resolveCrabboxLifecycleTimeoutMs(context.provider);
  const desiredMs =
    Math.ceil((Date.now() + windowMs + settlementMs - lifetime.createdAtMs) / 1000) * 1000;
  if (
    desiredMs > requestedMs ||
    (lifetime.maxLifetimeMs !== undefined && desiredMs > lifetime.maxLifetimeMs)
  ) {
    failure("the required source window exceeds the configured TTL or effective maximum", observed);
  }
  const args = [
    "extend",
    context.id,
    "--provider",
    context.provider,
    "--ttl",
    `${desiredMs / 1000}s`,
    "--json",
  ];
  // A partial direct guest refresh is the one retryable write: replay the exact
  // total target once, never --by. Crabbox retains its pending local claim.
  for (let attempt = 0; attempt < 2; attempt++) {
    let result;
    try {
      result = await command("capture extension", args);
    } catch (error) {
      assertCurrent();
      observed = await inspect();
      await totalDeadline(observed);
      return failure(
        error instanceof Error ? error.message : "extension outcome is uncertain",
        observed,
      );
    }
    assertCurrent();
    let partial = false;
    if (result.stdout.trim()) {
      let value: unknown;
      try {
        value = JSON.parse(result.stdout);
      } catch {
        /* Normal CLI errors need not be JSON. */
      }
      if (isRecord(value)) {
        if (value.id !== context.id) {
          failure("extension returned a different lease id", observed);
        }
        partial = value.guestExpiryRefreshPending === true || Boolean(value.error);
      }
    }
    if (partial) {
      if (attempt === 0) {
        continue;
      }
      failure(
        `direct guest expiry refresh remains unconfirmed; reconcile with crabbox extend ${context.id} --provider ${context.provider} --ttl ${desiredMs / 1000}s --json using the same Crabbox state`,
        observed,
      );
    }
    if (result.termination !== "exit" || result.code !== 0) {
      const detail = crabboxCommandError("capture extension", result).message;
      const code = [
        "lease_extension_denied",
        "lease_extension_budget_exceeded",
        "lease_extension_unsupported_provider",
        "lease_extension_not_advancing",
        "lease_not_active",
      ].find((name) => detail.includes(name));
      // Even a timeout may have committed the write. Observe it once, but do
      // not treat provider metadata alone as proof of a direct guest refresh.
      observed = await inspect();
      await totalDeadline(observed);
      failure(code ?? detail, observed);
    }
    observed = await inspect();
    deadline = await totalDeadline(observed);
    assertCurrent();
    if (deadline !== undefined && deadline - Date.now() >= windowMs) {
      return;
    }
    failure("extension did not confirm sufficient remaining total lifetime", observed);
  }
}
