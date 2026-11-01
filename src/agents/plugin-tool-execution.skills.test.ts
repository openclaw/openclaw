import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import type { OpenClawPluginDefinition } from "../plugins/plugin-definition.types.js";
import type { OpenClawPluginToolFactory } from "../plugins/tool-types.js";
import { buildSkillSnapshot } from "../skills/loading/workspace-skill-prompt.js";
import { readWorkspaceSkillSources } from "../skills/loading/workspace-skill-source-reader.js";
import { syncWorkspaceSkills } from "../skills/loading/workspace-skill-sync.runtime.js";
import { closeSkillsWatchers, refreshSkillsDiscovery } from "../skills/runtime/refresh.js";
import { writeSkill } from "../skills/test-support/e2e-test-helpers.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
} from "../skills/test-support/home-env.test-support.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { resolveSandboxSkillRuntimeInputs } from "./embedded-agent-runner/sandbox-skills.js";
import { preparePluginToolExecutionCapabilities } from "./plugin-tool-execution.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { registerAgentWorkspaceAccess } from "./workspace-access.js";

const tempDirs = createTempDirTracker();
let factory: OpenClawPluginToolFactory<2> | undefined;
beforeAll(async () => {
  const { default: autoreview } = await loadBundledPluginFacade<{
    default: OpenClawPluginDefinition;
  }>({ pluginId: "autoreview", artifactBasename: "index.js" });
  autoreview.register!(
    createTestPluginApi({
      registerTool(tool) {
        if (typeof tool === "object" && "contextVersion" in tool) {
          factory = tool;
        }
      },
    }),
  );
});
afterEach(async () => {
  await closeSkillsWatchers(true);
  tempDirs.cleanup();
});

it.each(
  [
    { location: "workspace", access: "rw", admitted: false },
    { location: "workspace", access: "ro-instructions", admitted: false },
    { location: "host", access: "unmounted", admitted: true },
    { location: "host", access: "ro", admitted: true },
    { location: "host", access: "rw", admitted: false },
    { location: "host", access: "scripts-rw", admitted: false },
  ].flatMap(({ location, access, admitted }) =>
    ["managed", "personal"].map((source) => ({ location, access, admitted, source })),
  ),
)(
  "binds a $source installer symlink at $location with $access access: $admitted",
  async ({ location, access, admitted, source }) => {
    const home = tempDirs.make("autoreview-managed-");
    const environment = setMockSkillsHomeEnv(home);
    const workspace = path.join(home, "workspace");
    const sandboxDir = path.join(home, "sandbox");
    const installation =
      source === "personal"
        ? path.join(home, ".agents", "skills", "autoreview")
        : path.join(home, "managed", "autoreview");
    const original = path.join(location === "workspace" ? workspace : home, "review-helper");
    const options = {
      config: { plugins: { enabled: false }, skills: { load: { watch: false } } },
      managedSkillsDir: path.join(home, "managed"),
      bundledSkillsDir: path.join(home, "bundled"),
    };
    const sandbox = createAgentToolsSandboxContext({
      workspaceDir: workspace,
      skillsWorkspaceDir: sandboxDir,
      containerWorkdir: "/guest/repo",
    });
    sandbox.backend = {
      id: "fixture",
      runtimeId: "managed-skill",
      runtimeLabel: "Managed skill",
      capabilities: { readOnlyResourceMounts: true },
      workdir: "/guest/repo",
      buildExecSpec: vi.fn(),
      runShellCommand: vi.fn(),
    };
    const release = registerAgentWorkspaceAccess(workspace, {
      bridge: {
        readFile: vi.fn(),
        readFileWithSource: vi.fn(),
        readDirectory: vi.fn(),
        writeFile: vi.fn(),
        createFileExclusive: vi.fn(),
        stat: vi.fn(),
      },
      loadSkills: async (request) => readWorkspaceSkillSources(request),
    });
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "caller",
      scopes: [],
      assertCurrent() {},
    });
    const bind = async () => {
      const snapshot = await buildSkillSnapshot(workspace, options);
      sandbox.skillUsagePaths = await syncWorkspaceSkills({
        ...options,
        sourceWorkspaceDir: workspace,
        targetWorkspaceDir: sandboxDir,
        skillsSnapshot: snapshot,
      });
      const prepared = resolveSandboxSkillRuntimeInputs({
        sandbox,
        skillsAnchorWorkspace: workspace,
        skillsSnapshot: snapshot,
      });
      const capabilities = preparePluginToolExecutionCapabilities({
        sandbox,
        skillsSnapshot: prepared.skillsSnapshot,
        authority,
      })(() => {});
      return {
        capabilities,
        tool: factory!.create({
          ...capabilities,
          assertInvocationCurrent() {},
        }),
      };
    };
    try {
      const helperPath = path.join("scripts", "autoreview");
      const helperText = "# protected helper fixture\n";
      await writeSkill({ dir: original, name: "autoreview", description: "Installed reviewer" });
      await fs.mkdir(path.dirname(installation), { recursive: true });
      await fs.symlink(original, installation, "dir");
      await fs.mkdir(path.join(installation, "scripts"));
      await fs.writeFile(path.join(installation, helperPath), helperText);
      if (access === "ro-instructions") {
        const metadata = path.join(original, "metadata");
        await fs.mkdir(metadata);
        await fs.rename(path.join(original, "SKILL.md"), path.join(metadata, "SKILL.md"));
        await fs.symlink("metadata/SKILL.md", path.join(original, "SKILL.md"));
        sandbox.docker.binds = [`${metadata}:/guest/repo/review-helper/metadata:ro`];
      }
      if (access !== "unmounted" && location === "host") {
        const mountedSource = access === "scripts-rw" ? path.join(original, "scripts") : original;
        const alias = path.join(home, "source-alias");
        await fs.symlink(mountedSource, alias, "dir");
        sandbox.docker.binds = [`${alias}:/installed-source:${access === "ro" ? "ro" : "rw"}`];
      }
      const { capabilities, tool } = await bind();
      expect(capabilities.sandbox?.installedSkillRoots).toEqual(
        admitted ? { autoreview: "/guest/repo/.openclaw/sandbox-skills/skills/autoreview" } : {},
      );
      expect(tool === null).toBe(!admitted);
      const syncedHelper = path.join(sandboxDir, "skills", "autoreview", helperPath);
      expect(await fs.readFile(syncedHelper, "utf8")).toBe(helperText);
      if (source === "personal" && access === "unmounted") {
        await writeSkill({
          dir: path.join(workspace, ".agents", "skills", "autoreview"),
          name: "autoreview",
          description: "Project replacement",
        });
        await refreshSkillsDiscovery({ workspaceDir: workspace });
        const project = await bind();
        expect(project.capabilities.sandbox?.installedSkillRoots).toEqual({});
        expect(project.tool).toBeNull();
      }
    } finally {
      release();
      await closeSkillsWatchers(true);
      await restoreMockSkillsHomeEnv(environment);
    }
  },
);
