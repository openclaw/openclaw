// Msteams tests cover the generic channel-message-tool schema wiring for
// Teams-specific actions. The real core discovery suite covers includeMembers
// (generic ChannelMessageToolSchemaContribution wiring shared by every
// channel plugin; see openclaw/plugin-sdk/channel-contract).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelMessageActionName, OpenClawConfig } from "../runtime-api.js";

const mockState = vi.hoisted(() => ({
  resolveMSTeamsAccount: vi.fn(),
}));

vi.mock("./accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accounts.js")>();
  return { ...actual, resolveMSTeamsAccount: mockState.resolveMSTeamsAccount };
});

import { describeMSTeamsMessageTool } from "./channel-message-tool.js";

function schemaFor(
  discovery: ReturnType<typeof describeMSTeamsMessageTool>,
  action: ChannelMessageActionName,
) {
  const schema = discovery.schema;
  const list = Array.isArray(schema) ? schema : schema ? [schema] : [];
  return list.find((entry) => entry.actions?.includes(action));
}

describe("describeMSTeamsMessageTool", () => {
  beforeEach(() => {
    mockState.resolveMSTeamsAccount.mockReset();
  });

  it("still advertises the existing unpin pinnedMessageId schema (no regression)", () => {
    mockState.resolveMSTeamsAccount.mockReturnValue({
      enabled: true,
      configured: true,
      tokenStatus: "available",
    });

    const discovery = describeMSTeamsMessageTool({
      cfg: {} as OpenClawConfig,
      accountId: undefined,
    });

    expect(discovery.actions).toContain("unpin");
    const unpinSchema = schemaFor(discovery, "unpin");
    expect(unpinSchema).toBeDefined();
    expect(unpinSchema?.properties.pinnedMessageId).toBeDefined();
  });

  it("advertises no actions or schema when the account is not usable", () => {
    mockState.resolveMSTeamsAccount.mockReturnValue({
      enabled: false,
      configured: false,
      tokenStatus: "missing",
    });

    const discovery = describeMSTeamsMessageTool({
      cfg: {} as OpenClawConfig,
      accountId: undefined,
    });

    expect(discovery.actions).toEqual([]);
    expect(discovery.schema).toBeNull();
  });
});
