// Coverage for bootstrap routing across canonical and effective workspaces.
import { describe, expect, it, vi } from "vitest";
import { isPrimaryBootstrapRun, resolveWorkspaceBootstrapRouting } from "./bootstrap-routing.js";

describe("isPrimaryBootstrapRun", () => {
  it("treats regular sessions as primary bootstrap runs", () => {
    expect(isPrimaryBootstrapRun("agent:main:main")).toBe(true);
  });

  it("suppresses bootstrap ownership for subagent and ACP/helper sessions", () => {
    // Only the primary session owns bootstrap context; helper sessions inherit
    // context through their parent flow.
    expect(isPrimaryBootstrapRun("agent:main:subagent:worker")).toBe(false);
    expect(isPrimaryBootstrapRun("agent:main:acp:worker")).toBe(false);
  });
});

describe("resolveWorkspaceBootstrapRouting", () => {
  it("resolves bootstrap pending from the canonical workspace instead of a copied sandbox", async () => {
    // Sandbox copies are execution roots; bootstrap state belongs to the
    // canonical workspace.
    const sandboxWorkspace = "/tmp/openclaw-sandbox-copy";
    const canonicalWorkspace = "/tmp/openclaw-canonical-workspace";
    const isWorkspaceBootstrapPending = vi.fn(async (workspaceDir: string) => {
      return workspaceDir === sandboxWorkspace;
    });

    const routing = await resolveWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending,
      trigger: "user",
      isPrimaryRun: true,
      isCanonicalWorkspace: true,
      effectiveWorkspace: sandboxWorkspace,
      resolvedWorkspace: canonicalWorkspace,
      hasBootstrapFileAccess: true,
    });

    expect(isWorkspaceBootstrapPending).toHaveBeenCalledOnce();
    expect(isWorkspaceBootstrapPending).toHaveBeenCalledWith(canonicalWorkspace);
    expect(isWorkspaceBootstrapPending).not.toHaveBeenCalledWith(sandboxWorkspace);
    expect(routing.bootstrapMode).toBe("none");
    expect(routing.includeBootstrapInSystemContext).toBe(false);
    expect(routing.includeBootstrapInRuntimeContext).toBe(false);
  });

  it("falls back to limited bootstrap wording when a primary run cannot read files", async () => {
    const routing = await resolveWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending: vi.fn(async () => true),
      trigger: "user",
      isPrimaryRun: true,
      isCanonicalWorkspace: true,
      effectiveWorkspace: "/tmp/openclaw-workspace",
      resolvedWorkspace: "/tmp/openclaw-workspace",
      hasBootstrapFileAccess: false,
    });

    expect(routing.bootstrapMode).toBe("limited");
    expect(routing.includeBootstrapInSystemContext).toBe(false);
    expect(routing.includeBootstrapInRuntimeContext).toBe(false);
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

  it("withholds the completed-workspace claim when a bootstrap file failed its guarded read", async () => {
    // A read failure injects an "[UNREADABLE: ...]" diagnostic in place of the file, so the turn
    // delivered a fault report rather than the instructions the completion marker stands for.
    const routing = await resolveWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending: vi.fn(async () => false),
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: "/tmp/openclaw-workspace/AGENTS.md",
          content: "[UNREADABLE: Unknown system error -11: read]",
          missing: false,
        },
      ],
      trigger: "user",
      isPrimaryRun: true,
      isCanonicalWorkspace: true,
      effectiveWorkspace: "/tmp/openclaw-workspace",
      resolvedWorkspace: "/tmp/openclaw-workspace",
      hasBootstrapFileAccess: true,
    });

    expect(routing.bootstrapMode).toBe("none");
    expect(routing.deliversCompleteWorkspaceContext).toBe(false);
  });

  it("keeps the completed-workspace claim for readable content and absent optional files", async () => {
    const routing = await resolveWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending: vi.fn(async () => false),
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: "/tmp/openclaw-workspace/AGENTS.md",
          content: "# Workspace rules",
          missing: false,
        },
        { name: "SOUL.md", path: "/tmp/openclaw-workspace/SOUL.md", missing: true },
      ],
      trigger: "user",
      isPrimaryRun: true,
      isCanonicalWorkspace: true,
      effectiveWorkspace: "/tmp/openclaw-workspace",
      resolvedWorkspace: "/tmp/openclaw-workspace",
      hasBootstrapFileAccess: true,
    });

    expect(routing.deliversCompleteWorkspaceContext).toBe(true);
  });

  it("treats hook-provided BOOTSTRAP.md content as pending bootstrap context", async () => {
    // Hook-provided bootstrap files can replace filesystem reads and still drive
    // a full bootstrap turn.
    const routing = await resolveWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending: vi.fn(async () => false),
      bootstrapFiles: [
        {
          name: "BOOTSTRAP.md",
          path: "/tmp/openclaw-workspace/BOOTSTRAP.md",
          content: "Ask who I am before continuing.",
          missing: false,
        },
      ],
      trigger: "user",
      isPrimaryRun: true,
      isCanonicalWorkspace: true,
      effectiveWorkspace: "/tmp/openclaw-workspace",
      resolvedWorkspace: "/tmp/openclaw-workspace",
      hasBootstrapFileAccess: true,
    });

    expect(routing.bootstrapMode).toBe("full");
    expect(routing.includeBootstrapInSystemContext).toBe(true);
    expect(routing.includeBootstrapInRuntimeContext).toBe(false);
  });

  it("uses hook-provided BOOTSTRAP.md content even when normal file reads are unavailable", async () => {
    const routing = await resolveWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending: vi.fn(async () => false),
      bootstrapFiles: [
        {
          name: "BOOTSTRAP.md",
          path: "/tmp/openclaw-workspace/BOOTSTRAP.md",
          content: "Ask who I am before continuing.",
          missing: false,
        },
      ],
      trigger: "user",
      isPrimaryRun: true,
      isCanonicalWorkspace: true,
      effectiveWorkspace: "/tmp/openclaw-workspace",
      resolvedWorkspace: "/tmp/openclaw-workspace",
      hasBootstrapFileAccess: false,
    });

    expect(routing.bootstrapMode).toBe("full");
    expect(routing.includeBootstrapInSystemContext).toBe(true);
    expect(routing.includeBootstrapInRuntimeContext).toBe(false);
  });

  it("does not infer file access from loaded bootstrap content when the caller opts out", async () => {
    const routing = await resolveWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending: vi.fn(async () => false),
      bootstrapFiles: [
        {
          name: "BOOTSTRAP.md",
          path: "/tmp/openclaw-workspace/BOOTSTRAP.md",
          content: "Ask who I am before continuing.",
          missing: false,
        },
      ],
      bootstrapFilesProvideAccess: false,
      trigger: "user",
      isPrimaryRun: true,
      isCanonicalWorkspace: true,
      effectiveWorkspace: "/tmp/openclaw-workspace",
      resolvedWorkspace: "/tmp/openclaw-workspace",
      hasBootstrapFileAccess: false,
    });

    expect(routing.bootstrapMode).toBe("limited");
    expect(routing.includeBootstrapInSystemContext).toBe(false);
    expect(routing.includeBootstrapInRuntimeContext).toBe(false);
  });

  it("does not treat empty hook-provided BOOTSTRAP.md as pending bootstrap context", async () => {
    const routing = await resolveWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending: vi.fn(async () => false),
      bootstrapFiles: [
        {
          name: "BOOTSTRAP.md",
          path: "/tmp/openclaw-workspace/BOOTSTRAP.md",
          content: "   ",
          missing: false,
        },
      ],
      trigger: "user",
      isPrimaryRun: true,
      isCanonicalWorkspace: true,
      effectiveWorkspace: "/tmp/openclaw-workspace",
      resolvedWorkspace: "/tmp/openclaw-workspace",
      hasBootstrapFileAccess: true,
    });

    expect(routing.bootstrapMode).toBe("none");
    expect(routing.includeBootstrapInSystemContext).toBe(false);
    expect(routing.includeBootstrapInRuntimeContext).toBe(false);
  });
});
