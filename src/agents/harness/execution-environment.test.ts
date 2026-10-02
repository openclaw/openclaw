import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveAgentHarnessSessionExecutionRestriction,
  resolvePluginHarnessPolicyToolsAllow,
} from "./execution-environment.js";
import type { AgentHarness } from "./types.js";

const input = { sessionId: "policy-session", provider: "fixture", modelId: "fixture-model" };

describe("native harness tool policy", () => {
  it.each(["openclaw", "native-runtime"])(
    "does not treat the public %s id as a foreground lifecycle guarantee",
    (id) => {
      const harness: AgentHarness = {
        id,
        label: "Fixture runtime",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("must not invoke");
        },
      };
      const restriction = resolveAgentHarnessSessionExecutionRestriction({
        harness,
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:bounded",
        entry: { execution: "foreground-only" },
        provider: "fixture",
        modelId: "fixture",
      });
      expect(restriction).toMatchObject({
        reason: "sandbox-required",
        message: expect.stringContaining("cannot join this chat's foreground container cleanup"),
      });
      expect(
        resolveAgentHarnessSessionExecutionRestriction({
          harness,
          cfg: {},
          agentId: "main",
          sessionKey: "agent:main:ordinary",
          entry: {},
          provider: "fixture",
          modelId: "fixture",
        }),
      ).toBeUndefined();
    },
  );
  it.each([
    { name: "narrow allowlist", config: { tools: { allow: ["message"] } }, restricted: true },
    { name: "specific denylist", config: { tools: { deny: ["exec"] } }, restricted: true },
    { name: "narrow profile", config: { tools: { profile: "coding" } }, restricted: true },
    { name: "full profile", config: { tools: { profile: "full" } }, restricted: false },
    { name: "empty config allowlist", config: { tools: { allow: [] } }, restricted: false },
  ] satisfies Array<{ name: string; config: OpenClawConfig; restricted: boolean }>)(
    "preserves plugin side-question restrictions for $name",
    ({ config, restricted }) => {
      expect(resolvePluginHarnessPolicyToolsAllow({ ...input, config })).toEqual(
        restricted ? [] : undefined,
      );
    },
  );

  it.each([true, false])(
    "applies wildcard WebChat sender denial only to non-owners (owner: %s)",
    (senderIsOwner) => {
      expect(
        resolvePluginHarnessPolicyToolsAllow({
          ...input,
          config: { tools: { toolsBySender: { "*": { deny: ["*"] } } } },
          messageProvider: "webchat",
          senderIsOwner,
        }),
      ).toEqual(senderIsOwner ? undefined : []);
    },
  );
});
