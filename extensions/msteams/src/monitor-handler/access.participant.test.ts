import { describe, expect, it, vi } from "vitest";
import { installMSTeamsTestRuntime } from "../monitor-handler.test-helpers.js";
import { getMSTeamsRuntime } from "../runtime.js";
import { resolveMSTeamsSenderAccess } from "./access.js";

describe("Teams participant domain", () => {
  it.each(["entra", "application", "unknown"] as const)(
    "retains %s identity evidence",
    async (kind) => {
      installMSTeamsTestRuntime({ readAllowFromStore: vi.fn(async () => []) });
      const observed = vi.spyOn(getMSTeamsRuntime().channel.inbound.ingress, "resolveStable");
      const activity = {
        type: "message",
        id: "message",
        text: "hello",
        serviceUrl: "https://fixture.invalid",
        channelId: "msteams",
        from: {
          id: "opaque-account",
          name: "Alice",
          ...(kind === "entra" ? { aadObjectId: "OBJECT-ID" } : {}),
        },
        recipient: { id: "bot", name: "Bot" },
        conversation: {
          id: "conversation",
          conversationType: "personal",
          ...(kind === "entra" ? { tenantId: "TENANT" } : {}),
        },
      };
      const result = await resolveMSTeamsSenderAccess({
        cfg: {
          channels: {
            msteams: {
              dmPolicy: "open",
              allowFrom: ["*"],
              ...(kind === "application" ? { appId: "APP" } : {}),
            },
          },
        },
        activity,
      });
      expect(result.senderAccess.allowed).toBe(true);
      const input = observed.mock.calls[0]?.[0];
      expect(input?.identity?.resolveParticipant?.(input.subject)).toEqual(
        kind === "entra"
          ? { domain: "entra:tenant", idKind: "object-id", id: "object-id" }
          : kind === "application"
            ? { domain: "bot:app", idKind: "channel-account-id", id: "opaque-account" }
            : undefined,
      );
    },
  );
});
