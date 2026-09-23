// Reads process memory budgets with controller ownership and usage evidence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeMountInfoPath } from "../../packages/normalization-core/src/mountinfo-path.ts";

const DEFAULT_CGROUP_V2_MOUNT_PATH = "/sys/fs/cgroup";
const DEFAULT_CGROUP_V1_MEMORY_MOUNT_PATH = "/sys/fs/cgroup/memory";
const PROC_SELF_CGROUP_PATH = "/proc/self/cgroup";
const PROC_SELF_LIMITS_PATH = "/proc/self/limits";
const PROC_SELF_MOUNTINFO_PATH = "/proc/self/mountinfo";
const PROC_SELF_STATUS_PATH = "/proc/self/status";
// The v2 high limit throttles reclaim, so a heap sized above it can stall the build instead of
// OOM-ing. Cgroup v1's soft limit is only advisory and must not reject an otherwise viable build.
const CGROUP_V2_MEMORY_LIMIT_FILES = ["memory.max", "memory.high"];
const CGROUP_V1_MEMORY_LIMIT_FILES = ["memory.limit_in_bytes"];
const PROC_MEMINFO_PATH = "/proc/meminfo";

export type MemoryLimitParams = {
  availableMemoryBytes?: number;
  cgroupMemoryLimitBytes?: number;
  cgroupMemoryLimitPaths?: string[];
  constrainedMemoryBytes?: number;
  env?: NodeJS.ProcessEnv;
  fs?: { readFileSync(filePath: string, encoding: "utf8"): string };
  physicalMemoryBytes?: number;
  platform?: string;
  processResidentMemoryBytes?: number;
  procMeminfoPath?: string;
  procMemTotalBytes?: number;
};

type CgroupMount = { mountPoint: string; observed: boolean; root: string };

function parseCgroupMemoryLimitBytes(value: string) {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "max" || !/^\d+$/u.test(trimmed)) {
    return null;
  }
  const parsed = BigInt(trimmed);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(parsed);
}

function isMissingFileError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function readProcessRlimitMemoryBytes(params: MemoryLimitParams) {
  if ((params.platform ?? process.platform) !== "linux") {
    return null;
  }
  try {
    const rawLimits = (params.fs ?? fs).readFileSync(PROC_SELF_LIMITS_PATH, "utf8");
    let tightestLimitBytes: number | null = null;
    for (const match of rawLimits.matchAll(
      /^Max (?:address space|data size)\s+(?<soft>\d+|unlimited)\s+/gmu,
    )) {
      const softLimit = match.groups?.soft;
      if (!softLimit || softLimit === "unlimited") {
        continue;
      }
      const parsed = parseCgroupMemoryLimitBytes(softLimit);
      if (parsed !== null && (tightestLimitBytes === null || parsed < tightestLimitBytes)) {
        tightestLimitBytes = parsed;
      }
    }
    return tightestLimitBytes;
  } catch {
    return null;
  }
}

function parseCgroupInactiveFileBytes(value: string, isV1: boolean) {
  const match = isV1
    ? (value.match(/^total_inactive_file\s+(\d+)$/mu) ?? value.match(/^inactive_file\s+(\d+)$/mu))
    : value.match(/^inactive_file\s+(\d+)$/mu);
  return match?.[1] ? parseCgroupMemoryLimitBytes(match[1]) : 0;
}

function readProcessResidentMemoryBytes(params: MemoryLimitParams) {
  const configured = params.processResidentMemoryBytes;
  if (configured !== undefined && Number.isFinite(configured) && configured >= 0) {
    return Math.trunc(configured);
  }
  try {
    const match = (params.fs ?? fs)
      .readFileSync(PROC_SELF_STATUS_PATH, "utf8")
      .match(/^VmRSS:\s+(\d+)\s+kB$/mu);
    const bytes = match?.[1] ? BigInt(match[1]) * 1024n : null;
    return bytes !== null && bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : null;
  } catch {
    return null;
  }
}

