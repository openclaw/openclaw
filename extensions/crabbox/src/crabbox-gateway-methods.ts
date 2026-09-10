import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  CRABBOX_WORKER_PROVIDER_ID,
  parseCrabboxProfile,
  resolveCrabboxWarmImageProfile,
} from "./crabbox-worker-profile.js";
import {
  crabboxWarmImageRecoveryHint,
  isCrabboxWarmImageHeld,
  listCrabboxLegacyWarmLeases,
  listCrabboxWarmImages,
  recoverCrabboxWarmImageCapture,
} from "./crabbox-worker-warm-image-store.js";

type Request = Pick<GatewayRequestHandlerOptions, "params" | "respond">;

function sendError(respond: Request["respond"], error: unknown, invalidRequest = false) {
  const payload = { error: formatErrorMessage(error) };
  respond(
    false,
    payload,
    errorShape(
      invalidRequest ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
      payload.error,
      {
        details: payload,
      },
    ),
  );
}

function profileStatus(settings: Readonly<Record<string, unknown>>) {
  try {
    const configured = parseCrabboxProfile(settings);
    // Resolve the provider's default without reading forwarded environment values.
    const profile = resolveCrabboxWarmImageProfile(configured);
    const warmImages = profile.warmImage && profile.class ? "on" : "off";
    const reason =
      configured.warmImage === false
        ? "Disabled in this profile."
        : profile.target !== "linux"
          ? "Warm images require Linux."
          : configured.warmImage !== true && configured.setupEnv?.length
            ? "Forwarded setup environment keeps warm images off by default."
            : !profile.class
              ? "Requires a configured or placement machine class."
              : configured.warmImage === true
                ? "Explicitly enabled in this profile."
                : "Enabled by default for Linux with a known machine class and no setup environment.";
    return {
      backend: configured.provider,
      machineClass: configured.class,
      os: configured.target,
      warmImages,
      reason,
    };
  } catch (error) {
    return { warmImages: "off", reason: formatErrorMessage(error) };
  }
}

function snapshotStatus() {
  return {
    images: listCrabboxWarmImages().map((image) => {
      const allocations = Object.entries(image.allocations).toSorted(([a], [b]) =>
        a.localeCompare(b),
      );
      return Object.assign(image, {
        held: Boolean(image.checkpointId && isCrabboxWarmImageHeld(image, image.checkpointId)),
        allocationCount: allocations.length,
        allocations: Object.fromEntries(allocations.slice(0, 20)),
      });
    }),
    legacyLeases: listCrabboxLegacyWarmLeases().map((lease) =>
      Object.assign(lease, { recoveryHint: crabboxWarmImageRecoveryHint(lease.selector) }),
    ),
  };
}

export function listCrabboxImages(api: OpenClawPluginApi, { params, respond }: Request): void {
  if (params !== undefined && (!isRecord(params) || Object.keys(params).length > 0)) {
    sendError(respond, new Error("crabbox.images.list takes no parameters."), true);
    return;
  }
  try {
    const profiles = Object.entries(api.runtime.config.current().cloudWorkers?.profiles ?? {})
      .filter(([, profile]) => profile.provider.trim().toLowerCase() === CRABBOX_WORKER_PROVIDER_ID)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([id, profile]) => Object.assign({ id }, profileStatus(profile.settings ?? {})));
    respond(true, { ...snapshotStatus(), profiles });
  } catch (error) {
    sendError(respond, error);
  }
}

export function recoverCrabboxImage({ params, respond }: Request): void {
  const selector = isRecord(params) ? normalizeOptionalString(params.selector) : undefined;
  if (
    !selector ||
    !isRecord(params) ||
    params.acknowledgeProviderCleanup !== true ||
    Object.keys(params).some((key) => key !== "selector" && key !== "acknowledgeProviderCleanup")
  ) {
    sendError(
      respond,
      new Error("Recovery requires a selector and acknowledgeProviderCleanup: true."),
      true,
    );
    return;
  }
  try {
    recoverCrabboxWarmImageCapture(selector, true);
    respond(true, {
      ...snapshotStatus(),
      recoveredCapture: selector,
      nextSteps:
        "Restart the Gateway after manual reconciliation; the next eligible worker can capture again.",
    });
  } catch (error) {
    sendError(respond, error);
  }
}
