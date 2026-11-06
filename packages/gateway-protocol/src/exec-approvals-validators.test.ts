import { describe, expect, it } from "vitest";
import {
  validateExecApprovalRequestParams,
  validateExecApprovalsNodeSnapshot,
  validateExecApprovalsNodeSetParams,
  validateExecApprovalsSetParams,
  validateExecApprovalsNativeRequest,
} from "./index.js";

const fileWithEntry = (entry: Record<string, unknown>) => ({
  version: 1,
  agents: { main: { allowlist: [{ pattern: "/usr/bin/python3", ...entry }] } },
});

describe("exec approvals protocol validators", () => {
  it("accepts native authorization and refuses host-floor bypass", () => {
    const request = {
      operation: "commit",
      agentId: "main",
      command: "echo native",
      uses: [],
      grants: [],
      authorization: {
        source: "current-policy",
        security: "full",
        ask: "off",
        allowlistSatisfied: false,
      },
    };
    expect(validateExecApprovalsNativeRequest(request)).toBe(true);
    expect(
      validateExecApprovalsNativeRequest({
        ...request,
        authorization: { ...request.authorization, bypassHostApprovalFloors: true },
      }),
    ).toBe(false);
  });
  it("accepts runtime-owned allowlist metadata on gateway and node set payloads", () => {
    const file = {
      version: 1 as const,
      agents: {
        main: {
          mcpTools: [
            { server: "project.docs", tool: "write_note", source: "allow-always", addedAt: 123 },
          ],
          allowlist: [
            {
              id: "entry-1",
              pattern: "cmd:allow-always:abcdef",
              source: "allow-always" as const,
              commandText: "python3 -c 'print(123)'",
              argPattern: "-c *",
              // The Mac App records Date.timeIntervalSince1970, which retains
              // sub-millisecond precision when converted to milliseconds.
              lastUsedAt: 1775154056736.5,
              lastUsedCommand: "python3 -c 'print(123)'",
              lastResolvedPath: "/usr/bin/python3",
            },
          ],
        },
      },
    };

    expect(validateExecApprovalsSetParams({ file, baseHash: "abc123" })).toBe(true);
    expect(
      validateExecApprovalsNodeSetParams({
        nodeId: "node-1",
        file,
        baseHash: "abc123",
      }),
    ).toBe(true);
  });

  it("accepts the shipped Windows node approval contract", () => {
    expect(
      validateExecApprovalsNodeSnapshot({
        enabled: true,
        hash: "sha256:current",
        baseHash: "sha256:current",
        defaultAction: "deny",
        constraints: {
          baseHashRequired: true,
          defaultAllowAllowed: false,
          broadAllowRulesAllowed: false,
          dangerousAllowRulesAllowed: false,
        },
        rules: [{ pattern: "hostname", action: "allow", enabled: true }],
      }),
    ).toBe(true);
    expect(
      validateExecApprovalsNodeSnapshot({ enabled: false, message: "No exec policy configured" }),
    ).toBe(true);
    expect(
      validateExecApprovalsNodeSetParams({
        nodeId: "windows-node",
        native: { defaultAction: "deny", rules: [] },
        baseHash: "sha256:current",
      }),
    ).toBe(true);
  });

  it("accepts file-backed node snapshots with host-resolved defaults", () => {
    expect(
      validateExecApprovalsNodeSnapshot({
        path: "/tmp/exec-approvals.json",
        exists: true,
        hash: "sha256:file",
        file: { version: 1 },
      }),
    ).toBe(true);
    expect(
      validateExecApprovalsNodeSnapshot({
        path: "/tmp/exec-approvals.json",
        exists: true,
        hash: "sha256:file",
        file: { version: 1 },
        resolvedDefaults: {
          security: "deny",
          ask: "on-miss",
          askFallback: "deny",
          autoAllowSkills: false,
        },
      }),
    ).toBe(true);
  });

  it("rejects ambiguous or unsafe host-native approval payloads", () => {
    const file = {
      path: "/tmp/exec-approvals.json",
      exists: true,
      hash: "sha256:file",
      file: { version: 1 },
    };
    const native = { enabled: true, hash: "sha256:current", defaultAction: "deny", rules: [] };
    const disabled = { enabled: false, message: "No exec policy configured" };
    const resolvedDefaults = {
      security: "deny",
      ask: "on-miss",
      askFallback: "deny",
      autoAllowSkills: false,
    };
    for (const snapshot of [
      {},
      { hash: "sha256:current" },
      { enabled: true, hash: "sha256:current", defaultAction: "deny" },
      { enabled: true, hash: "sha256:current", defaultAction: "full", rules: [] },
      { ...file, defaultAction: "deny" },
      { ...file, resolvedDefaults: { ...resolvedDefaults, security: "full", ask: "sometimes" } },
      { ...native, message: "mixed state" },
      { ...native, resolvedDefaults },
      { ...disabled, resolvedDefaults },
      { enabled: false, rules: [] },
    ]) {
      expect(validateExecApprovalsNodeSnapshot(snapshot)).toBe(false);
    }

    for (const params of [
      { native: {}, baseHash: "sha256:current" },
      { native: { defaultAction: "deny" }, baseHash: "sha256:current" },
      { native: { defaultAction: "full" }, baseHash: "sha256:current" },
      { native: { rules: [] } },
      { native: { rules: [{ pattern: "", action: "allow" }] }, baseHash: "sha256:current" },
    ]) {
      expect(validateExecApprovalsNodeSetParams({ nodeId: "windows-node", ...params })).toBe(false);
    }
  });

  it("rejects unknown allowlist metadata", () => {
    for (const entry of [{ source: "unknown-source" }, { randomMetadata: true }]) {
      expect(
        validateExecApprovalsSetParams({ file: fileWithEntry(entry), baseHash: "abc123" }),
      ).toBe(false);
    }
  });

  it("requires command spans to have non-negative starts and positive exclusive ends", () => {
    expect(
      validateExecApprovalRequestParams({
        command: "echo hi",
        commandSpans: [{ startIndex: 0, endIndex: 4 }],
      }),
    ).toBe(true);

    expect(
      validateExecApprovalRequestParams({
        command: "echo hi",
        commandSpans: [{ startIndex: 0, endIndex: 0 }],
      }),
    ).toBe(false);

    expect(
      validateExecApprovalRequestParams({
        command: "echo hi",
        commandSpans: [{ startIndex: -1, endIndex: 4 }],
      }),
    ).toBe(false);
  });

  it("accepts only optional unavailable approval decisions", () => {
    expect(
      validateExecApprovalRequestParams({
        command: "echo hi",
        unavailableDecisions: ["allow-always"],
      }),
    ).toBe(true);

    for (const unavailableDecisions of [
      [],
      ["allow-always", "allow-always"],
      ["allow-once"],
      ["deny"],
    ]) {
      expect(
        validateExecApprovalRequestParams({
          command: "echo hi",
          unavailableDecisions,
        }),
      ).toBe(false);
    }
  });
});
