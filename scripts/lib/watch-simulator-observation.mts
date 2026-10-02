type SimulatorDevice = {
  udid: string;
  state: string;
  isAvailable: boolean;
  deviceTypeIdentifier?: string;
};

type SimulatorInventory = {
  devices: Record<string, SimulatorDevice[]>;
  pairs: Record<string, { watch: { udid: string }; phone: { udid: string } }>;
};

export function observeOwnedWatchSimulator(inventory: SimulatorInventory, simulator: string) {
  const entries = Object.entries(inventory.devices).flatMap(([runtime, devices]) =>
    devices.map((device) => ({ ...device, runtime })),
  );
  const owned = entries.filter((device) => device.udid === simulator);
  const pairs = Object.values(inventory.pairs).filter((pair) => pair.watch.udid === simulator);
  const companion = entries.filter(
    (device) => pairs.length === 1 && device.udid === pairs[0]?.phone.udid,
  );
  const state = (devices: SimulatorDevice[]) =>
    devices.length === 1 &&
    ["Creating", "Shutdown", "Booting", "Booted", "Shutting Down"].includes(devices[0]!.state)
      ? devices[0]!.state
      : null;
  const device = owned.length === 1 ? owned[0] : undefined;
  // Publish only state and Apple runtime/type identifiers, never names, UUIDs or host paths.
  const appleIdentifier = (value: string | undefined, kind: "SimRuntime" | "SimDeviceType") =>
    value &&
    value.length <= 200 &&
    new RegExp(`^com\\.apple\\.CoreSimulator\\.${kind}\\.[A-Za-z0-9-]+$`).test(value)
      ? value
      : null;
  return {
    ownedMatches: owned.length,
    state: state(owned),
    available: typeof device?.isAvailable === "boolean" ? device.isAvailable : null,
    runtime: appleIdentifier(device?.runtime, "SimRuntime"),
    deviceType: appleIdentifier(device?.deviceTypeIdentifier, "SimDeviceType"),
    pairMatches: pairs.length,
    companionState: state(companion),
    bootedWatches: entries.filter(
      (entry) =>
        entry.runtime.startsWith("com.apple.CoreSimulator.SimRuntime.watchOS-") &&
        entry.state === "Booted",
    ).length,
    bootedIOSDevices: entries.filter(
      (entry) =>
        entry.runtime.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-") &&
        entry.state === "Booted",
    ).length,
  };
}
