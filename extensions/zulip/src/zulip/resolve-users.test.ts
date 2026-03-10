import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchZulipUsers } from "./client.js";
import { buildCanonicalZulipAllowList, resolveZulipUserInputs } from "./resolve-users.js";

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    fetchZulipUsers: vi.fn(),
  };
});

const mockedFetchZulipUsers = vi.mocked(fetchZulipUsers);

const DUMMY_CLIENT = {
  baseUrl: "https://zulip.example.com",
  botEmail: "bot@example.com",
  botApiKey: "key",
  authHeader: "Basic abc",
  request: vi.fn(),
  requestForm: vi.fn(),
};

describe("resolveZulipUserInputs", () => {
  beforeEach(() => {
    mockedFetchZulipUsers.mockReset();
    mockedFetchZulipUsers.mockResolvedValue([
      { user_id: 1, email: "alice@example.com", full_name: "Alice Jones", is_bot: false },
      { user_id: 2, email: "bob@example.com", full_name: "Bob Stone", is_bot: false },
      { user_id: 3, email: "other-bob@example.com", full_name: "Bob Stone", is_bot: false },
    ]);
  });

  it("resolves numeric ids, emails, and unique @local-part matches", async () => {
    const results = await resolveZulipUserInputs({
      client: DUMMY_CLIENT,
      inputs: ["1", "alice@example.com", "@bob"],
    });

    expect(results).toEqual([
      expect.objectContaining({ input: "1", resolved: true, id: "1", email: "alice@example.com" }),
      expect.objectContaining({ input: "alice@example.com", resolved: true, id: "1" }),
      expect.objectContaining({ input: "@bob", resolved: true, id: "2", email: "bob@example.com" }),
    ]);
  });

  it("marks ambiguous or missing friendly identifiers as unresolved", async () => {
    const results = await resolveZulipUserInputs({
      client: DUMMY_CLIENT,
      inputs: ["Bob Stone", "missing@example.com"],
    });

    expect(results[0]).toEqual(expect.objectContaining({ resolved: false, note: "ambiguous" }));
    expect(results[1]).toEqual(expect.objectContaining({ resolved: false, note: "not-found" }));
  });

  it("builds canonical allowlists from resolved ids and emails", async () => {
    const resolutions = await resolveZulipUserInputs({
      client: DUMMY_CLIENT,
      inputs: ["alice@example.com", "@bob"],
    });

    expect(
      buildCanonicalZulipAllowList({
        entries: ["*", "alice@example.com", "@bob"],
        resolutions,
      }),
    ).toEqual(["*", "1", "alice@example.com", "2", "bob@example.com"]);
  });
});
