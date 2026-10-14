// Coverage for bootstrap routing across canonical and effective workspaces.
import { describe, expect, it, vi } from "vitest";
import { isPrimaryBootstrapRun, resolveWorkspaceBootstrapRouting } from "./bootstrap-routing.js";

describe("isPrimaryBootstrapRun", () => {
  it("treats regular sessions as primary bootstrap runs", () => {
    expect(isPrimaryBootstrapRun("agent:main:main")).toBe(true);
  });
});

describe("resolveWorkspaceBootstrapRouting", () => {
  const workspace = "/tmp/openclaw-workspace";
  const bootstrapFile = {
    name: "BOOTSTRAP.md" as const,
    path: `${workspace}/BOOTSTRAP.md`,
    content: "Ask who I am before continuing.",
    missing: false,
  };
  const resolveRouting = (
    overrides: Partial<Parameters<typeof resolveWorkspaceBootstrapRouting>[0]>,
  ) =>
    resolveWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending: vi.fn(async () => false),
      trigger: "user",
      isPrimaryRun: true,
      isCanonicalWorkspace: true,
      effectiveWorkspace: workspace,
      resolvedWorkspace: workspace,
      hasBootstrapFileAccess: true,
      ...overrides,
    });

  it("falls back to limited bootstrap wording when a primary run cannot read files", async () => {
    const routing = await resolveRouting({
      isWorkspaceBootstrapPending: vi.fn(async () => true),
      hasBootstrapFileAccess: false,
    });

    expect(routing.bootstrapMode).toBe("limited");
    expect(routing.includeBootstrapInSystemContext).toBe(false);
    expect(routing.deliversCompleteWorkspaceContext).toBe(false);
  });

  it("records a completed workspace as delivering the whole bootstrap context", async () => {
    // A setup-complete workspace has no BOOTSTRAP.md to withhold, so its turns
    // carry every bootstrap file even though onboarding leaves the mode at "none".
    const routing = await resolveWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending: vi.fn(async () => false),
      trigger: "user",
      isPrimaryRun: true,
      isCanonicalWorkspace: true,
      effectiveWorkspace: "/tmp/openclaw-workspace",
      resolvedWorkspace: "/tmp/openclaw-workspace",
      hasBootstrapFileAccess: true,
    });

    expect(routing.bootstrapMode).toBe("none");
    expect(routing.deliversCompleteWorkspaceContext).toBe(true);
  });

  it("uses hook-provided BOOTSTRAP.md content even when normal file reads are unavailable", async () => {
    const routing = await resolveRouting({
      bootstrapFiles: [bootstrapFile],
      hasBootstrapFileAccess: false,
    });

    expect(routing.bootstrapMode).toBe("full");
    expect(routing.includeBootstrapInSystemContext).toBe(true);
  });

  it("does not treat empty hook-provided BOOTSTRAP.md as pending bootstrap context", async () => {
    const routing = await resolveRouting({
      bootstrapFiles: [{ ...bootstrapFile, content: "   " }],
    });

    expect(routing.bootstrapMode).toBe("none");
    expect(routing.includeBootstrapInSystemContext).toBe(false);
  });
});
