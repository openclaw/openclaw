import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getRuntimeConfigMock = vi.fn();
const mutateConfigFileMock = vi.fn();

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: () => getRuntimeConfigMock(),
}));
vi.mock("openclaw/plugin-sdk/config-mutation", () => ({
  mutateConfigFile: (input: unknown) => mutateConfigFileMock(input),
}));

const {
  evaluateFilePolicy,
  evaluateFileReadPolicySnapshot,
  snapshotNodeFileReadPolicy,
  persistLiteralGrant,
} = await import("./policy.js");

beforeEach(() => {
  getRuntimeConfigMock.mockReset();
  mutateConfigFileMock.mockReset();
});

afterEach(() => vi.restoreAllMocks());

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/runtime-config-snapshot");
  vi.doUnmock("openclaw/plugin-sdk/config-mutation");
  vi.resetModules();
});

function withConfig(nodes: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const config: Record<string, unknown> = { policyVersion: 2, nodes, ...extra };
  getRuntimeConfigMock.mockReturnValue({ plugins: { entries: { "file-transfer": { config } } } });
  return config;
}

function withMutableConfig(nodes: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const config = withConfig(nodes, extra);
  mutateConfigFileMock.mockImplementation(
    async ({ mutate }: { mutate: (draft: Record<string, unknown>) => void }) => {
      mutate({ plugins: { entries: { "file-transfer": { config } } } });
    },
  );
  return config;
}

function read(
  requestedPath: string,
  overrides: Partial<Parameters<typeof evaluateFilePolicy>[0]> = {},
) {
  return evaluateFilePolicy({ nodeId: "n1", kind: "read", path: requestedPath, ...overrides });
}

function grant(nodeId: string, requestedPath: string, canonicalPath = requestedPath) {
  return { nodeId, command: "file.fetch" as const, requestedPath, canonicalPath };
}

it("delegates only the selected node read policy and ignores the Node process policy", () => {
  const gatewayHome = os.homedir();
  withConfig({
    "node-1": {
      allowReadPaths: ["/workspace/**", "~/shared/**"],
      allowWritePaths: ["/other/**"],
      denyPaths: ["/workspace/private.txt"],
    },
    "node-2": { allowReadPaths: ["/unrelated/**"] },
  });
  const snapshot = snapshotNodeFileReadPolicy({ nodeId: "node-1" });
  expect(Object.keys(snapshot.pluginConfig.nodes)).toEqual(["node-1"]);
  expect(snapshot.pluginConfig.nodes["node-1"]).not.toHaveProperty("allowWritePaths");
  withConfig({ "node-1": { allowReadPaths: ["/**"] } });
  vi.spyOn(os, "homedir").mockReturnValue("/different-node-home");

  const allowed = (requestedPath: string) =>
    evaluateFileReadPolicySnapshot({ ...snapshot, path: requestedPath }).ok;
  expect(allowed("/workspace/SKILL.md")).toBe(true);
  expect(allowed("/workspace/private.txt")).toBe(false);
  expect(allowed("/unrelated/file.txt")).toBe(false);
  expect(allowed(path.join(gatewayHome, "shared/file.txt"))).toBe(true);
  expect(allowed("/different-node-home/shared/file.txt")).toBe(false);
});

describe("evaluateFilePolicy — default deny", () => {
  it("returns NO_POLICY when no entry exists for the node and no '*' fallback", () => {
    withConfig({ "other-node": { allowReadPaths: ["/tmp/**"] } });
    expect(read("/tmp/x")).toMatchObject({ ok: false, code: "NO_POLICY" });
  });

  it("prefers the current runtime config over a stale passed plugin config", () => {
    withConfig({ n1: { allowReadPaths: ["/tmp/**"] } });
    expect(
      read("/tmp/x", {
        pluginConfig: { nodes: { n1: { allowReadPaths: ["/stale/**"] } } },
      }),
    ).toMatchObject({ ok: true, reason: "matched-allow" });
  });

  it("fails closed with the one-command handoff for unreviewed legacy positive policy", () => {
    withConfig({ Shared: { allowReadPaths: ["/tmp/report-*.txt"] } }, { policyVersion: undefined });

    const result = read("/tmp/report-secret.txt", {
      nodeId: "node-a",
      nodeDisplayName: "Shared",
      command: "file.fetch",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "POLICY_MIGRATION_REQUIRED",
      askable: false,
    });
    expect(result.ok ? "" : result.reason).toContain("openclaw file-transfer approvals migrate");
  });
});

it("rejects /allowed/../etc/passwd even when /allowed/** is allowed", () => {
  withConfig({ n1: { allowReadPaths: ["/allowed/**"] } });
  const r = read("/allowed/../etc/passwd");
  expect(r).toMatchObject({ ok: false, code: "POLICY_DENIED", askable: false });
  expect(r.ok ? "" : r.reason).toMatch(/\.\./);
});
it("denies the bare directory matched by a descendant deny glob", () => {
  withConfig({
    n1: {
      allowReadPaths: ["/**"],
      denyPaths: ["**/.ssh/**"],
    },
  });
  expect(read(path.join(os.homedir(), ".ssh"))).toMatchObject({
    ok: false,
    code: "POLICY_DENIED",
    askable: false,
  });
});

