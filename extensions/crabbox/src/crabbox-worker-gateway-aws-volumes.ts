import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import { onlyAwsRecord, requireAwsRecord } from "./crabbox-worker-gateway-aws-policy.js";
export type AwsLaunchVolume = { volumeId: string; device: string };
export function assertDisposableAwsImage(value: unknown, imageId: string): void {
  const image = onlyAwsRecord(value, "AMI");
  if (
    image.ImageId !== imageId ||
    image.State !== "available" ||
    image.RootDeviceType !== "ebs" ||
    typeof image.RootDeviceName !== "string" ||
    !Array.isArray(image.BlockDeviceMappings)
  ) {
    throw new WorkerProviderError("AWS guest image block-device policy is unqualified");
  }
  let root = false;
  for (const item of image.BlockDeviceMappings) {
    const mapping = requireAwsRecord(item, "AMI device");
    if (typeof mapping.DeviceName !== "string") {
      throw new WorkerProviderError("AWS guest AMI device name is missing");
    }
    if (mapping.DeviceName === image.RootDeviceName) {
      requireAwsRecord(mapping.Ebs, "AMI root EBS mapping");
      root = true;
    }
    if (mapping.Ebs !== undefined) {
      const ebs = requireAwsRecord(mapping.Ebs, "AMI EBS mapping");
      if (mapping.DeviceName !== image.RootDeviceName && ebs.DeleteOnTermination !== true) {
        throw new WorkerProviderError(
          "AWS guest AMI data volumes must delete on termination before allocation",
        );
      }
    }
  }
  const projected = image.BlockDeviceMappings.filter(
    (item) => requireAwsRecord(item, "AMI device").Ebs !== undefined,
  ).map((item) => ({
    device: requireAwsRecord(item, "AMI device").DeviceName,
    volumeId: "vol-00000000000000000",
  }));
  if (JSON.stringify(projected).length > 2048) {
    throw new WorkerProviderError(
      "AWS guest AMI volume inventory exceeds durable custody capacity before allocation",
    );
  }
  if (!root) {
    throw new WorkerProviderError("AWS guest AMI root mapping is missing");
  }
}
export function launchVolumeMappings(instance: Record<string, unknown>): AwsLaunchVolume[] {
  if (
    !Array.isArray(instance.BlockDeviceMappings) ||
    !instance.BlockDeviceMappings.length ||
    instance.BlockDeviceMappings.length > 128
  ) {
    throw new WorkerProviderError("AWS guest launch volume mappings are missing");
  }
  const devices = new Set<string>(),
    ids = new Set<string>();
  const volumes = instance.BlockDeviceMappings.map((item) => {
    const mapping = requireAwsRecord(item, "instance block device"),
      ebs = requireAwsRecord(mapping.Ebs, "instance EBS mapping");
    if (
      typeof mapping.DeviceName !== "string" ||
      typeof ebs.VolumeId !== "string" ||
      !/^vol-[a-f0-9]{8,17}$/u.test(ebs.VolumeId) ||
      devices.has(mapping.DeviceName) ||
      ids.has(ebs.VolumeId)
    ) {
      throw new WorkerProviderError("AWS guest volume mapping identity is invalid or duplicated");
    }
    devices.add(mapping.DeviceName);
    ids.add(ebs.VolumeId);
    return { device: mapping.DeviceName, volumeId: ebs.VolumeId };
  }).toSorted((a, b) => a.device.localeCompare(b.device));
  if (JSON.stringify(volumes).length > 2048) {
    throw new WorkerProviderError("AWS guest volume inventory exceeds durable custody capacity");
  }
  return volumes;
}
export function assertOwnedLaunchVolume(
  value: unknown,
  expected: AwsLaunchVolume,
  leaseId: string,
  instanceId: string,
  attached: boolean,
): Record<string, unknown> {
  const volume = onlyAwsRecord(value, "exact launch volume");
  const tags = Array.isArray(volume.Tags)
    ? volume.Tags.filter((item) => requireAwsRecord(item, "volume tag").Key === "lease")
    : [];
  if (
    volume.VolumeId !== expected.volumeId ||
    tags.length !== 1 ||
    requireAwsRecord(tags[0], "volume lease tag").Value !== leaseId ||
    !Array.isArray(volume.Attachments)
  ) {
    throw new WorkerProviderError("AWS guest volume ownership/provenance changed");
  }
  if (attached) {
    const attachment = onlyAwsRecord(volume.Attachments, "launch volume attachment");
    if (
      attachment.InstanceId !== instanceId ||
      attachment.Device !== expected.device ||
      attachment.State !== "attached"
    ) {
      throw new WorkerProviderError("AWS guest launch volume is attached to a different resource");
    }
  } else if (volume.Attachments.length || volume.State !== "available") {
    throw new WorkerProviderError(
      "Recorded AWS guest volume is not independently detached; cleanup remains owned",
    );
  }
  return volume;
}
export function receiptVolumes(value: unknown): AwsLaunchVolume[] {
  if (typeof value !== "string") {
    throw new WorkerProviderError("AWS guest cleanup has no persisted launch volume custody");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new WorkerProviderError("Invalid AWS guest launch volume receipt");
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new WorkerProviderError("Empty AWS guest launch volume receipt");
  }
  const instance = {
    BlockDeviceMappings: parsed.map((item) => {
      const row = requireAwsRecord(item, "recorded volume");
      return { DeviceName: row.device, Ebs: { VolumeId: row.volumeId } };
    }),
  };
  return launchVolumeMappings(instance);
}
