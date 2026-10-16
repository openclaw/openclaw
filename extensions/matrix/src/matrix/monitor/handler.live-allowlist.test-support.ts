import { describe, expect, it, vi } from "vitest";
import type { MatrixConfig } from "../../types.js";
import * as matrixMonitorConfig from "./config.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

export function registerMatrixLiveAllowlistTests(): void {
  describe("matrix monitor handler live allowlist reload", () => {
    it.each(["account override", "startup name", "name matching disabled", "group"])(
      "revokes live sender access after changing %s configuration",
      async (scenario) => {
        const group = scenario === "group";
        const names = scenario === "startup name" || scenario === "name matching disabled";
        const matrix: MatrixConfig = group
          ? { groupAllowFrom: ["@alice:example.org", "@bob:example.org"] }
          : scenario === "account override"
            ? {
                dm: { allowFrom: ["@base:example.org"] },
                accounts: { ops: { dm: { allowFrom: ["@alice:example.org"] } } },
              }
            : {
                ...(names ? { dangerouslyAllowNameMatching: true } : {}),
                dm: { allowFrom: names ? ["Alice"] : ["*"] },
              };
        const cfg = { channels: { matrix } };
        const dispatchInboundMessage = vi.fn(async () => ({
          queuedFinal: false,
          counts: { final: 0, block: 0, tool: 0 },
        }));
        const resolveLiveUserAllowlist = vi.fn(
          async (
            params: Parameters<typeof matrixMonitorConfig.resolveMatrixMonitorLiveUserAllowlist>[0],
          ) =>
            params.cfg.channels?.matrix?.dangerouslyAllowNameMatching === true
              ? ["@alice:example.org"]
              : [],
        );
        if (scenario === "name matching disabled") {
          vi.spyOn(matrixMonitorConfig, "resolveMatrixMonitorLiveUserAllowlist").mockImplementation(
            resolveLiveUserAllowlist,
          );
        }
        const { handler } = createMatrixHandlerTestHarness({
          cfg,
          isDirectMessage: !group,
          dispatchInboundMessage,
          ...(group
            ? {
                groupPolicy: "allowlist",
                roomsConfig: { "*": {} },
                groupAllowFrom: ["@alice:example.org", "@bob:example.org"],
                groupAllowFromResolvedEntries: [
                  { input: "@alice:example.org", id: "@alice:example.org" },
                  { input: "@bob:example.org", id: "@bob:example.org" },
                ],
              }
            : {
                dmPolicy: "allowlist",
                allowFrom:
                  scenario === "wildcard"
                    ? ["*"]
                    : scenario === "name matching disabled"
                      ? []
                      : ["@alice:example.org"],
                allowFromResolvedEntries:
                  scenario === "account override"
                    ? [{ input: "@alice:example.org", id: "@alice:example.org" }]
                    : scenario === "startup name"
                      ? [{ input: "Alice", id: "@alice:example.org" }]
                      : [],
              }),
        });
        const receive = (eventId: string, again: boolean) =>
          handler(
            group ? "!room:example.org" : "!dm:example.org",
            createMatrixTextMessageEvent({
              eventId,
              sender: "@alice:example.org",
              body: `${group ? "@room " : ""}hello${again ? " again" : ""}`,
              ...(group ? { mentions: { room: true } } : {}),
            }),
          );
        await receive("$before", false);
        expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
        if (group) {
          matrix.groupAllowFrom = ["@bob:example.org"];
        } else if (scenario === "name matching disabled") {
          matrix.dangerouslyAllowNameMatching = false;
        } else if (matrix.accounts?.ops?.dm) {
          matrix.accounts.ops.dm.allowFrom = [];
        } else if (matrix.dm) {
          matrix.dm.allowFrom = [];
        }
        await receive("$after", true);
        expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
        if (scenario === "name matching disabled") {
          expect(
            resolveLiveUserAllowlist.mock.calls.filter(
              ([params]) =>
                JSON.stringify((params.entries ?? []).map(String)) === JSON.stringify(["Alice"]),
            ),
          ).toHaveLength(2);
        }
      },
    );
  });
}