// Controller mount points are host layout, not constants: v1 controllers may be co-mounted at
// the cgroup root instead of a per-controller directory. Read them where the kernel records
// them so a slice budget is never missed because a path was assumed.
function resolveCgroupMountPoints(params: MemoryLimitParams = {}) {
  const fsImpl = params.fs ?? fs;
  let rawMountinfo = "";
  try {
    rawMountinfo = fsImpl.readFileSync(PROC_SELF_MOUNTINFO_PATH, "utf8");
  } catch {
    // Unreadable off Linux; the documented defaults still apply.
  }

  // One hierarchy can be visible through several mounts, and only some of them expose a subtree
  // containing this process, so every view is kept as a candidate rather than the last one seen.
  const unified: CgroupMount[] = [];
  const v1Memory: CgroupMount[] = [];
  for (const line of rawMountinfo.split("\n")) {
    // mountinfo separates its variable optional fields from the fstype with a lone "-".
    const [fields, describe] = line.split(" - ");
    // mountinfo fields 4 and 5 are the mount root and mount point.
    const mountFields = (fields ?? "").split(" ");
    const rawRoot = mountFields[3];
    const rawMountPoint = mountFields[4];
    const [fsType, , superOptions] = (describe ?? "").split(" ");
    if (!rawMountPoint || !rawRoot) {
      continue;
    }
    // The kernel escapes space, tab, newline, and backslash in these two fields, so
    // matching them verbatim would miss any cgroup path containing one of them.
    const root = decodeMountInfoPath(rawRoot);
    const mountPoint = decodeMountInfoPath(rawMountPoint);
    if (fsType === "cgroup2") {
      unified.push({ mountPoint, observed: true, root });
    } else if (fsType === "cgroup" && (superOptions ?? "").split(",").includes("memory")) {
      v1Memory.push({ mountPoint, observed: true, root });
    }
  }
  return {
    unified:
      unified.length > 0
        ? unified
        : [{ mountPoint: DEFAULT_CGROUP_V2_MOUNT_PATH, observed: false, root: "/" }],
    v1Memory:
      v1Memory.length > 0
        ? v1Memory
        : [{ mountPoint: DEFAULT_CGROUP_V1_MEMORY_MOUNT_PATH, observed: false, root: "/" }],
  };
}

// mountinfo field 4 is the subtree a cgroupfs mount exposes, so /proc/self/cgroup records are
// relative to it: under a container mount the visible leaf is the mount point itself, not the
// host-absolute path. A record outside that subtree is not reachable through this mount, and
// probing the mount root instead would size the build from an unrelated cgroup's limit.
function relativeCgroupPath(mountRoot: string, cgroupPath: string) {
  if (cgroupPath.split("/").includes("..")) {
    return null;
  }
  if (mountRoot === "/") {
    return cgroupPath;
  }
  const mountRootSegments = mountRoot.split("/").filter(Boolean);
  if (mountRootSegments.length > 0 && mountRootSegments.every((segment) => segment === "..")) {
    // The visible root is an ancestor, but the process's hidden child name cannot be
    // reconstructed. Treat it as unresolved instead of mistaking the parent for the leaf.
    return null;
  }
  if (mountRootSegments.includes("..")) {
    return null;
  }
  // A namespace-root record proves nothing about a mount rooted elsewhere: the kernel
  // contract does not make "/" plus an arbitrary subtree a match, so adopting that pair
  // could cap the heap from an unrelated cgroup. Fail closed to host sizing instead.
  if (cgroupPath === "/") {
    return null;
  }
  if (cgroupPath === mountRoot) {
    return "/";
  }
  return cgroupPath.startsWith(`${mountRoot}/`) ? cgroupPath.slice(mountRoot.length) : null;
}

