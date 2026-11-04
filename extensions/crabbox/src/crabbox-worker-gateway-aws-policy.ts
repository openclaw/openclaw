import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function cidrRange(value: string): [number, number] {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/u.exec(value);
  if (!match) {
    throw new WorkerProviderError("AWS guest boundary requires canonical IPv4 CIDRs");
  }
  const octets = match.slice(1, 5).map(Number);
  const bits = Number(match[5]);
  if (octets.some((n) => n > 255) || bits > 32) {
    throw new WorkerProviderError("Invalid AWS guest boundary CIDR");
  }
  const address = octets.reduce((n, octet) => n * 256 + octet, 0);
  const size = 2 ** (32 - bits);
  const start = Math.floor(address / size) * size;
  if (address !== start) {
    throw new WorkerProviderError("AWS guest boundary CIDR has host bits");
  }
  return [start, start + size - 1];
}
// SGs have only allow rules. Every allowed destination must exclude private,
// link-local, shared, loopback, multicast and reserved space, not just its endpoints.
const NON_PUBLIC = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
].map(cidrRange);
export function assertPublicAwsCidr(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new WorkerProviderError("Missing AWS guest boundary CIDR");
  }
  const [start, end] = cidrRange(value);
  if (NON_PUBLIC.some(([a, b]) => start <= b && a <= end)) {
    throw new WorkerProviderError("AWS guest security group permits non-public traffic");
  }
}
function array(value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new WorkerProviderError("Invalid AWS network collection");
  }
  return value;
}
export function assertGuestSecurityGroup(
  group: unknown,
  expected: { accountId: string; groupId: string; subnetVpcId: string },
): string {
  if (
    !isRecord(group) ||
    group.GroupId !== expected.groupId ||
    group.OwnerId !== expected.accountId ||
    group.VpcId !== expected.subnetVpcId
  ) {
    throw new WorkerProviderError("AWS guest security group identity changed");
  }
  const facts: string[] = [];
  for (const direction of ["IpPermissions", "IpPermissionsEgress"]) {
    if (!Array.isArray(group[direction])) {
      throw new WorkerProviderError("Missing AWS guest security group rules");
    }
    for (const rule of group[direction]) {
      if (!isRecord(rule) || typeof rule.IpProtocol !== "string") {
        throw new WorkerProviderError("Invalid AWS guest security group rule");
      }
      if (
        Object.keys(rule).some(
          (key) =>
            ![
              "IpProtocol",
              "FromPort",
              "ToPort",
              "IpRanges",
              "Ipv6Ranges",
              "UserIdGroupPairs",
              "PrefixListIds",
            ].includes(key),
        )
      ) {
        throw new WorkerProviderError("Unsupported AWS guest security group rule fields");
      }
      if (
        ["Ipv6Ranges", "UserIdGroupPairs", "PrefixListIds"].some(
          (key) => array(rule[key]).length !== 0,
        )
      ) {
        throw new WorkerProviderError(
          "AWS guest boundary cannot use IPv6, peer groups or unresolved prefix lists",
        );
      }
      const ranges = array(rule.IpRanges);
      if (!ranges.length) {
        throw new WorkerProviderError("AWS guest rule has no qualified destinations");
      }
      const cidrs = ranges.map((range) => {
        const cidr = requireAwsRecord(range, "CIDR").CidrIp;
        assertPublicAwsCidr(cidr);
        return cidr;
      });
      facts.push(
        JSON.stringify([
          direction,
          rule.IpProtocol,
          rule.FromPort ?? null,
          rule.ToPort ?? null,
          cidrs.toSorted((a, b) => a.localeCompare(b)),
        ]),
      );
    }
  }
  return JSON.stringify(facts.toSorted((a, b) => a.localeCompare(b)));
}
export function requireAwsRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new WorkerProviderError("AWS guest qualification returned invalid " + label);
  }
  return value;
}
export function onlyAwsRecord(value: unknown, label: string): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new WorkerProviderError("AWS guest qualification requires one " + label);
  }
  return requireAwsRecord(value[0], label);
}

