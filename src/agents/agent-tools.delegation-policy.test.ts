import { afterAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  createOpenClawCodingTools,
  createOpenClawCodingToolsAsync,
  createOpenClawCodingToolsInternal,
  createOpenClawCodingToolsInternalAsync,
} from "./agent-tools.js";
import { prepareConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { createOpenClawOnlyToolConstructionPlan } from "./test-helpers/tool-construction-plan.js";

useSessionStoreTempDirs(afterAll, "policy-readers-");
const openClawOnlyPlan = createOpenClawOnlyToolConstructionPlan();
const toolNameList = (tools: readonly { name: string }[]) => tools.map((tool) => tool.name);

describe("coding tool policy reader custody", () => {
  it.each([
    { name: "sync", create: createOpenClawCodingToolsInternal },
    { name: "async", create: createOpenClawCodingToolsInternalAsync },
  ])("preserves the admitted policy reader through internal $name assembly", async ({ create }) => {
    const config: OpenClawConfig = { tools: { openclaw: { autoApproveChanges: true } } };
    let current: OpenClawConfig = { ...config, ui: { seamColor: "#123456" } };
    const readDelegationConfig = vi.fn(() => current);
    const options = {
      config,
      readDelegationConfig,
      toolConstructionPlan: openClawOnlyPlan,
      conversationCapabilityProfile: await prepareConversationCapabilityProfile({ config }),
    };
    vi.mocked(createOpenClawTools).mockClear();
    await create(options);
    const forwarded = vi.mocked(createOpenClawTools).mock.calls.at(-1)![0]!;
    expect(forwarded.readDelegationConfig).toBe(readDelegationConfig);
    current = { tools: { openclaw: { autoApproveChanges: false } } };
    expect(forwarded.readDelegationConfig!()).toBe(current);
    expect(forwarded.config?.tools?.openclaw?.autoApproveChanges).toBe(true);
  });

  it.each([
    { name: "sync", create: createOpenClawCodingTools },
    { name: "async", create: createOpenClawCodingToolsAsync },
  ])(
    "does not forward a private policy reader through the public $name factory",
    async ({ create }) => {
      const config: OpenClawConfig = { tools: { openclaw: { autoApproveChanges: false } } };
      const readDelegationConfig = vi.fn(() => ({
        tools: { openclaw: { autoApproveChanges: true } },
      }));
      // A variable models JavaScript callers or accidentally forwarded internal options;
      // omitting a field from the public type does not remove it at runtime.
      const options = {
        config,
        readDelegationConfig,
        toolConstructionPlan: openClawOnlyPlan,
        conversationCapabilityProfile: await prepareConversationCapabilityProfile({ config }),
      };
      vi.mocked(createOpenClawTools).mockClear();
      const tools = await create(options);
      expect(toolNameList(tools)).toContain("openclaw");
      expect(vi.mocked(createOpenClawTools)).toHaveBeenCalledOnce();
      expect(vi.mocked(createOpenClawTools).mock.calls.at(-1)![0]!.readDelegationConfig).not.toBe(
        readDelegationConfig,
      );
      expect(
        vi.mocked(createOpenClawTools).mock.calls.at(-1)![0]!.readDelegationConfig!().tools
          ?.openclaw?.autoApproveChanges,
      ).toBe(false);
      expect(
        vi.mocked(createOpenClawTools).mock.calls.at(-1)![0]!.config?.tools?.openclaw
          ?.autoApproveChanges,
      ).toBe(false);
      expect(readDelegationConfig).not.toHaveBeenCalled();
      expect(options.readDelegationConfig).toBe(readDelegationConfig);
    },
  );
});
