import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOptionalString as nonEmptyString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CrabboxMachineShape } from "./crabbox-worker-profile.js";

// Pinned Crabbox 9930a6de: native Azure tiers include disk capacity; generic classes stay 2/4.
// The public numeric summaries require integers. Fractional sizes remain exact in the labels.
export const CRABBOX_SANDBOX_TYPES: readonly (CrabboxMachineShape & { tier: string })[] = [
  {
    class: "0.25cpu-0.5gib",
    tier: "xs",
    os: "linux",
    label: "XS · 0.25 CPU / 0.5 GiB / 5 GiB disk",
  },
  {
    class: "0.5cpu-1gib",
    tier: "s",
    os: "linux",
    memoryGb: 1,
    label: "S · 0.5 CPU / 10 GiB disk",
  },
  {
    class: "1cpu-2gib",
    tier: "m",
    os: "linux",
    cpu: 1,
    memoryGb: 2,
    label: "M · 20 GiB disk",
  },
  {
    class: "2cpu-4gib",
    tier: "l",
    os: "linux",
    cpu: 2,
    memoryGb: 4,
    label: "L · 40 GiB disk",
  },
  {
    class: "4cpu-8gib",
    tier: "xl",
    os: "linux",
    cpu: 4,
    memoryGb: 8,
    label: "XL · 80 GiB disk",
  },
  {
    class: "8cpu-16gib",
    tier: "2xl",
    os: "linux",
    cpu: 8,
    memoryGb: 16,
    label: "2XL · 160 GiB disk",
  },
  {
    class: "16cpu-32gib",
    tier: "3xl",
    os: "linux",
    cpu: 16,
    memoryGb: 32,
    label: "3XL · 320 GiB disk",
  },
];

export function resolveCrabboxMachineType(value: string | undefined): string | undefined {
  const selected = value?.toLowerCase();
  return CRABBOX_SANDBOX_TYPES.find((shape) => shape.class === selected || shape.tier === selected)
    ?.class;
}

export function parseCrabboxMachineType(
  profile: Readonly<Record<string, unknown>>,
  provider: string | undefined,
) {
  const machineType = resolveCrabboxMachineType(nonEmptyString(profile.type));
  if (profile.type !== undefined && (provider !== "azure-sandbox" || !machineType)) {
    throw new WorkerProviderError(
      "Crabbox type requires azure-sandbox and a supported native type or Azure tier (XS through 3XL)",
    );
  }
  if (machineType && profile.class !== undefined) {
    throw new WorkerProviderError("Crabbox profile must select type or class, not both");
  }
  return machineType;
}
