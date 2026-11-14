import { expect, it } from "vitest";
import { fixture } from "./session-catalog-list-operation.test-support.js";

it.each([
  { state: "absent", pluginConfig: undefined, canContinue: false },
  { state: "disabled", pluginConfig: { supervision: { enabled: false } }, canContinue: false },
  { state: "enabled", pluginConfig: { supervision: { enabled: true } }, canContinue: true },
])(
  "gates local continuation with supervision $state while preserving archive eligibility",
  async ({ pluginConfig, canContinue }) => {
    const f = await fixture(2, pluginConfig);
    f.listPage.mockResolvedValue({
      sessions: (["idle", "notLoaded", "active"] as const).flatMap((status) =>
        (status === "idle" ? ["cli", "exec"] : ["cli"]).map((source) => ({
          threadId: `${status}-${source}`,
          status,
          source,
          archived: false,
        })),
      ),
    });
    const hosts = await f.provider.list({
      agentId: "main",
      hostIds: f.homes.map((home) => home.hostId),
    });
    expect(hosts).toHaveLength(2);
    for (const host of hosts) {
      expect(host.sessions.map((row) => [row.canArchive, row.canContinue])).toEqual([
        [true, canContinue],
        [false, false],
        [true, canContinue],
        [false, false],
      ]);
    }
    if (!canContinue) {
      const host = hosts[0]!;
      await expect(
        f.provider.continueSession!({
          agentId: "main",
          hostId: host.hostId,
          threadId: host.sessions[0]!.threadId,
          sourceHomeId: host.sessions[0]!.sourceHomeId,
          clientScopes: ["operator.admin"],
        }),
      ).rejects.toThrow("Codex supervision is disabled");
      expect(f.runtime.agent.session.createSessionEntry).not.toHaveBeenCalled();
    }
  },
);
