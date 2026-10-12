// Msteams tests cover graph members plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { getMemberInfoMSTeams } from "./graph-members.js";
import { createGraphPageGuard } from "./graph-pagination.test-support.js";

const mockState = vi.hoisted(() => ({
  resolveGraphToken: vi.fn(),
  fetchGraphJson: vi.fn(),
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime-api.js")>();
  return { ...actual, fetchWithSsrFGuard: mockState.fetchWithSsrFGuard };
});

vi.mock("./graph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph.js")>();
  return {
    ...actual,
    resolveGraphToken: mockState.resolveGraphToken,
    fetchGraphJson: mockState.fetchGraphJson,
  };
});

const TOKEN = "test-graph-token";

describe("getMemberInfoMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
    mockState.fetchWithSsrFGuard.mockImplementation(createGraphPageGuard(mockState.fetchGraphJson));
  });

  it("accepts a normalized match on the final allowed team page", async () => {
    let page = 0;
    mockState.fetchGraphJson.mockImplementation(async () => {
      page += 1;
      if (page === 1) {
        return { membershipType: "standard" };
      }
      return {
        value: page === 101 ? [{ userId: "aad-final", email: " Alice@Contoso.com " }] : [],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/teams/team-1/members?$skip=next",
      };
    });

    await expect(
      getMemberInfoMSTeams({
        cfg: {} as OpenClawConfig,
        to: "team-1/channel-1",
        userId: "teams:Alice@Contoso.com ",
      }),
    ).resolves.toMatchObject({ user: { id: "aad-final" } });
    expect(mockState.fetchGraphJson).toHaveBeenCalledTimes(101);
  });

  it("preserves the exact team pagination-limit failure", async () => {
    mockState.fetchGraphJson
      .mockResolvedValueOnce({ membershipType: "standard" })
      .mockResolvedValue({
        value: [],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/teams/team-1/members?$skip=next",
      });

    await expect(
      getMemberInfoMSTeams({
        cfg: {} as OpenClawConfig,
        to: "team-1/channel-1",
        userId: "missing",
      }),
    ).rejects.toThrow("Microsoft Teams team member pagination limit exceeded");
    expect(mockState.fetchGraphJson).toHaveBeenCalledTimes(101);
  });

  it("does not return profiles for users outside the conversation", async () => {
    mockState.fetchGraphJson
      .mockResolvedValueOnce({ membershipType: "standard" })
      .mockResolvedValueOnce({ value: [] });

    await expect(
      getMemberInfoMSTeams({
        cfg: {} as OpenClawConfig,
        to: "team-1/channel-1",
        userId: "user-789",
      }),
    ).rejects.toThrow("User user-789 is not a member of this conversation");
    expect(mockState.fetchGraphJson).toHaveBeenCalledTimes(2);
  });

  it("rejects private channels when the baseline cannot prove channel membership", async () => {
    mockState.fetchGraphJson.mockResolvedValueOnce({ membershipType: "private" });

    await expect(
      getMemberInfoMSTeams({
        cfg: {} as OpenClawConfig,
        to: "team-1/channel-private",
        userId: "user-123",
      }),
    ).rejects.toThrow("requires a standard channel");
    expect(mockState.fetchGraphJson).toHaveBeenCalledTimes(1);
  });

  it("returns the trusted requester identity in the current chat without Graph reads", async () => {
    await expect(
      getMemberInfoMSTeams({
        cfg: {} as OpenClawConfig,
        to: "user:user-123",
        userId: "teams:user-123",
        currentRequesterId: "user-123",
      }),
    ).resolves.toMatchObject({
      user: {
        id: "user-123",
        displayName: undefined,
        mail: undefined,
        jobTitle: undefined,
        userPrincipalName: undefined,
        officeLocation: undefined,
        roles: [],
      },
    });
    expect(mockState.resolveGraphToken).not.toHaveBeenCalled();
    expect(mockState.fetchGraphJson).not.toHaveBeenCalled();
  });

  it("rejects unrelated profiles in chats before fetching a user", async () => {
    await expect(
      getMemberInfoMSTeams({
        cfg: {} as OpenClawConfig,
        to: "conversation:19:chat@thread.v2",
        userId: "user-456",
        currentRequesterId: "user-123",
      }),
    ).rejects.toThrow("User user-456 is not a member of this conversation");
    expect(mockState.fetchGraphJson).not.toHaveBeenCalled();
  });
});
