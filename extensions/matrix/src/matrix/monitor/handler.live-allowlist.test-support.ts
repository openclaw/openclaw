import { describe, expect, it, vi } from "vitest";
import type { MatrixConfig } from "../../types.js";
import * as matrixMonitorConfig from "./config.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

const alice = "@alice:example.org";
const bob = "@bob:example.org";
const resolved = (input: string, id = input) => ({ input, id });
type AllowlistParams = Parameters<
  typeof matrixMonitorConfig.resolveMatrixMonitorLiveUserAllowlist
>[0];

export function registerMatrixLiveAllowlistTests(): void {
  describe("matrix monitor handler live allowlist reload", () => {
    it.each(["account override", "startup name", "name matching disabled", "group"])(
      "revokes live sender access after changing %s configuration",
      async (scenario) => {
        const group = scenario === "group";
        const matrix: MatrixConfig = group
          ? { groupAllowFrom: [alice, bob] }
          : scenario === "account override"
            ? {
                dm: { allowFrom: ["@base:example.org"] },
                accounts: { ops: { dm: { allowFrom: [alice] } } },
              }
            : {
                dangerouslyAllowNameMatching: true,
                dm: { allowFrom: ["Alice"] },
              };
        const cfg = { channels: { matrix } };
        const dispatchInboundMessage = vi.fn(async () => ({
          queuedFinal: false,
          counts: { final: 0, block: 0, tool: 0 },
        }));
        const resolveLiveUserAllowlist = vi.fn(async (params: AllowlistParams) =>
          params.cfg.channels?.matrix?.dangerouslyAllowNameMatching === true ? [alice] : [],
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
                groupAllowFrom: [alice, bob],
                groupAllowFromResolvedEntries: [resolved(alice), resolved(bob)],
              }
            : {
                dmPolicy: "allowlist",
                allowFrom: scenario === "name matching disabled" ? [] : [alice],
                allowFromResolvedEntries:
                  scenario === "account override"
                    ? [resolved(alice)]
                    : scenario === "startup name"
                      ? [resolved("Alice", alice)]
                      : [],
              }),
        });
        const receive = (eventId: string, again: boolean) =>
          handler(
            group ? "!room:example.org" : "!dm:example.org",
            createMatrixTextMessageEvent({
              eventId,
              sender: alice,
              body: `${group ? "@room " : ""}hello${again ? " again" : ""}`,
              ...(group ? { mentions: { room: true } } : {}),
            }),
          );
        await receive("$before", false);
        expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
        if (group) {
          matrix.groupAllowFrom = [bob];
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
