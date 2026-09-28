export const active = { status: "active", sharedHost: false };

export function inspectCases(nonRunnableStates: readonly string[]) {
  return [
    { state: "running", ready: true, expected: active },
    { state: "running", ready: false, expected: active },
    { state: "provisioning", ready: false, expected: active },
    ...nonRunnableStates.map((state) => ({ state, ready: false, expected: { status: "unknown" } })),
  ];
}

export function classProfile(
  machineClass: string,
  primary: Record<string, unknown> = {},
  selectors: Record<string, unknown> = {},
) {
  return {
    class: machineClass,
    target: "linux",
    architecture: "amd64",
    primary: {
      type: "native-8vcpu-16gb",
      architecture: "amd64",
      vcpu: null,
      memory: null,
      ...primary,
    },
    fallbacks: [],
    ...selectors,
  };
}

export function mappedCatalog(profiles: unknown[]) {
  return { disposition: "mapped", profiles };
}
