import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePluginHarnessPolicyToolsAllow } from "./execution-environment.js";

const input = { sessionId: "policy-session", provider: "fixture", modelId: "fixture-model" };

describe("native harness tool policy", () => {
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