it("denies even with ask=always (denyPaths is hard)", () => {
  withConfig({
    n1: {
      ask: "always",
      denyPaths: ["**/secrets/**"],
    },
  });
  const r = evaluateFilePolicy({
    nodeId: "n1",
    kind: "read",
    path: "/var/secrets/api.key",
  });
  expect(r).toMatchObject({ ok: false, code: "POLICY_DENIED", askable: false });
});
it("uses kind=write to consult allowWritePaths, not allowReadPaths", () => {
  withConfig({
    n1: { allowReadPaths: ["/tmp/**"], allowWritePaths: ["/srv/**"] },
  });
  expect(read("/srv/out.txt", { kind: "write" })).toMatchObject({ ok: true });
  expect(read("/tmp/out.txt", { kind: "write" })).toMatchObject({
    ok: false,
    code: "POLICY_DENIED",
  });
});

it("propagates followSymlinks=false by default and =true when configured", () => {
  withConfig({
    n1: { allowReadPaths: ["/tmp/**"] },
  });
  expect(evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" })).toMatchObject({
    ok: true,
    followSymlinks: false,
  });

  withConfig({
    n2: { allowReadPaths: ["/tmp/**"], followSymlinks: true },
  });
  expect(evaluateFilePolicy({ nodeId: "n2", kind: "read", path: "/tmp/x" })).toMatchObject({
    ok: true,
    followSymlinks: true,
  });
});
it("falls back to '*' wildcard when neither id nor displayName matches", () => {
  withConfig({ "*": { allowReadPaths: ["/tmp/**"] } });
  expect(read("/tmp/x", { nodeDisplayName: "anything" })).toMatchObject({ ok: true });
});
describe("literal standing grants", () => {
  it("makes only a migration-selected exact path askable under ask=off", () => {
    withConfig(
      { Shared: { ask: "off" } },
      { pendingReapprovals: [{ selector: "Shared", kind: "read", path: "/tmp/report-*.txt" }] },
    );

    const identity = {
      nodeId: "node-a",
      nodeDisplayName: "Shared",
      command: "file.fetch" as const,
    };
    expect(read("/tmp/report-*.txt", identity)).toMatchObject({
      ok: false,
      code: "POLICY_DENIED",
      askable: true,
    });
    expect(read("/tmp/unrelated.txt", identity)).toMatchObject({
      ok: false,
      code: "POLICY_DENIED",
      askable: false,
    });
  });

  it("keeps an approved Windows path literal", async () => {
    const approvedPath = "C:\\Temp\\report-*.txt";
    const siblingPath = "C:\\Temp\\report-a.txt";
    withMutableConfig({ n1: { ask: "on-miss" } });

    await persistLiteralGrant(grant("n1", approvedPath));
    expect(read(approvedPath, { command: "file.fetch" })).toMatchObject({
      ok: true,
      reason: "matched-literal",
      expectedCanonicalPath: approvedPath,
    });
    expect(read(siblingPath, { command: "file.fetch" })).toMatchObject({
      ok: false,
      code: "POLICY_DENIED",
      askable: true,
    });
  });

  it("does not replay a standing approval onto another node with the same display name", async () => {
    withMutableConfig({ Shared: { ask: "on-miss" } });

    await persistLiteralGrant(grant("node-a", "/tmp/report.txt"));
    const identity = { nodeDisplayName: "Shared", command: "file.fetch" as const };
    expect(read("/tmp/report.txt", { ...identity, nodeId: "node-a" })).toMatchObject({
      ok: true,
      reason: "matched-literal",
    });
    expect(read("/tmp/report.txt", { ...identity, nodeId: "node-b" })).toMatchObject({
      ok: false,
      code: "POLICY_DENIED",
      askable: true,
    });
  });

  it("dedupes the exact tuple without changing authored policy", async () => {
    const config = withMutableConfig({ Shared: { ask: "on-miss", denyPaths: ["**/.ssh/**"] } });
    const entry = grant("n1", "/tmp/x", "/private/tmp/x");
    await persistLiteralGrant(entry);
    await persistLiteralGrant(entry);
    expect(config.nodes).toEqual({
      Shared: { ask: "on-miss", denyPaths: ["**/.ssh/**"] },
    });
    expect(config.literalGrants).toEqual([entry]);
  });

  it("clears the matching pending reapproval after saving the exact grant", async () => {
    const config = withMutableConfig(
      { Shared: { ask: "off" } },
      {
        pendingReapprovals: [
          { selector: "Shared", kind: "read", path: "/tmp/report.txt" },
          { selector: "Shared", kind: "read", path: "/tmp/other.txt" },
        ],
      },
    );

    await persistLiteralGrant({
      ...grant("node-a", "/tmp/report.txt", "/private/tmp/report.txt"),
      pendingReapprovalSelector: "Shared",
    });
    expect(config.pendingReapprovals).toEqual([
      { selector: "Shared", kind: "read", path: "/tmp/other.txt" },
    ]);
  });
});
