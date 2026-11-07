import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginToolAllowlist } from "../plugins/tool-grant-allowlist.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { prepareConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { createOpenClawTools } from "./openclaw-tools.js";

it("materializes additive runtime tools while preserving normal deny policy", async () => {
  const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
  createOpenClawToolsMock.mockClear();
  const config: OpenClawConfig = { tools: { profile: "coding", deny: ["workboard_block"] } };

  createOpenClawCodingTools({
    config,
    conversationCapabilityProfile: await prepareConversationCapabilityProfile({
      config,
      runtimePluginToolGrant: {
        pluginId: "workboard",
        toolNames: ["workboard_heartbeat", "workboard_complete"],
      },
    }),
  });

  expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
  const options = expectDefined(createOpenClawToolsMock.mock.lastCall?.[0], "tool options");
  expect(options.pluginToolAllowlist).not.toContain("workboard_heartbeat");
  expect(
    createPluginToolAllowlist(options.pluginToolAllowlist).allowsTool(
      "workboard",
      "workboard_heartbeat",
    ),
  ).toBe(true);
  // The grant stays encoded in the allowlist; tool construction learns only its owner.
  expect(options).not.toHaveProperty("runtimePluginToolGrant");
  expect(options).toHaveProperty("runtimePluginToolOwnerId", "workboard");
  expect(options.pluginToolDenylist).toContain("workboard_block");
});
