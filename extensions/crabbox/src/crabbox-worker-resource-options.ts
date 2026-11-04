import {
  parseWorkerMachineResources,
  WorkerProviderError,
  type WorkerMachineResources,
  type WorkerProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { readNonBlankString } from "openclaw/plugin-sdk/string-coerce-runtime";

const RESOURCE_FIELDS: Readonly<Record<string, readonly (keyof WorkerMachineResources)[]>> = {
  aws: ["machineType", "region", "diskSizeGb"],
  azure: ["machineType", "osDiskMode", "osDiskSku"],
  gcp: ["machineType", "region", "diskSizeGb"],
  machine0: ["machineType", "region"],
};

export function crabboxSupportedResources(provider: string): {
  fields: readonly (keyof WorkerMachineResources)[];
  regionKind?: "zone" | "region";
  note?: string;
} {
  const fields = RESOURCE_FIELDS[provider] ?? [];
  return {
    fields,
    ...(fields.includes("region") ? { regionKind: provider === "gcp" ? "zone" : "region" } : {}),
    ...(provider === "daytona"
      ? { note: "Daytona resources are snapshot-owned; independent overrides are unsupported." }
      : {}),
  };
}

export function parseCrabboxRequestedResources(
  provider: string,
  value: unknown,
): WorkerMachineResources | undefined {
  if (value === undefined) {
    return undefined;
  }
  let resources: WorkerMachineResources;
  try {
    resources = parseWorkerMachineResources(value);
  } catch {
    throw new WorkerProviderError(
      "Invalid Crabbox machine resources; only typed resource sizing fields are accepted",
    );
  }
  const supported = crabboxSupportedResources(provider).fields;
  for (const field of Object.keys(resources)) {
    if (!supported.some((name) => name === field)) {
      throw new WorkerProviderError(
        "Crabbox " +
          provider +
          " does not support independent resource override " +
          field +
          (provider === "daytona" ? "; resources are snapshot-owned" : ""),
      );
    }
  }
  return Object.keys(resources).length ? resources : undefined;
}

/** Keep sizing separate from administrator-owned provider, credentials, images, and setup. */
export function selectCrabboxMachineResources(
  profile: WorkerProfile,
  resources: WorkerMachineResources,
): WorkerProfile {
  const selected = parseCrabboxRequestedResources(
    readNonBlankString(profile.provider) ?? "",
    resources,
  );
  if (!selected) {
    return profile;
  }
  return { ...profile, requestedResources: selected, warmImage: false };
}

export function crabboxResourceArgs(
  provider: string,
  resources?: WorkerMachineResources,
): string[] {
  if (!resources) {
    return [];
  }
  return [
    ...(resources.machineType
      ? [provider === "machine0" ? "--machine0-size" : "--type", resources.machineType]
      : []),
    ...(provider === "machine0" && resources.region ? ["--machine0-region", resources.region] : []),
    ...(resources.osDiskMode ? ["--azure-os-disk", resources.osDiskMode] : []),
    ...(resources.osDiskSku ? ["--azure-os-disk-sku", resources.osDiskSku] : []),
  ];
}

/** Pinned upstream config.go/config_gcp.go/config_machine0.go own these native knobs. */
export function crabboxResourceEnv(
  provider: string,
  resources?: WorkerMachineResources,
): NodeJS.ProcessEnv | undefined {
  if (!resources) {
    return undefined;
  }
  const env: NodeJS.ProcessEnv = {};
  if (provider === "aws") {
    if (resources.region) {
      env.CRABBOX_AWS_REGION = resources.region;
    }
    if (resources.diskSizeGb) {
      env.CRABBOX_AWS_ROOT_GB = String(resources.diskSizeGb);
    }
  } else if (provider === "gcp") {
    if (resources.region) {
      env.CRABBOX_GCP_ZONE = resources.region;
    }
    if (resources.diskSizeGb) {
      env.CRABBOX_GCP_ROOT_GB = String(resources.diskSizeGb);
    }
  } else if (provider === "machine0" && resources.region) {
    env.CRABBOX_MACHINE0_REGION = resources.region;
  }
  return Object.keys(env).length ? env : undefined;
}
