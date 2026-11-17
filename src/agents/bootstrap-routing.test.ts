// Coverage for bootstrap routing across canonical and effective workspaces.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPrimaryBootstrapRun, resolveWorkspaceBootstrapRouting } from "./bootstrap-routing.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
      isWorkspaceSetupCompleted: vi.fn(async () => false),
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
    const routing = await resolveRouting({
      isWorkspaceSetupCompleted: vi.fn(async () => true),
      bootstrapContextRunKind: "cron",
    });

    expect(routing.bootstrapMode).toBe("none");
    expect(routing.deliversCompleteWorkspaceContext).toBe(true);
    expect(routing.bootstrapCompleted).toBe(true);
  });

  it("does not report completion for a pending workspace whose run skips bootstrap", async () => {
    const routing = await resolveRouting({
      bootstrapFiles: [bootstrapFile],
      isWorkspaceSetupCompleted: vi.fn(async () => true),
      bootstrapContextRunKind: "cron",
    });

    expect(routing.bootstrapMode).toBe("none");
    expect(routing.bootstrapCompleted).toBe(false);
  });

  it("uses hook-provided BOOTSTRAP.md content even when normal file reads are unavailable", async () => {
    const routing = await resolveRouting({
      bootstrapFiles: [bootstrapFile],
      hasBootstrapFileAccess: false,
    });

    expect(routing.bootstrapMode).toBe("full");
    expect(routing.includeBootstrapInSystemContext).toBe(true);
  });

  it("keeps full bootstrap for a physical workspace alias without following a retargeted alias", async () => {
    const root = await fs.realpath(tempDirs.make("bootstrap-routing-alias-"));
    const pinned = path.join(root, "pinned");
    const other = path.join(root, "other");
    const alias = path.join(root, "configured");
    await fs.mkdir(pinned);
    await fs.mkdir(other);
    await fs.symlink(pinned, alias, "junction");
    const options = {
      bootstrapFiles: [{ ...bootstrapFile, path: path.join(pinned, "BOOTSTRAP.md") }],
      effectiveWorkspace: alias,
      resolvedWorkspace: pinned,
    };

    expect(await resolveRouting(options)).toMatchObject({
      bootstrapMode: "full",
      includeBootstrapInSystemContext: true,
    });

    await fs.unlink(alias);
    await fs.symlink(other, alias, "junction");
    expect(await resolveRouting(options)).toMatchObject({
      bootstrapMode: "limited",
      includeBootstrapInSystemContext: false,
    });
  });

  it("does not treat empty hook-provided BOOTSTRAP.md as pending bootstrap context", async () => {
    const routing = await resolveRouting({
      bootstrapFiles: [{ ...bootstrapFile, content: "   " }],
    });

    expect(routing.bootstrapMode).toBe("none");
    expect(routing.includeBootstrapInSystemContext).toBe(false);
  });
});
