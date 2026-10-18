import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, openSync, readlinkSync, readSync } from "node:fs";
import { z } from "zod";

const uuidSchema = z
  .uuid()
  .refine(
    (value) =>
      value === value.toLowerCase() &&
      value !== "00000000-0000-0000-0000-000000000000" &&
      value !== "ffffffff-ffff-ffff-ffff-ffffffffffff",
  );
export const processProvenanceSchema = z
  .discriminatedUnion("platform", [
    z.strictObject({
      platform: z.literal("darwin"),
      hostId: uuidSchema,
      bootId: uuidSchema,
      pidNamespace: z.literal(""),
    }),
    z.strictObject({
      platform: z.literal("linux"),
      hostId: z.string().regex(/^(?!0{32}$)[a-f0-9]{32}$/u),
      bootId: uuidSchema,
      pidNamespace: z.string().regex(/^pid:\[[1-9]\d{0,19}\]$/u),
    }),
  ])
  .readonly();
export type ProcessProvenance = z.infer<typeof processProvenanceSchema>;

function readBounded(path: string, limit: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    // procfs reports zero-sized files, so bound the read itself, not stat.size.
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) {
        return bytes.subarray(0, length).toString("utf8").trim();
      }
      length += count;
    }
    throw new Error("Process provenance exceeds its read limit.");
  } finally {
    closeSync(fd);
  }
}

function systemOutput(command: string, args: string[], maxBuffer = 1024) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: {},
    timeout: 1_000,
    maxBuffer,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Process provenance is unavailable.");
  }
  return result.stdout.trim();
}

let cachedProvenance: ProcessProvenance | null | undefined;
export function currentProcessProvenance(): ProcessProvenance | undefined {
  if (cachedProvenance !== undefined) {
    return cachedProvenance ?? undefined;
  }
  try {
    if (process.platform === "darwin") {
      const hardware = systemOutput(
        "/usr/sbin/ioreg",
        ["-rd1", "-c", "IOPlatformExpertDevice"],
        64 * 1024,
      );
      const hostId = /"IOPlatformUUID"\s*=\s*"([a-f0-9-]+)"/iu.exec(hardware)?.[1];
      cachedProvenance = processProvenanceSchema.parse({
        platform: "darwin",
        hostId: hostId?.toLowerCase(),
        bootId: systemOutput("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]).toLowerCase(),
        pidNamespace: "",
      });
    } else if (process.platform === "linux") {
      cachedProvenance = processProvenanceSchema.parse({
        platform: "linux",
        hostId: readBounded("/etc/machine-id", 128),
        bootId: readBounded("/proc/sys/kernel/random/boot_id", 128).toLowerCase(),
        pidNamespace: readlinkSync("/proc/self/ns/pid"),
      });
    } else {
      cachedProvenance = null;
    }
  } catch {
    cachedProvenance = null;
  }
  return cachedProvenance ?? undefined;
}

let cachedBootTimeNs: bigint | null | undefined;
export function currentBootTimeNs(): bigint | undefined {
  if (cachedBootTimeNs !== undefined) {
    return cachedBootTimeNs ?? undefined;
  }
  try {
    let seconds: string | undefined;
    let microseconds = "0";
    if (process.platform === "darwin") {
      const output = systemOutput("/usr/sbin/sysctl", ["-n", "kern.boottime"]);
      const match =
        /^\{\s*sec\s*=\s*([1-9]\d*),\s*usec\s*=\s*(\d{1,6})\s*\}(?:\s+[^\r\n]*)?$/u.exec(output);
      seconds = match?.[1];
      microseconds = match?.[2] ?? "0";
    } else if (process.platform === "linux") {
      const output = readBounded("/proc/stat", 1024 * 1024);
      seconds = /^btime ([1-9]\d*)$/mu.exec(output)?.[1];
    }
    if (!seconds) {
      throw new Error("Boot time is unavailable.");
    }
    cachedBootTimeNs = BigInt(seconds) * 1_000_000_000n + BigInt(microseconds) * 1_000n;
  } catch {
    cachedBootTimeNs = null;
  }
  return cachedBootTimeNs ?? undefined;
}

const processDomains = new WeakMap<ProcessProvenance, string>();
export function processDomain(provenance = currentProcessProvenance()): string | undefined {
  if (!provenance) {
    return undefined;
  }
  const cached = processDomains.get(provenance);
  if (cached !== undefined) {
    return cached;
  }
  // Preserve the original digest so legacy receipts from this boot retain PID checks.
  const domain = createHash("sha256")
    .update(provenance.platform + ":" + provenance.bootId + ":" + provenance.pidNamespace)
    .digest("hex");
  processDomains.set(provenance, domain);
  return domain;
}
