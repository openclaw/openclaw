import { describe, expect, it } from "vitest";
import { validateSessionsPatchParams, validateSessionsPatchManyParams } from "../index.js";

describe("session patch schema", () => {
  it.each([[null, true]] as const)(
    "validates snoozedUntil %j for single and batch patches",
    (snoozedUntil, valid) => {
      expect(validateSessionsPatchParams({ key: "agent:main:chat", snoozedUntil })).toBe(valid);
      expect(
        validateSessionsPatchManyParams({
          targets: [{ key: "agent:main:chat" }],
          patch: { snoozedUntil },
        }),
      ).toBe(valid);
    },
  );

  it.each(["off"] as const)("accepts sandbox mode %s with single and batch CAS", (sandboxMode) => {
    expect(
      validateSessionsPatchParams({
        key: "agent:main:chat",
        sandboxMode,
        expectedSandboxMode: null,
      }),
    ).toBe(true);
    expect(
      validateSessionsPatchManyParams({
        targets: [{ key: "agent:main:chat", expectedSandboxMode: "off" }],
        patch: { sandboxMode },
      }),
    ).toBe(true);
  });

  it.each(["all"])("rejects unsupported sandbox mode %s", (sandboxMode) => {
    expect(validateSessionsPatchParams({ key: "agent:main:chat", sandboxMode })).toBe(false);
    expect(
      validateSessionsPatchParams({
        key: "agent:main:chat",
        sandboxMode: "off",
        expectedSandboxMode: sandboxMode,
      }),
    ).toBe(false);
  });
  it("validates session settings compare-and-set fields", () => {
    expect(
      validateSessionsPatchParams({
        key: "agent:main:settings-cas",
        expectedPermissionMode: "guarded",
        permissionMode: "workspace",
        expectedToolOverrides: { webSearch: false },
        toolOverrides: { skills: { release: false } },
      }),
    ).toBe(true);
    expect(
      validateSessionsPatchParams({
        key: "agent:main:settings-cas",
        expectedToolOverrides: { unknown: true },
        toolOverrides: null,
      }),
    ).toBe(false);
  });

  it("validates lifecycle and unread acknowledgement identities", () => {
    expect(
      validateSessionsPatchParams({
        key: "agent:main:self-archive",
        archived: true,
        expectedSessionId: "session-self-archive",
        expectedLifecycleRevision: "revision-self-archive",
      }),
    ).toBe(true);
    expect(
      validateSessionsPatchParams({
        key: "agent:main:mark-read",
        unread: false,
        expectedMarkedUnreadAt: 42,
      }),
    ).toBe(true);
    expect(
      validateSessionsPatchParams({ key: "agent:main:self-archive", expectedSessionId: "" }),
    ).toBe(false);
    expect(
      validateSessionsPatchParams({
        key: "agent:main:self-archive",
        expectedLifecycleRevision: "",
      }),
    ).toBe(false);
    expect(
      validateSessionsPatchParams({
        key: "agent:main:mark-read",
        unread: false,
        expectedMarkedUnreadAt: -1,
      }),
    ).toBe(false);
  });
});