// A systemd slice budget lives on the process's own cgroup, never on a hierarchy root, so
// probing only the root misses every limit outside a namespaced container. Legacy and hybrid
// hosts publish that same budget through the v1 memory controller instead of the `0::` record,
// so both hierarchies are walked leaf-to-root; depth 0 is the root probe.
function resolveCgroupMemoryLimitPaths(params: MemoryLimitParams = {}) {
  const fsImpl = params.fs ?? fs;
  let rawCgroup = "";
  let cgroupRecordReadFailed = false;
  try {
    rawCgroup = fsImpl.readFileSync(PROC_SELF_CGROUP_PATH, "utf8");
  } catch {
    cgroupRecordReadFailed = (params.platform ?? process.platform) === "linux";
  }

  const paths: string[] = [];
  const addHierarchy = (
    mounts: CgroupMount[],
    limitFiles: string[],
    cgroupPath: string,
    hierarchyFile?: string,
  ) => {
    const initialPathCount = paths.length;
    let addedObservedPath = false;
    let hierarchyMetadataUnreadable = false;
    for (const mount of mounts) {
      const mountInitialPathCount = paths.length;
      const mountRootSegments = mount.root.split("/").filter(Boolean);
      if (mountRootSegments.length > 0 && mountRootSegments.every((segment) => segment === "..")) {
        continue;
      }
      const relative = relativeCgroupPath(mount.root, cgroupPath ?? mount.root);
      if (relative === null) {
        continue;
      }
      const segments = relative.split("/").filter(Boolean);
      for (let depth = segments.length; depth >= 0; depth -= 1) {
        if (hierarchyFile && depth < segments.length) {
          try {
            const hierarchyPath = path.join(
              mount.mountPoint,
              ...segments.slice(0, depth),
              hierarchyFile,
            );
            const hierarchyMode = fsImpl.readFileSync(hierarchyPath, "utf8").trim();
            if (hierarchyMode === "0") {
              break;
            }
            if (hierarchyMode !== "1") {
              hierarchyMetadataUnreadable = true;
              break;
            }
          } catch {
            hierarchyMetadataUnreadable = true;
            break;
          }
        }
        for (const limitFile of limitFiles) {
          paths.push(path.join(mount.mountPoint, ...segments.slice(0, depth), limitFile));
        }
      }
      addedObservedPath ||= mount.observed && paths.length > mountInitialPathCount;
    }
    return {
      added: paths.length > initialPathCount,
      addedObservedPath,
      hierarchyMetadataUnreadable,
    };
  };

  const mounts = resolveCgroupMountPoints(params);
  let sawMemoryRecord = false;
  let sawObservedV2Mapping = false;
  let sawObservedV2Root = false;
  let sawUnreadableV1HierarchyMetadata = false;
  let sawV1MemoryRecord = false;
  let sawRejectedCgroupMapping = false;
  let sawUnresolvedCgroupLimit = false;
  for (const line of rawCgroup.split("\n")) {
    const record = /^\d+:([^:]*):(.*)$/u.exec(line);
    if (!record) {
      continue;
    }
    const controllers = record[1] ?? "";
    if (controllers === "") {
      sawMemoryRecord = true;
      const cgroupPath = record[2] ?? "";
      sawObservedV2Root ||=
        cgroupPath === "/" && mounts.unified.some((mount) => mount.observed && mount.root === "/");
      const resolved = addHierarchy(mounts.unified, CGROUP_V2_MEMORY_LIMIT_FILES, cgroupPath);
      sawObservedV2Mapping ||= resolved.addedObservedPath;
      sawRejectedCgroupMapping ||= !resolved.added;
      sawUnresolvedCgroupLimit ||= !resolved.added;
    } else if (controllers.split(",").includes("memory")) {
      sawMemoryRecord = true;
      sawV1MemoryRecord = true;
      const resolved = addHierarchy(
        mounts.v1Memory,
        CGROUP_V1_MEMORY_LIMIT_FILES,
        record[2] ?? "",
        "memory.use_hierarchy",
      );
      sawUnreadableV1HierarchyMetadata ||= resolved.hierarchyMetadataUnreadable;
      sawRejectedCgroupMapping ||= !resolved.added;
      sawUnresolvedCgroupLimit ||= !resolved.added;
    }
  }
  // Only probe the mounts blind when this process has no memory cgroup record at all; a record
  // that no mount can represent means the limit is unreadable here, not that the root applies.
  if (!sawMemoryRecord) {
    for (const mount of mounts.unified) {
      addHierarchy([mount], CGROUP_V2_MEMORY_LIMIT_FILES, mount.root);
    }
    for (const mount of mounts.v1Memory) {
      addHierarchy([mount], CGROUP_V1_MEMORY_LIMIT_FILES, mount.root);
    }
  }
  return {
    paths,
    cgroupRecordReadFailed,
    sawMemoryRecord,
    sawObservedV2Mapping,
    sawObservedUnconstrainedV2Root: sawObservedV2Root && !sawV1MemoryRecord,
    sawRejectedCgroupMapping,
    sawUnresolvedCgroupLimit,
    sawUnreadableV1HierarchyMetadata,
    sawV1MemoryRecord,
  };
}

