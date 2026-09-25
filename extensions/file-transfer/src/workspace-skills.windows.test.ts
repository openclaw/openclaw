import { expect, it, vi } from "vitest";
import { createNodeWorkspaceSkills } from "./workspace-skills.js";
import { runNodeWorkspaceWorker } from "./workspace-worker.js";

vi.mock("node:path", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:path")>();
  return { ...original, default: original.win32 };
});

vi.mock("./workspace-worker.js", () => ({
  runNodeWorkspaceWorker: vi.fn(async () => "{}"),
}));

it.each(["discovery", "watch"] as const)(
  "maps nested Windows Skill source paths for %s to the POSIX node root",
  async (operation) => {
    const signal = new AbortController().signal;
    const access = createNodeWorkspaceSkills({
      nodeId: "node-1",
      workspaceDir: "C:\\gateway",
      remoteRoot: "/node/workspace",
      signal,
      openDuplex: vi.fn(),
    });
    const request: Parameters<typeof access.loadSkills>[0] = {
      executionWorkspaceDir: "C:\\gateway\\nested\\execution",
      sourcePlan: {
        workspaceDir: "C:\\gateway",
        stateDir: "C:\\gateway\\.openclaw\\state",
        managedSkillsDir: "C:\\gateway\\.openclaw\\skills",
        pluginSkillsDir: "C:\\gateway\\plugins\\skills",
        bundledSkillsDir: "C:\\gateway\\bundled\\skills",
        roots: [
          {
            dir: "C:\\gateway\\.agents\\skills",
            source: "openclaw-workspace",
            tier: "workspace",
          },
        ],
        pluginSkillRoots: [],
        allowSymlinkTargets: ["C:\\gateway\\linked\\skills", "/node/external"],
      },
      limits: {
        maxCandidatesPerRoot: 100,
        maxSkillsLoadedPerSource: 100,
        maxSkillFileBytes: 65536,
      },
      additionalBins: [],
    };
    if (operation === "discovery") {
      await access.loadSkills(request);
    } else {
      const changed = vi.fn();
      const events = ["unavailable", "change", "available", "change", "unavailable"];
      vi.mocked(runNodeWorkspaceWorker).mockImplementationOnce(
        async (_options, _command, _request, _signal, onLine) => {
          expect(onLine).toBeTypeOf("function");
          for (const event of events) {
            onLine!(JSON.stringify(event));
          }
          expect(() => onLine!(JSON.stringify("ready"))).toThrow(
            "Invalid Skill change notification",
          );
          return "";
        },
      );
      await access.watchSkills(request, changed, signal);
      expect(changed.mock.calls.map(([event]) => event)).toEqual(events);
    }
    const params = vi.mocked(runNodeWorkspaceWorker).mock.lastCall?.[2];
    expect(params).toMatchObject({ operation, watch: operation === "watch" });
    expect(JSON.parse(String(params?.request))).toMatchObject({
      executionWorkspaceDir: "/node/workspace/nested/execution",
      sourcePlan: {
        workspaceDir: "/node/workspace",
        stateDir: "/node/workspace/.openclaw/state",
        managedSkillsDir: "/node/workspace/.openclaw/skills",
        pluginSkillsDir: "/node/workspace/plugins/skills",
        bundledSkillsDir: "/node/workspace/bundled/skills",
        roots: [{ dir: "/node/workspace/.agents/skills" }],
        allowSymlinkTargets: ["/node/workspace/linked/skills", "/node/external"],
      },
    });
  },
);
