import { describe, expect, it } from "vitest";
import {
  buildSandboxContainerName,
  resolveSandboxWorkspaceLayoutPaths,
  slugifySessionKey,
} from "./shared.js";

describe("buildSandboxContainerName", () => {
  it("preserves scope identity when a custom prefix exceeds the Docker name limit", () => {
    const commonPrefix = "custom-prefix-".repeat(6);
    const nameFor = (suffix: string, sessionKey: string) =>
      buildSandboxContainerName(`${commonPrefix}${suffix}`, slugifySessionKey(sessionKey));
    const first = nameFor("first", "session:first");
    const second = nameFor("second", "session:second");
    const sameScopeDifferentPrefix = nameFor("second", "session:first");
    const oversizedSlug = nameFor("", "session:".concat("x".repeat(200)));

    expect(first).not.toBe(second);
    expect(first).not.toBe(sameScopeDifferentPrefix);
    for (const name of [first, second, oversizedSlug]) {
      expect(name).toHaveLength(63);
      expect(name).toMatch(/-[0-9a-f]{12}$/);
    }
  });

  it("preserves workspace identity when a custom prefix exceeds the Docker name limit", () => {
    const slug = slugifySessionKey(`agent:main:workspace:${"a".repeat(32)}`);
    const first = buildSandboxContainerName("custom-prefix-one-that-is-far-too-long-", slug);
    const second = buildSandboxContainerName("custom-prefix-two-that-is-far-too-long-", slug);

    expect(slug).toMatch(/^workspace-[a-f0-9]{32}$/);
    expect(first).not.toBe(second);
    for (const name of [first, second]) {
      expect(name).toHaveLength(63);
      expect(name).toContain(slug);
      expect(name).toMatch(/-[a-f0-9]{12}$/);
    }
  });
});

describe("resolveSandboxWorkspaceLayoutPaths", () => {
  const sessionKey = "agent:poly:msteams:channel-1";
  const workspaceA = "/tmp/openclaw-customers/atica/agents/poly/workspace";
  const workspaceB = "/tmp/openclaw-customers/polytopic/agents/poly/workspace";
  const createLayout = (
    scope: "session" | "agent" | "shared",
    workspaceDir: string,
    context: { rawSessionKey?: string; agentId?: string } = {},
  ) =>
    resolveSandboxWorkspaceLayoutPaths({
      cfg: {
        scope,
        workspaceAccess: "rw",
        workspaceRoot: "/tmp/openclaw-sandboxes",
      },
      rawSessionKey: sessionKey,
      workspaceDir,
      ...context,
    });

  it.each(["session", "agent"] as const)("qualifies %s scope by resolved workspace", (scope) => {
    const first = createLayout(scope, workspaceA).scopeKey;
    const second = createLayout(scope, workspaceB).scopeKey;

    expect(first).toMatch(/:workspace:[a-f0-9]{32}$/);
    expect(second).toMatch(/:workspace:[a-f0-9]{32}$/);
    expect(first).not.toBe(second);
  });

  it("keeps shared scope independent of workspace", () => {
    expect(createLayout("shared", workspaceA).scopeKey).toBe("shared");
    expect(createLayout("shared", workspaceB).scopeKey).toBe("shared");
  });

  it("uses the prepared agent owner for a bare agent-scoped session key", () => {
    const layout = createLayout("agent", workspaceA, {
      rawSessionKey: "global",
      agentId: "research",
    });

    expect(layout.scopeKey).toMatch(/^agent:research:workspace:[a-f0-9]{32}$/);
  });

  it.each(["agent", "session", "shared"] as const)(
    "isolates different required-sandbox principals with %s scope",
    (scope) => {
      const layoutForPrincipal = (sandboxPrincipalId: string) =>
        resolveSandboxWorkspaceLayoutPaths({
          cfg: { scope, workspaceAccess: "ro", workspaceRoot: "/tmp/openclaw-sandboxes" },
          rawSessionKey: `agent:shared:${sandboxPrincipalId}`,
          agentId: "shared",
          isolationSubject: { kind: "profile", profileId: sandboxPrincipalId },
          workspaceDir: workspaceA,
        });
      const containerNameFor = (scopeKey: string) =>
        buildSandboxContainerName("openclaw-sbx-", slugifySessionKey(scopeKey));

      const guestA = layoutForPrincipal("guest-a");
      const guestB = layoutForPrincipal("guest-b");

      expect(guestA.scopeKey).not.toBe(guestB.scopeKey);
      expect(containerNameFor(guestA.scopeKey)).not.toBe(containerNameFor(guestB.scopeKey));
      expect(guestA.workspaceDir).not.toBe(guestB.workspaceDir);
      expect(guestA.workspaceDir).not.toBe(guestA.agentWorkspaceDir);
      expect(guestB.workspaceDir).not.toBe(guestB.agentWorkspaceDir);
    },
  );

  it("preserves the shared writable agent workspace without a required-sandbox principal", () => {
    const layoutForSession = (rawSessionKey: string) =>
      createLayout("agent", workspaceA, { rawSessionKey, agentId: "shared" });

    const firstSession = layoutForSession("agent:shared:first-session");
    const secondSession = layoutForSession("agent:shared:second-session");

    expect(firstSession.scopeKey).toBe(secondSession.scopeKey);
    expect(firstSession.workspaceDir).toBe(workspaceA);
    expect(secondSession.workspaceDir).toBe(workspaceA);
    expect(firstSession.workspaceSource).toBe("agent");
  });
});
