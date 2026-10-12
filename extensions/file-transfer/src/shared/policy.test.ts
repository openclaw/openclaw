import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getRuntimeConfigMock = vi.fn();
const mutateConfigFileMock = vi.fn();

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: () => getRuntimeConfigMock(),
}));
vi.mock("openclaw/plugin-sdk/config-mutation", () => ({
  mutateConfigFile: (input: unknown) => mutateConfigFileMock(input),
}));

// Imported AFTER vi.mock so the mocked module is what policy.ts binds to.
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

afterEach(() => {
  vi.restoreAllMocks();
});

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

function expectResultFields(result: unknown, fields: Record<string, unknown>) {
  expect(result).toMatchObject(fields);
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

  expect(evaluateFileReadPolicySnapshot({ ...snapshot, path: "/workspace/SKILL.md" }).ok).toBe(
    true,
  );
  expect(evaluateFileReadPolicySnapshot({ ...snapshot, path: "/workspace/private.txt" }).ok).toBe(
    false,
  );
  expect(evaluateFileReadPolicySnapshot({ ...snapshot, path: "/unrelated/file.txt" }).ok).toBe(
    false,
  );
  expect(
    evaluateFileReadPolicySnapshot({ ...snapshot, path: path.join(gatewayHome, "shared/file.txt") })
      .ok,
  ).toBe(true);
  expect(
    evaluateFileReadPolicySnapshot({ ...snapshot, path: "/different-node-home/shared/file.txt" })
      .ok,
  ).toBe(false);
});

describe("evaluateFilePolicy — default deny", () => {
  it("returns NO_POLICY when plugin policy block is missing", () => {
    getRuntimeConfigMock.mockReturnValue({ plugins: { entries: { "file-transfer": {} } } });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expectResultFields(r, { ok: false, code: "NO_POLICY" });
  });

  it("returns NO_POLICY when no entry exists for the node and no '*' fallback", () => {
    withConfig({ "other-node": { allowReadPaths: ["/tmp/**"] } });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expectResultFields(r, { ok: false, code: "NO_POLICY" });
  });

  it("prefers the current runtime config over a stale passed plugin config", () => {
    withConfig({
      n1: { allowReadPaths: ["/tmp/**"] },
    });
    const r = evaluateFilePolicy({
      nodeId: "n1",
      kind: "read",
      path: "/tmp/x",
      pluginConfig: {
        nodes: {
          n1: { allowReadPaths: ["/stale/**"] },
        },
      },
    });
    expectResultFields(r, { ok: true, reason: "matched-allow" });
  });

  it("fails closed with the one-command handoff for unreviewed legacy positive policy", () => {
    withConfig({ Shared: { allowReadPaths: ["/tmp/report-*.txt"] } }, { policyVersion: undefined });

    const result = evaluateFilePolicy({
      nodeId: "node-a",
      nodeDisplayName: "Shared",
      kind: "read",
      command: "file.fetch",
      path: "/tmp/report-secret.txt",
    });

    expectResultFields(result, {
      ok: false,
      code: "POLICY_MIGRATION_REQUIRED",
      askable: false,
    });
    expect(result.ok ? "" : result.reason).toContain("openclaw file-transfer approvals migrate");
  });
});

describe("evaluateFilePolicy — '..' traversal short-circuit", () => {
  it("rejects /allowed/../etc/passwd even when /allowed/** is allowed", () => {
    withConfig({
      n1: { allowReadPaths: ["/allowed/**"] },
    });
    const r = evaluateFilePolicy({
      nodeId: "n1",
      kind: "read",
      path: "/allowed/../etc/passwd",
    });
    expectResultFields(r, { ok: false, code: "POLICY_DENIED", askable: false });
    expect(r.ok ? "" : r.reason).toMatch(/\.\./);
  });
});

describe("evaluateFilePolicy — denyPaths always wins", () => {
  it.each([
    {
      label: "the bare denied directory",
      requestedPath: path.join(os.homedir(), ".ssh"),
      expected: { ok: false, code: "POLICY_DENIED", askable: false },
    },
  ])("handles $label", ({ requestedPath, expected }) => {
    withConfig({
      n1: {
        allowReadPaths: ["/**"],
        denyPaths: ["**/.ssh/**"],
      },
    });
    expectResultFields(
      evaluateFilePolicy({ nodeId: "n1", kind: "read", path: requestedPath }),
      expected,
    );
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
    expectResultFields(r, { ok: false, code: "POLICY_DENIED", askable: false });
  });
});

describe("evaluateFilePolicy — allow matching", () => {
  it("uses kind=write to consult allowWritePaths, not allowReadPaths", () => {
    withConfig({
      n1: { allowReadPaths: ["/tmp/**"], allowWritePaths: ["/srv/**"] },
    });
    expectResultFields(evaluateFilePolicy({ nodeId: "n1", kind: "write", path: "/srv/out.txt" }), {
      ok: true,
    });
    expectResultFields(evaluateFilePolicy({ nodeId: "n1", kind: "write", path: "/tmp/out.txt" }), {
      ok: false,
      code: "POLICY_DENIED",
    });
  });

  it("propagates followSymlinks=false by default and =true when configured", () => {
    withConfig({
      n1: { allowReadPaths: ["/tmp/**"] },
    });
    expectResultFields(evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" }), {
      ok: true,
      followSymlinks: false,
    });

    withConfig({
      n2: { allowReadPaths: ["/tmp/**"], followSymlinks: true },
    });
    expectResultFields(evaluateFilePolicy({ nodeId: "n2", kind: "read", path: "/tmp/x" }), {
      ok: true,
      followSymlinks: true,
    });
  });
});

