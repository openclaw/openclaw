import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCoreGatewayMethodDescriptors } from "../gateway/methods/core-method-policy.js";
import { createGatewayMethodRegistry } from "../gateway/methods/registry.js";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { resolveGatewayScopedTools } from "../gateway/tool-resolution.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { resolveSkillDispatchTools } from "../skills/runtime/tool-dispatch.js";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";

const identity = { agentId: "main", sessionKey: "agent:main:discord:channel:maintainers" };
const cfg: OpenClawConfig = {
  plugins: { enabled: false },
  tools: { allow: ["sessions", "gateway"], sessions: { visibility: "all" } },
};

describe.each(["agent", "loopback", "skill"] as const)("%s person-scoped sessions", (surface) => {
  const tools = (operatorAuthority?: AdmittedRunOperatorAuthority) =>
    withGatewayToolCallerIdentity({ ...identity, operatorAuthority }, () =>
      surface === "agent"
        ? createOpenClawCodingTools({ ...identity, config: cfg, senderIsOwner: false })
        : surface === "loopback"
          ? resolveGatewayScopedTools({
              ...identity,
              cfg,
              senderIsOwner: false,
              operatorAuthority,
              surface: "loopback",
            }).tools
          : resolveSkillDispatchTools(
              {
                ...identity,
                cfg,
                senderIsOwner: false,
                operatorAuthority,
                message: { surface: "discord" },
                workspaceDir: "/tmp/person-sessions",
                provider: "openai",
                model: "gpt-5.5",
              },
              { createOpenClawTools },
            ),
    );

  it("keeps unlinked, unissued, and revoked senders out of native session management", async () => {
    expect((await tools()).map((tool) => tool.name)).not.toContain("sessions");
    const source = { profileId: "person", scopes: ["operator.write"], assertCurrent: () => {} };
    await expect(tools(source)).rejects.toThrow("must be issued by the host");
    const controller = new AbortController();
    const authority = createAdmittedRunOperatorAuthority({
      ...source,
      signal: controller.signal,
    });
    controller.abort(new Error("identity link revoked"));
    await expect(tools(authority)).rejects.toThrow("identity link revoked");
  });

  it.each(["read", "write"] as const)(
    "carries %s authority from discovery through the registered native RPC without gaining admin",
    async (scope) => {
      const controller = new AbortController();
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "person",
        scopes: [`operator.${scope}`],
        signal: controller.signal,
        assertCurrent: () => {},
      });
      const handler = vi.fn(({ client, params, respond }: GatewayRequestHandlerOptions) => {
        expect(client?.internal?.operatorRoleActor).toEqual({
          kind: "operator",
          profileId: "person",
        });
        expect(client?.connect.scopes).not.toContain("operator.admin");
        respond(true, {
          key: params.key,
          owner: { actor: params.owner },
          entry: { sessionId: "target-session", lifecycleRevision: "target-generation" },
          groups: [],
          deleted: true,
        });
      });
      const context = createContext();
      context.getRuntimeConfig = () => cfg;
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry(
          createCoreGatewayMethodDescriptors(
            Object.fromEntries(
              [
                "sessions.groups.list",
                "sessions.groups.put",
                "sessions.assignOwner",
                "sessions.patch",
                "sessions.reset",
                "sessions.delete",
              ].map((method) => [method, handler]),
            ),
          ),
        );
      await withPluginRuntimeGatewayContextResolver(
        () => context,
        async () => {
          const available = await tools(authority);
          expect(available.map((tool) => tool.name)).not.toContain("gateway");
          const tool = expectDefined(
            available.find((candidate) => candidate.name === "sessions"),
            "person-scoped sessions tool",
          );
          await tool.execute("list", { action: "group_list" });
          for (const args of [
            { action: "assign_owner", ownerType: "human", ownerId: "person" },
            { action: "patch", label: "Owned task" },
            { action: "group_set", names: ["Work"] },
            {
              action: "delete",
              sessionKey: "agent:main:other",
              expectedSessionId: "target-session",
            },
          ]) {
            const result = tool.execute("mutation", args);
            if (scope === "write") {
              await expect(result).resolves.toBeDefined();
            } else {
              await expect(result).rejects.toThrow("missing scope: operator.write");
            }
          }
          for (const args of [
            { action: "patch", ttlMinutes: 30 },
            { action: "reset", sessionKey: "agent:main:other" },
          ]) {
            await expect(tool.execute("admin", args)).rejects.toThrow(
              "missing scope: operator.admin",
            );
          }
          const calls = handler.mock.calls.length;
          controller.abort(new Error("identity link revoked"));
          await expect(tool.execute("stale", { action: "group_list" })).rejects.toThrow(
            "identity link revoked",
          );
          expect(handler).toHaveBeenCalledTimes(calls);
        },
      );
    },
  );
});
