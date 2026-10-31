import { afterEach, describe, expect, it, vi } from "vitest";
import { snapshotApiCredentials } from "./credential-persistence.js";
import { getZaloSessionState, invalidateApi } from "./session-runtime.js";
import type { API } from "./zca-client.js";

// mock-isolation: name fixtures run against a synthetic session, never a live Zalo login.
vi.mock("./zca-client.js", () => ({ createZalo: vi.fn() }));

import {
  listZaloFriendsMatching,
  listZaloGroupsMatching,
  resolveZaloAllowFromEntries,
} from "./zalo-js.js";

const NFC_NAME = "Nguyễn Văn A";
const NFD_NAME = NFC_NAME.normalize("NFD");
const NFC_GROUP = "Đội Ngũ Hỗ Trợ";
const NFD_GROUP = NFC_GROUP.normalize("NFD");
const profiles: string[] = [];

function createMockApi(overrides: Partial<API> = {}): API {
  return {
    getContext: () => ({ imei: "test-imei", userAgent: "test-agent", language: "en" }),
    getCookie: () => ({ toJSON: () => ({ cookies: [{ key: "zpsid", value: "test" }] }) }),
    ...overrides,
  } as unknown as API;
}

function useSyntheticSession(profile: string, api: API): void {
  const state = getZaloSessionState();
  state.apiByProfile.set(profile, api);
  state.credentials.rememberCredentials(profile, snapshotApiCredentials(api));
  profiles.push(profile);
}

function friendApi(displayName: string): API {
  return createMockApi({
    getAllFriends: async () => [
      { userId: "123", username: "nguyenvana", displayName, zaloName: displayName, avatar: "" },
    ],
  });
}

function groupApi(name: string): API {
  const groupId = "998877";
  return createMockApi({
    getAllGroups: async () => ({ gridVerMap: { [groupId]: "1" } }),
    getGroupInfo: async () => ({ gridInfoMap: { [groupId]: { groupId, name } } }),
  });
}

afterEach(() => {
  for (const profile of profiles.splice(0)) {
    invalidateApi(profile);
  }
  vi.restoreAllMocks();
});

describe("zalouser canonical name matching", () => {
  it.each([
    { stored: NFD_NAME, query: NFC_NAME, form: "nfd" },
    { stored: NFC_NAME, query: NFD_NAME, form: "nfc" },
  ])(
    "matches a friend stored as $form against the opposite query form",
    async ({ stored, query, form }) => {
      const profile = `matching-friends-${form}`;
      useSyntheticSession(profile, friendApi(stored));
      const friends = await listZaloFriendsMatching(profile, query);
      expect(friends.map((friend) => friend.userId)).toEqual(["123"]);
    },
  );

  it.each([
    { stored: NFD_GROUP, query: NFC_GROUP, form: "nfd" },
    { stored: NFC_GROUP, query: NFD_GROUP, form: "nfc" },
  ])(
    "matches a group stored as $form against the opposite query form",
    async ({ stored, query, form }) => {
      const profile = `matching-groups-${form}`;
      useSyntheticSession(profile, groupApi(stored));
      const groups = await listZaloGroupsMatching(profile, query);
      expect(groups.map((group) => group.groupId)).toEqual(["998877"]);
    },
  );

  it.each([
    { stored: NFD_NAME, entry: NFC_NAME, form: "nfd" },
    { stored: NFC_NAME, entry: NFD_NAME, form: "nfc" },
  ])(
    "resolves an allowFrom entry against a friend stored as $form",
    async ({ stored, entry, form }) => {
      const profile = `matching-allow-from-${form}`;
      useSyntheticSession(profile, friendApi(stored));
      const resolved = await resolveZaloAllowFromEntries({
        profile,
        entries: [entry, "Không Tồn Tại"],
      });
      expect(resolved).toEqual([
        { input: entry, resolved: true, id: "123" },
        { input: "Không Tồn Tại", resolved: false },
      ]);
    },
  );
});