describe("evaluateFilePolicy — ask modes", () => {
  it("ask=on-miss miss preserves transfer caps for one-time approvals", () => {
    withConfig({
      n1: {
        ask: "on-miss",
        allowReadPaths: ["/var/log/**"],
        maxBytes: 4096,
        followSymlinks: true,
      },
    });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expectResultFields(r, {
      ok: false,
      code: "POLICY_DENIED",
      askable: true,
      askMode: "on-miss",
      maxBytes: 4096,
      followSymlinks: true,
    });
  });

  it("ask=always always returns ask-always (prompt on every call)", () => {
    withConfig({
      n1: { ask: "always", allowReadPaths: ["/tmp/**"] },
    });
    const r = evaluateFilePolicy({ nodeId: "n1", kind: "read", path: "/tmp/x" });
    expectResultFields(r, { ok: true, reason: "ask-always", askMode: "always" });
  });
});

describe("evaluateFilePolicy — node-id resolution", () => {
  it("falls back to '*' wildcard when neither id nor displayName matches", () => {
    withConfig({
      "*": { allowReadPaths: ["/tmp/**"] },
    });
    expectResultFields(
      evaluateFilePolicy({
        nodeId: "n1",
        nodeDisplayName: "anything",
        kind: "read",
        path: "/tmp/x",
      }),
      { ok: true },
    );
  });
});

describe("literal standing grants", () => {
  it("makes only a migration-selected exact path askable under ask=off", () => {
    withConfig(
      { Shared: { ask: "off" } },
      { pendingReapprovals: [{ selector: "Shared", kind: "read", path: "/tmp/report-*.txt" }] },
    );

    expectResultFields(
      evaluateFilePolicy({
        nodeId: "node-a",
        nodeDisplayName: "Shared",
        command: "file.fetch",
        kind: "read",
        path: "/tmp/report-*.txt",
      }),
      { ok: false, code: "POLICY_DENIED", askable: true },
    );
    expectResultFields(
      evaluateFilePolicy({
        nodeId: "node-a",
        nodeDisplayName: "Shared",
        command: "file.fetch",
        kind: "read",
        path: "/tmp/unrelated.txt",
      }),
      { ok: false, code: "POLICY_DENIED", askable: false },
    );
  });

  it.each([["Windows separators", "C:\\Temp\\report-*.txt", "C:\\Temp\\report-a.txt"]])(
    "keeps an approved path containing %s literal",
    async (_label, approvedPath, siblingPath) => {
      withMutableConfig({ n1: { ask: "on-miss" } });

      await persistLiteralGrant({
        nodeId: "n1",
        command: "file.fetch",
        requestedPath: approvedPath,
        canonicalPath: approvedPath,
      });

      expectResultFields(
        evaluateFilePolicy({
          nodeId: "n1",
          command: "file.fetch",
          kind: "read",
          path: approvedPath,
        }),
        { ok: true, reason: "matched-literal", expectedCanonicalPath: approvedPath },
      );
      expectResultFields(
        evaluateFilePolicy({
          nodeId: "n1",
          command: "file.fetch",
          kind: "read",
          path: siblingPath,
        }),
        { ok: false, code: "POLICY_DENIED", askable: true },
      );
    },
  );

  it("does not replay a standing approval onto another node with the same display name", async () => {
    withMutableConfig({ Shared: { ask: "on-miss" } });

    await persistLiteralGrant({
      nodeId: "node-a",
      command: "file.fetch",
      requestedPath: "/tmp/report.txt",
      canonicalPath: "/tmp/report.txt",
    });

    expectResultFields(
      evaluateFilePolicy({
        nodeId: "node-a",
        nodeDisplayName: "Shared",
        command: "file.fetch",
        kind: "read",
        path: "/tmp/report.txt",
      }),
      { ok: true, reason: "matched-literal" },
    );
    expectResultFields(
      evaluateFilePolicy({
        nodeId: "node-b",
        nodeDisplayName: "Shared",
        command: "file.fetch",
        kind: "read",
        path: "/tmp/report.txt",
      }),
      { ok: false, code: "POLICY_DENIED", askable: true },
    );
  });

  it("dedupes the exact tuple without changing authored policy", async () => {
    const config = withMutableConfig({ Shared: { ask: "on-miss", denyPaths: ["**/.ssh/**"] } });
    const grant = {
      nodeId: "n1",
      command: "file.fetch" as const,
      requestedPath: "/tmp/x",
      canonicalPath: "/private/tmp/x",
    };
    await persistLiteralGrant(grant);
    await persistLiteralGrant(grant);
    expect(config.nodes).toEqual({
      Shared: { ask: "on-miss", denyPaths: ["**/.ssh/**"] },
    });
    expect(config.literalGrants).toEqual([grant]);
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
      nodeId: "node-a",
      command: "file.fetch",
      requestedPath: "/tmp/report.txt",
      canonicalPath: "/private/tmp/report.txt",
      pendingReapprovalSelector: "Shared",
    });
    expect(config.pendingReapprovals).toEqual([
      { selector: "Shared", kind: "read", path: "/tmp/other.txt" },
    ]);
  });
});
