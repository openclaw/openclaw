import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";

const statIdentifierSchema = z.string().regex(/^(?:0|[1-9]\d*)$/u);
export const directoryIdentitySchema = z.strictObject({
  dev: statIdentifierSchema,
  ino: statIdentifierSchema,
  stable: z
    .strictObject({
      path: z.string().refine(isAbsolute),
      birthtimeNs: z.string().regex(/^[1-9]\d*$/u),
      volume: z.string().min(1),
    })
    .optional(),
});
export type DirectoryIdentity = z.infer<typeof directoryIdentitySchema>;

// Coalesce volume lookups only within synchronous work. An awaited operation
// invalidates the mapping before revalidation, including device reuse on remount.
// Directory identity is never cached.
const volumes = new Map<string, string>();
function volumeIdentity(path: string, dev: string) {
  if (process.platform !== "darwin") {
    return "device:" + dev;
  }
  const cached = volumes.get(dev);
  if (cached) {
    return cached;
  }
  if (volumes.size === 0) {
    queueMicrotask(() => volumes.clear());
  }
  const options = { encoding: "utf8" as const, env: {}, timeout: 5_000, maxBuffer: 1024 * 1024 };
  const device = spawnSync("/usr/bin/stat", ["-f", "%Sd", path], options);
  if (device.error || device.status !== 0 || !/^disk\d+(?:s\d+)*\s*$/u.test(device.stdout)) {
    volumes.set(dev, "device:" + dev);
    return "device:" + dev;
  }
  const info = spawnSync("/usr/sbin/diskutil", ["info", "-plist", device.stdout.trim()], options);
  const uuid = /<key>VolumeUUID<\/key>\s*<string>([a-f0-9-]+)<\/string>/iu.exec(info.stdout)?.[1];
  if (info.error || info.status !== 0 || !uuid || !z.uuid().safeParse(uuid.toLowerCase()).success) {
    // Non-local filesystems and unavailable disk services must not disable
    // ordinary staging. They retain strict device matching across boots.
    volumes.set(dev, "device:" + dev);
    return "device:" + dev;
  }
  const volume = "uuid:" + uuid.toLowerCase();
  volumes.set(dev, volume);
  return volume;
}

export function captureDirectoryIdentity(
  path: string,
  stat = lstatSync(path, { bigint: true }),
): DirectoryIdentity {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("staging directory was replaced: " + path);
  }
  const dev = String(stat.dev);
  const ino = String(stat.ino);
  // Filesystems without birthtime retain the original strict device/inode rule.
  if (stat.birthtimeNs <= 0n) {
    return { dev, ino };
  }
  const physical = realpathSync(path);
  const volume = volumeIdentity(physical, dev);
  const after: BigIntStats = lstatSync(physical, { bigint: true });
  if (after.dev !== stat.dev || after.ino !== stat.ino || after.birthtimeNs !== stat.birthtimeNs) {
    throw new Error("staging directory changed during volume lookup: " + path);
  }
  return { dev, ino, stable: { path: physical, birthtimeNs: String(stat.birthtimeNs), volume } };
}

export function sameDirectoryIdentity(
  actual: DirectoryIdentity,
  expected: DirectoryIdentity,
  legacyBeforeNs?: bigint,
) {
  if (actual.ino !== expected.ino) {
    return false;
  }
  if (expected.stable) {
    return Boolean(
      actual.stable &&
      actual.stable.path === expected.stable.path &&
      actual.stable.birthtimeNs === expected.stable.birthtimeNs &&
      (actual.stable.volume === expected.stable.volume ||
        (expected.stable.volume === "device:" + expected.dev && actual.dev === expected.dev)),
    );
  }
  if (
    actual.stable &&
    legacyBeforeNs !== undefined &&
    BigInt(actual.stable.birthtimeNs) > legacyBeforeNs
  ) {
    return false;
  }
  if (actual.dev === expected.dev) {
    return true;
  }
  // Legacy receipts cannot prove their old volume UUID. Only macOS's dev-only
  // remount case is admitted at the receipt-bound path. Inode reuse after deletion
  // is guarded by birthtime preceding the receipt, then persisted as exact evidence.
  return Boolean(
    process.platform === "darwin" &&
    actual.stable?.volume.startsWith("uuid:") &&
    legacyBeforeNs !== undefined &&
    BigInt(actual.stable.birthtimeNs) <= legacyBeforeNs,
  );
}

export function upgradeDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
  legacyBeforeNs?: bigint,
): DirectoryIdentity {
  const actual = captureDirectoryIdentity(path);
  if (!sameDirectoryIdentity(actual, expected, legacyBeforeNs)) {
    throw new Error("staging directory identity changed: " + path);
  }
  return actual;
}
