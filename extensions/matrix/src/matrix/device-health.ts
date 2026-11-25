export type MatrixManagedDeviceInfo = {
  deviceId: string;
  displayName: string | null;
  current: boolean;
};

export function listStaleOpenClawMatrixDevices(
  devices: MatrixManagedDeviceInfo[],
): MatrixManagedDeviceInfo[] {
  return devices.filter(
    (device) => !device.current && device.displayName?.startsWith("OpenClaw ") === true,
  );
}