function readCgroupMemoryLimitBytes(params: MemoryLimitParams = {}) {
  const configuredLimit = params.cgroupMemoryLimitBytes;
  if (configuredLimit !== undefined && Number.isFinite(configuredLimit) && configuredLimit >= 0) {
    return {
      limitBytes: Math.trunc(configuredLimit),
      capacityBytes: Math.trunc(configuredLimit),
      unresolved: false,
      usageKnown: false,
    };
  }

  const fsImpl = params.fs ?? fs;
  const resolvedPaths = params.cgroupMemoryLimitPaths
    ? {
        cgroupRecordReadFailed: false,
        paths: params.cgroupMemoryLimitPaths,
        sawMemoryRecord: false,
        sawObservedV2Mapping: false,
        sawObservedUnconstrainedV2Root: false,
        sawRejectedCgroupMapping: false,
        sawUnresolvedCgroupLimit: false,
        sawUnreadableV1HierarchyMetadata: false,
        sawV1MemoryRecord: false,
      }
    : resolveCgroupMemoryLimitPaths(params);
  // libuv folds cgroup v1's advisory soft limit into constrainedMemory(). Preserve its separate
  // process rlimit candidate while the owner walk reads only authoritative cgroup hard limits.
  const rlimitMemoryBytes = readProcessRlimitMemoryBytes(params);
  const constrainedMemoryBytes =
    resolvedPaths.sawV1MemoryRecord ||
    resolvedPaths.sawRejectedCgroupMapping ||
    resolvedPaths.sawUnresolvedCgroupLimit ||
    resolvedPaths.sawUnreadableV1HierarchyMetadata
      ? 0
      : (params.constrainedMemoryBytes ??
        (params.fs === undefined ? process.constrainedMemory() : 0));
  // An ancestor may bound the leaf, so the tightest limit in the chain wins.
  let tightestLimitBytes =
    Number.isFinite(constrainedMemoryBytes) && constrainedMemoryBytes > 0
      ? Math.trunc(constrainedMemoryBytes)
      : null;
  if (
    rlimitMemoryBytes !== null &&
    (tightestLimitBytes === null || rlimitMemoryBytes < tightestLimitBytes)
  ) {
    tightestLimitBytes = rlimitMemoryBytes;
  }
  // Keep the effective ceiling separate from the remaining child budget below.
  // Workload tiers must not mistake competing usage for a smaller host class.
  let capacityBytes = tightestLimitBytes;
  const processResidentMemoryBytes = readProcessResidentMemoryBytes(params);
  let readControllerLimit = false;
  let readV1HardLimit = false;
  let sawDisabledV2MemoryController = false;
  let sawUnreadableControllerFile = false;
  let usageKnown = true;
  for (const limitPath of resolvedPaths.paths) {
    try {
      const rawLimit = fsImpl.readFileSync(limitPath, "utf8");
      const trimmedLimit = rawLimit.trim();
      readControllerLimit ||= trimmedLimit === "max" || /^\d+$/u.test(trimmedLimit);
      // A controller cannot be bound to v1 and v2 simultaneously. Reading the v1 hard-limit
      // file therefore resolves memory ownership even when its value is the unlimited sentinel.
      if (path.basename(limitPath) === "memory.limit_in_bytes" && /^\d+$/u.test(trimmedLimit)) {
        readV1HardLimit = true;
      }
      const limitBytes = parseCgroupMemoryLimitBytes(rawLimit);
      if (limitBytes === null) {
        continue;
      }
      capacityBytes = capacityBytes === null ? limitBytes : Math.min(capacityBytes, limitBytes);
      let availableBytes = limitBytes;
      try {
        const isV1 = path.basename(limitPath) === "memory.limit_in_bytes";
        const cgroupDir = path.dirname(limitPath);
        const usageBytes = parseCgroupMemoryLimitBytes(
          fsImpl.readFileSync(
            path.join(cgroupDir, isV1 ? "memory.usage_in_bytes" : "memory.current"),
            "utf8",
          ),
        );
        usageKnown &&= usageBytes !== null;
        if (usageBytes !== null) {
          let inactiveFileBytes = 0;
          try {
            inactiveFileBytes =
              parseCgroupInactiveFileBytes(
                fsImpl.readFileSync(path.join(cgroupDir, "memory.stat"), "utf8"),
                isV1,
              ) ?? 0;
          } catch {
            // Missing stats make all charged usage non-reclaimable for admission.
          }
          // Total controller usage includes kernel and unreclaimable file charges. Credit only
          // inactive file pages and this wrapper's resident set before sizing its child.
          const competingBytes = Math.max(
            0,
            usageBytes -
              Math.min(usageBytes, inactiveFileBytes) -
              (processResidentMemoryBytes ?? 0),
          );
          availableBytes = Math.max(0, limitBytes - competingBytes);
        }
      } catch {
        // Keep the serial heap cap, but an unobserved shared budget cannot admit overlap.
        usageKnown = false;
      }
      if (tightestLimitBytes === null || availableBytes < tightestLimitBytes) {
        tightestLimitBytes = availableBytes;
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        sawUnreadableControllerFile = true;
        continue;
      }
      if (path.basename(limitPath) === "memory.limit_in_bytes") {
        continue;
      }
      try {
        const controllers = fsImpl
          .readFileSync(path.join(path.dirname(limitPath), "cgroup.controllers"), "utf8")
          .trim()
          .split(/\s+/u)
          .filter(Boolean);
        sawDisabledV2MemoryController ||= !controllers.includes("memory");
      } catch (controllerError) {
        sawUnreadableControllerFile ||= !isMissingFileError(controllerError);
      }
    }
  }

  return {
    limitBytes: tightestLimitBytes,
    capacityBytes,
    usageKnown,
    unresolved:
      resolvedPaths.cgroupRecordReadFailed ||
      sawUnreadableControllerFile ||
      resolvedPaths.sawUnreadableV1HierarchyMetadata ||
      (resolvedPaths.sawUnresolvedCgroupLimit && !readV1HardLimit) ||
      (resolvedPaths.sawMemoryRecord &&
        !readControllerLimit &&
        !resolvedPaths.sawObservedUnconstrainedV2Root &&
        !(
          resolvedPaths.sawObservedV2Mapping &&
          sawDisabledV2MemoryController &&
          !sawUnreadableControllerFile
        )),
  };
}