/** The initial route is deliberately internet-only: RFC1918 VPC, local routes and one IGW. */
export function assertGuestVpcRoutes(
  vpc: Record<string, unknown>,
  tables: unknown,
  expected: { accountId: string; vpcId: string; subnetId: string },
): { gatewayId: string; facts: string } {
  if (
    vpc.VpcId !== expected.vpcId ||
    vpc.OwnerId !== expected.accountId ||
    vpc.State !== "available"
  ) {
    throw new WorkerProviderError("AWS guest VPC ownership is unqualified");
  }
  const privateRanges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].map(cidrRange);
  if (
    !Array.isArray(vpc.CidrBlockAssociationSet) ||
    !vpc.CidrBlockAssociationSet.length ||
    array(vpc.Ipv6CidrBlockAssociationSet).length
  ) {
    throw new WorkerProviderError("AWS guest VPC CIDR associations are unqualified");
  }
  const cidrs = vpc.CidrBlockAssociationSet.map((item) => {
    const association = requireAwsRecord(item, "VPC CIDR association");
    const state = requireAwsRecord(association.CidrBlockState, "VPC CIDR state");
    if (state.State !== "associated" || typeof association.CidrBlock !== "string") {
      throw new WorkerProviderError("AWS guest VPC CIDR association is changing");
    }
    const [start, end] = cidrRange(association.CidrBlock);
    if (!privateRanges.some(([a, b]) => start >= a && end <= b)) {
      throw new WorkerProviderError(
        "AWS guest VPC cannot use public address space for private routing",
      );
    }
    return association.CidrBlock;
  });
  const candidates = array(tables).map((item) => requireAwsRecord(item, "route table"));
  const associated = (table: Record<string, unknown>, main: boolean) =>
    array(table.Associations).some((item) => {
      const association = requireAwsRecord(item, "route association");
      return main ? association.Main === true : association.SubnetId === expected.subnetId;
    });
  const explicit = candidates.filter((table) => associated(table, false));
  const table = onlyAwsRecord(
    explicit.length ? explicit : candidates.filter((candidate) => associated(candidate, true)),
    "effective route table",
  );
  if (table.VpcId !== expected.vpcId || table.OwnerId !== expected.accountId) {
    throw new WorkerProviderError("AWS guest route table identity changed");
  }
  const gateways = new Set<string>();
  const routes: string[] = [];
  for (const item of array(table.Routes)) {
    const route = requireAwsRecord(item, "route");
    if (
      route.State !== "active" ||
      typeof route.DestinationCidrBlock !== "string" ||
      route.DestinationIpv6CidrBlock !== undefined ||
      route.DestinationPrefixListId !== undefined
    ) {
      throw new WorkerProviderError("AWS guest route is unavailable or unresolved");
    }
    if (
      Object.keys(route).some(
        (key) => !["DestinationCidrBlock", "GatewayId", "Origin", "State"].includes(key),
      )
    ) {
      throw new WorkerProviderError(
        "AWS guest routes cannot use peering, VPN, transit, NAT or appliance targets",
      );
    }
    if (route.GatewayId === "local") {
      if (!cidrs.includes(route.DestinationCidrBlock)) {
        throw new WorkerProviderError("AWS guest local route is not a qualified VPC CIDR");
      }
    } else if (
      typeof route.GatewayId === "string" &&
      /^igw-[a-f0-9]{8,17}$/u.test(route.GatewayId)
    ) {
      gateways.add(route.GatewayId);
    } else {
      throw new WorkerProviderError(
        "AWS guest routes must use only VPC-local or attached internet gateway targets",
      );
    }
    routes.push(JSON.stringify([route.DestinationCidrBlock, route.GatewayId]));
  }
  if (gateways.size !== 1) {
    throw new WorkerProviderError("AWS guest route requires one qualified internet gateway");
  }
  const gatewayId = [...gateways][0]!;
  return {
    gatewayId,
    facts: JSON.stringify([
      table.RouteTableId,
      cidrs.toSorted((a, b) => a.localeCompare(b)),
      routes.toSorted((a, b) => a.localeCompare(b)),
    ]),
  };
}
