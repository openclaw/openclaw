import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("./graph.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./graph.js")>()),
  resolveGraphToken: mockState.resolveGraphToken,
  fetchGraphJson: mockState.fetchGraphJson,
}));

const memberInfo = (userId: string, to = "team-1/channel-1", currentRequesterId?: string) =>
  getMemberInfoMSTeams({ cfg: {}, to, userId, currentRequesterId });

describe("getMemberInfoMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue("test-graph-token");
    mockState.fetchWithSsrFGuard.mockImplementation(createGraphPageGuard(mockState.fetchGraphJson));
  });

  it.each([true, false])("finds final-page member only when present: %s", async (found) => {
    let page = 0;
    mockState.fetchGraphJson.mockImplementation(async () => {
      page += 1;
      if (page === 1) {
        return { membershipType: "standard" };
      }
      return {
        value: found && page === 101 ? [{ userId: "aad-final", email: " Alice@Contoso.com " }] : [],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/teams/team-1/members?$skip=next",
      };
    });

    const result = memberInfo(found ? "teams:Alice@Contoso.com " : "missing");
    if (found) {
      await expect(result).resolves.toMatchObject({ user: { id: "aad-final" } });
    } else {
      await expect(result).rejects.toThrow("Microsoft Teams team member pagination limit exceeded");
    }
    expect(mockState.fetchGraphJson).toHaveBeenCalledTimes(101);
  });

  it("does not return profiles for users outside the conversation", async () => {
    mockState.fetchGraphJson
      .mockResolvedValueOnce({ membershipType: "standard" })
      .mockResolvedValueOnce({ value: [] });

    await expect(memberInfo("user-789")).rejects.toThrow(
      "User user-789 is not a member of this conversation",
    );
    expect(mockState.fetchGraphJson).toHaveBeenCalledTimes(2);
  });

  it("rejects private channels when the baseline cannot prove channel membership", async () => {
    mockState.fetchGraphJson.mockResolvedValueOnce({ membershipType: "private" });

    await expect(memberInfo("user-123", "team-1/channel-private")).rejects.toThrow(
      "requires a standard channel",
    );
    expect(mockState.fetchGraphJson).toHaveBeenCalledTimes(1);
  });

  it("returns the trusted requester identity in the current chat without Graph reads", async () => {
    await expect(memberInfo("teams:user-123", "user:user-123", "user-123")).resolves.toMatchObject({
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
      memberInfo("user-456", "conversation:19:chat@thread.v2", "user-123"),
    ).rejects.toThrow("User user-456 is not a member of this conversation");
    expect(mockState.fetchGraphJson).not.toHaveBeenCalled();
  });
});
