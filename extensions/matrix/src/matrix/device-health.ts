export type MatrixManagedDeviceInfo = {
  deviceId: string;
  displayName: string | null;
  current: boolean;
};

export type MatrixDeviceHealthSummary = {
  currentDeviceId: string | null;
  staleMullusiDevices: MatrixManagedDeviceInfo[];
  currentMullusiDevices: MatrixManagedDeviceInfo[];
};

const MULLUSI_DEVICE_NAME_PREFIX = "Mullusi ";

export function isMullusiManagedMatrixDevice(displayName: string | null | undefined): boolean {
  return displayName?.startsWith(MULLUSI_DEVICE_NAME_PREFIX) === true;
}

export function summarizeMatrixDeviceHealth(
  devices: MatrixManagedDeviceInfo[],
): MatrixDeviceHealthSummary {
  const currentDeviceId = devices.find((device) => device.current)?.deviceId ?? null;
  const openClawDevices = devices.filter((device) =>
    isMullusiManagedMatrixDevice(device.displayName),
  );
  return {
    currentDeviceId,
    staleMullusiDevices: openClawDevices.filter((device) => !device.current),
    currentMullusiDevices: openClawDevices.filter((device) => device.current),
  };
}