function parseProcMemoryBytes(value: string, field: "MemAvailable" | "MemTotal") {
  const match = value.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "imu"));
  const kibibytes = match?.[1];
  if (!kibibytes) {
    return null;
  }
  const parsed = BigInt(kibibytes) * 1024n;
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(parsed);
}

function readProcMemTotalBytes(params: MemoryLimitParams = {}) {
  const configuredTotal = params.procMemTotalBytes;
  if (configuredTotal && Number.isFinite(configuredTotal) && configuredTotal > 0) {
    return Math.trunc(configuredTotal);
  }

  const fsImpl = params.fs ?? fs;
  try {
    return parseProcMemoryBytes(
      fsImpl.readFileSync(params.procMeminfoPath ?? PROC_MEMINFO_PATH, "utf8"),
      "MemTotal",
    );
  } catch {
    return null;
  }
}

function readPhysicalMemoryTotalBytes(params: MemoryLimitParams = {}) {
  const totalBytes = params.physicalMemoryBytes ?? os.totalmem();
  return Number.isFinite(totalBytes) && totalBytes > 0 ? Math.trunc(totalBytes) : null;
}

function readHostAvailableMemoryBytes(params: MemoryLimitParams) {
  if (params.availableMemoryBytes !== undefined) {
    return Number.isFinite(params.availableMemoryBytes) && params.availableMemoryBytes >= 0
      ? Math.trunc(params.availableMemoryBytes)
      : null;
  }
  if ((params.platform ?? process.platform) === "linux") {
    try {
      return parseProcMemoryBytes(
        (params.fs ?? fs).readFileSync(params.procMeminfoPath ?? PROC_MEMINFO_PATH, "utf8"),
        "MemAvailable",
      );
    } catch {
      return null;
    }
  }
  return null;
}

export function readProcessMemoryCapacity(params: MemoryLimitParams) {
  const cgroupMemory = readCgroupMemoryLimitBytes(params);
  if (cgroupMemory.unresolved) {
    return { ...cgroupMemory, limitBytes: null, availableBytes: null, capacityBytes: null };
  }
  const physicalTotalBytes = readProcMemTotalBytes(params) ?? readPhysicalMemoryTotalBytes(params);
  const capacityBytes =
    physicalTotalBytes === null
      ? null
      : Math.min(physicalTotalBytes, cgroupMemory.capacityBytes ?? physicalTotalBytes);
  const hostAvailableBytes = readHostAvailableMemoryBytes(params);
  const physicalLimitBytes =
    hostAvailableBytes === null || physicalTotalBytes === null
      ? (hostAvailableBytes ?? physicalTotalBytes)
      : Math.min(hostAvailableBytes, physicalTotalBytes);
  const limitBytes =
    cgroupMemory.limitBytes === null || physicalLimitBytes === null
      ? (cgroupMemory.limitBytes ?? physicalLimitBytes)
      : Math.min(cgroupMemory.limitBytes, physicalLimitBytes);
  return { ...cgroupMemory, capacityBytes, limitBytes, availableBytes: hostAvailableBytes };
}
