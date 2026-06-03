import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./graph.js", () => ({
  fetchGraphJson: vi.fn(),
  escapeOData: (v: string) => v.replace(/'/g, "''"),
}));

import { clearAadProfileCache, fetchAadUserProfile } from "./graph-users.js";
import { fetchGraphJson } from "./graph.js";

const mockFetchGraphJson = vi.mocked(fetchGraphJson);

afterEach(() => {
  clearAadProfileCache();
  vi.clearAllMocks();
});

describe("fetchAadUserProfile", () => {
  it("fetches profile with extended fields from Graph", async () => {
    const profile = {
      id: "aad-001",
      displayName: "Alice",
      mail: "alice@contoso.com",
      department: "Sales",
      jobTitle: "Account Executive",
    };
    mockFetchGraphJson.mockResolvedValueOnce(profile);

    const result = await fetchAadUserProfile({
      token: "tok",
      aadObjectId: "aad-001",
    });

    expect(result).toEqual(profile);
    expect(mockFetchGraphJson).toHaveBeenCalledOnce();
    const callPath = mockFetchGraphJson.mock.calls[0]?.[0]?.path as string;
    expect(callPath).toContain("/users/aad-001");
    expect(callPath).toContain("department");
    expect(callPath).toContain("jobTitle");
  });

  it("returns cached profile on second call within TTL", async () => {
    const profile = { id: "aad-002", displayName: "Bob" };
    mockFetchGraphJson.mockResolvedValueOnce(profile);

    await fetchAadUserProfile({ token: "tok", aadObjectId: "aad-002" });
    const second = await fetchAadUserProfile({
      token: "tok",
      aadObjectId: "aad-002",
    });

    expect(second).toEqual(profile);
    expect(mockFetchGraphJson).toHaveBeenCalledOnce();
  });

  it("returns null when Graph throws", async () => {
    mockFetchGraphJson.mockRejectedValueOnce(new Error("403 Forbidden"));

    const result = await fetchAadUserProfile({
      token: "tok",
      aadObjectId: "aad-err",
    });

    expect(result).toBeNull();
  });

  it("returns null for empty aadObjectId", async () => {
    const result = await fetchAadUserProfile({
      token: "tok",
      aadObjectId: "",
    });

    expect(result).toBeNull();
    expect(mockFetchGraphJson).not.toHaveBeenCalled();
  });

  it("returns null when Graph returns profile without id", async () => {
    mockFetchGraphJson.mockResolvedValueOnce({ displayName: "Ghost" });

    const result = await fetchAadUserProfile({
      token: "tok",
      aadObjectId: "aad-ghost",
    });

    expect(result).toBeNull();
  });
});
