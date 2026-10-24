import assert from "node:assert/strict";
import fs from "node:fs";

export const COMPILER_NETWORK_POLICY = "linux-none-with-inactive-fallbacks-v1";
// Linux creates these namespace-local fallback devices even with Docker's null
// network driver. Names/types are ABI contracts, not proof that a device is down.
// See Linux v6.6.141 net/{ipv4,ipv6} tunnel setup and include/uapi/linux/if_arp.h.
export const compilerNetworkDeviceTypes = new Map([
  ["lo", "772"],
  ["tunl0", "768"],
  ["gre0", "778"],
  ["gretap0", "1"],
  ["erspan0", "1"],
  ["sit0", "776"],
  ["ip6tnl0", "769"],
  ["ip6gre0", "823"],
  ["ip_vti0", "768"],
  ["ip6_vti0", "769"],
]);

export type CompilerNetworkEvidence = {
  policy: string;
  collectorNamespace: string;
  probe: string;
};

/** Validate observed isolation facts before compiler execution and during audit. */
export function assertCompilerNetworkIsolation(evidence: CompilerNetworkEvidence) {
  assert.equal(evidence?.policy, COMPILER_NETWORK_POLICY, "Missing network isolation policy");
  assert.match(evidence.collectorNamespace, /^net:\[\d+\]$/u);
  assert(typeof evidence.probe === "string" && Buffer.byteLength(evidence.probe) <= 16384);
  const arity = new Map([
    ["namespace", 2],
    ["capability", 3],
    ["no-new-privs", 2],
    ["sysfs", 5],
    ["proc", 2],
    ["route4", 2],
    ["route6", 2],
    ["routes4", 2],
    ["routes6", 2],
    ["tcp", 2],
  ]);
  const rows = evidence.probe
    .trimEnd()
    .split("\n")
    .map((line) => line.split("\t"));
  for (const row of rows) {
    assert(row[0] && arity.get(row[0]) === row.length, "Malformed network observation");
  }
  const entries = (key: string) => rows.filter((row) => row[0] === key).map((row) => row.slice(1));
  const compareNames = (a: string | undefined, b: string | undefined) =>
    a === b ? 0 : String(a) < String(b) ? -1 : 1;
  const single = (key: string) => {
    const values = entries(key);
    assert.equal(values.length, 1, "Missing or duplicate network observation: " + key);
    const value = values[0]?.[0];
    assert(value !== undefined);
    return value;
  };
  const namespace = single("namespace");
  assert.match(namespace, /^net:\[\d+\]$/u);
  assert.notEqual(namespace, evidence.collectorNamespace, "Shared collector network namespace");
  const capabilities = entries("capability");
  assert.deepEqual(
    capabilities.map(([name]) => name).toSorted(compareNames),
    ["CapAmb", "CapBnd", "CapEff", "CapInh", "CapPrm"],
    "Missing or duplicate capability observation",
  );
  for (const [, value] of capabilities) {
    assert.equal(value, "0000000000000000", "Container retained capabilities");
  }
  assert.equal(single("no-new-privs"), "1", "Privilege escalation is not disabled");
  const devices = new Set<string>();
  for (const [name, type, flags, operstate] of entries("sysfs")) {
    assert(name && type && flags && operstate, "Incomplete device observation");
    assert(!devices.has(name), "Duplicate network device");
    devices.add(name);
    assert.equal(compilerNetworkDeviceTypes.get(name), type, "Unknown network device or type");
    assert.match(flags, /^0x[0-9a-f]{1,8}$/u, "Malformed interface flags");
    if (name === "lo") {
      assert.equal(Number(flags) & 9, 9, "Loopback is not active");
    } else {
      assert.equal(Number(flags) & 1, 0, "Non-loopback device is administratively up");
      assert.equal(operstate, "down", "Non-loopback device is not down");
    }
  }
  assert(devices.has("lo"), "Missing loopback device");
  assert.deepEqual(
    entries("proc")
      .map(([name]) => name)
      .toSorted(compareNames),
    [...devices].toSorted(compareNames),
    "Network inventories differ",
  );
  for (const family of ["4", "6"]) {
    assert.equal(single("routes" + family), "complete", "Incomplete route read");
    for (const [name] of entries("route" + family)) {
      assert.equal(name, "lo", "Non-loopback route");
    }
  }
  assert.equal(single("tcp"), "ENETUNREACH", "External TCP isolation was not verified");
  return { policy: COMPILER_NETWORK_POLICY, inactiveFallbackDevices: devices.size - 1 };
}

/** Bound both streams before retaining bytes in memory or writing host artifacts. */
export function captureCompilerComparisonOutput(files?: { stdout: number; stderr: number }) {
  const chunks: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
  let bytes = 0;
  return {
    accept(chunk: Buffer, stream: "stdout" | "stderr") {
      bytes += chunk.length;
      assert(bytes <= 64 * 1024 * 1024, "Compiler output exceeded 64 MiB");
      if (files) {
        fs.writeFileSync(files[stream], chunk);
      } else {
        chunks[stream].push(chunk);
      }
    },
    finish() {
      return {
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
      };
    },
  };
}

/** Read GNU time output without trusting the compiler-writable pathname. */
export function readCompilerComparisonMetrics(file: string) {
  // NOFOLLOW rejects symlinks; NONBLOCK lets the descriptor check reject FIFOs
  // without waiting for a writer after the compiler's timeout has ended.
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  let text: string;
  try {
    const stat = fs.fstatSync(fd);
    assert(stat.isFile(), "Metric input must be a regular file");
    assert(stat.size <= 4096, "Metric input exceeds 4096 bytes");
    text = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  const values = text.trim().split("\n").at(-1)?.trim().split(/\s+/u).map(Number);
  assert(
    values?.length === 5 && values.every((value) => Number.isFinite(value) && value >= 0),
    "Invalid compiler metrics",
  );
  return values as [number, number, number, number, number];
}
