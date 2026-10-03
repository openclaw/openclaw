import { expect, it } from "vitest";
import { validateSessionsPatchParams, validateSessionsPatchManyParams } from "../index.js";

it("validates sandbox mutations and compare-and-set modes", () => {
  for (const sandboxMode of ["off", null]) {
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
  }
  for (const sandboxMode of ["all", "required", true]) {
    expect(validateSessionsPatchParams({ key: "agent:main:chat", sandboxMode })).toBe(false);
    expect(
      validateSessionsPatchParams({
        key: "agent:main:chat",
        sandboxMode: "off",
        expectedSandboxMode: sandboxMode,
      }),
    ).toBe(false);
  }
});

it("validates session settings and lifecycle preconditions", () => {
  for (const [fields, valid] of [
    [
      {
        expectedPermissionMode: "guarded",
        permissionMode: "workspace",
        expectedToolOverrides: { webSearch: false },
        toolOverrides: { skills: { release: false } },
      },
      true,
    ],
    [{ expectedToolOverrides: { unknown: true }, toolOverrides: null }, false],
    [
      {
        archived: true,
        expectedSessionId: "session-self-archive",
        expectedLifecycleRevision: "revision-self-archive",
      },
      true,
    ],
    [{ unread: false, expectedMarkedUnreadAt: 42 }, true],
    [{ expectedSessionId: "" }, false],
    [{ expectedLifecycleRevision: "" }, false],
    [{ unread: false, expectedMarkedUnreadAt: -1 }, false],
  ] as const) {
    expect(validateSessionsPatchParams({ key: "agent:main:chat", ...fields })).toBe(valid);
  }
});
