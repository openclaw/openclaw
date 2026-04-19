/** Member module — group member recording and querying with GroupMember (API) and SessionMember (cache). */

import { getActiveWsClient } from "../../access/ws/runtime.js";
import { createLog } from "../../logger.js";

export type UserRecord = {
  userId: string;
  nickName: string;
  lastSeen: number;
  userType?: number;
};

// SessionMember — Group active user submodule (session cache layer)

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class SessionMember {
  private groupUsers = new Map<string, Map<string, UserRecord>>();
  private log = createLog("member:session");

  recordUser(groupCode: string, userId: string, nickName: string): void {
    if (!userId) {
      return;
    }

    if (!this.groupUsers.has(groupCode)) {
      this.groupUsers.set(groupCode, new Map());
    }

    const users = this.groupUsers.get(groupCode)!;
    users.set(userId, {
      userId,
      nickName: nickName || "unknown",
      lastSeen: Date.now(),
    });

    this.cleanExpired();

    this.log.debug(`recorded user: ${nickName ?? "?"} (${userId}) in group=${groupCode}`);
  }

  lookupUsers(groupCode: string, nameFilter?: string): UserRecord[] {
    const users = this.groupUsers.get(groupCode);
    if (!users || users.size === 0) {
      return [];
    }

    let results = Array.from(users.values());

    if (nameFilter) {
      const filter = nameFilter.trim().toLowerCase();
      results = results.filter((u) => u.nickName.toLowerCase().includes(filter));
    }

    results.sort((a, b) => b.lastSeen - a.lastSeen);

    return results;
  }

  lookupUserByNickName(groupCode: string, nickName: string): UserRecord | undefined {
    const users = this.groupUsers.get(groupCode);
    if (!users || users.size === 0) {
      return undefined;
    }

    const target = nickName.trim().toLowerCase();
    for (const record of users.values()) {
      if (record.nickName.toLowerCase() === target) {
        return record;
      }
    }
    return undefined;
  }

  lookupUserById(groupCode: string, userId: string): UserRecord | undefined {
    const users = this.groupUsers.get(groupCode);
    return users?.get(userId);
  }

  upsertUser(groupCode: string, record: UserRecord): void {
    if (!this.groupUsers.has(groupCode)) {
      this.groupUsers.set(groupCode, new Map());
    }
    this.groupUsers.get(groupCode)!.set(record.userId, record);
  }

  listGroupCodes(): string[] {
    return Array.from(this.groupUsers.keys());
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [code, users] of this.groupUsers) {
      for (const [id, record] of users) {
        if (now - record.lastSeen > SESSION_TTL_MS) {
          users.delete(id);
        }
      }
      if (users.size === 0) {
        this.groupUsers.delete(code);
      }
    }
  }
}

// GroupMember — API member submodule (WS API layer)

const GROUP_CACHE_TTL_MS = 5 * 60 * 1000;

type GroupMemberCache = {
  members: UserRecord[];
  fetchedAt: number;
};

type GroupOwnerInfo = {
  userId: string;
  nickName: string;
};

/** Full group info (from queryGroupInfo API) */
export interface GroupInfoData {
  groupName: string;
  ownerUserId: string;
  ownerNickName: string;
  groupSize: number;
}
type GroupOwnerCache = {
  owner: GroupOwnerInfo;
  fetchedAt: number;
};

type GroupInfoCache = {
  info: GroupInfoData;
  fetchedAt: number;
};

export class GroupMember {
  private readonly accountId: string;
  private readonly sessionMember: SessionMember;
  private cache = new Map<string, GroupMemberCache>();
  private ownerCache = new Map<string, GroupOwnerCache>();
  private infoCache = new Map<string, GroupInfoCache>();
  private log = createLog("member:group");

  constructor(accountId: string, sessionMember: SessionMember) {
    this.accountId = accountId;
    this.sessionMember = sessionMember;
  }

  async getMembers(groupCode: string): Promise<UserRecord[]> {
    const cached = this.cache.get(groupCode);
    if (cached && Date.now() - cached.fetchedAt < GROUP_CACHE_TTL_MS) {
      this.log.debug(`cache hit for group=${groupCode}, ${cached.members.length} members`);
      return cached.members;
    }

    // Cache expired or missing, try to fetch
    const fetched = await this.fetchFromApi(groupCode);
    if (fetched.length > 0) {
      this.cache.set(groupCode, { members: fetched, fetchedAt: Date.now() });
      return fetched;
    }

    // Fetch failed; return stale cache if available (better than empty)
    if (cached) {
      this.log.debug(`fetch failed, returning stale cache for group=${groupCode}`);
      return cached.members;
    }

    return [];
  }

  lookupUsers(groupCode: string, nameFilter?: string): UserRecord[] {
    const cached = this.cache.get(groupCode);
    if (!cached) {
      return [];
    }

    let results = cached.members;

    if (nameFilter) {
      const filter = nameFilter.trim().toLowerCase();
      results = results.filter((u) => u.nickName.toLowerCase().includes(filter));
    }

    return results;
  }

  lookupUserByNickName(groupCode: string, nickName: string): UserRecord | undefined {
    const cached = this.cache.get(groupCode);
    if (!cached) {
      return undefined;
    }

    const target = nickName.trim().toLowerCase();
    return cached.members.find((u) => u.nickName.toLowerCase() === target);
  }

  hasCachedData(groupCode: string): boolean {
    return this.cache.has(groupCode);
  }

  async refresh(groupCode: string): Promise<UserRecord[]> {
    this.cache.delete(groupCode);
    return this.getMembers(groupCode);
  }

  async queryGroupOwner(groupCode: string): Promise<GroupOwnerInfo | null> {
    const cached = this.ownerCache.get(groupCode);
    if (cached && Date.now() - cached.fetchedAt < GROUP_CACHE_TTL_MS) {
      this.log.debug(`owner cache hit for group=${groupCode}`);
      return cached.owner;
    }

    // Get wsClient
    const wsClient = getActiveWsClient(this.accountId);
    if (!wsClient) {
      this.log.warn(`no active wsClient for account=${this.accountId}, skip queryGroupOwner`);
      return cached?.owner ?? null;
    }

    if (wsClient.getState() !== "connected") {
      this.log.warn(`wsClient not connected (state=${wsClient.getState()}), skip queryGroupOwner`);
      return cached?.owner ?? null;
    }

    try {
      this.log.debug(`querying group info: account=${this.accountId}, group=${groupCode}`);
      const rsp = await wsClient.queryGroupInfo({ group_code: groupCode });

      if (rsp.code !== 0 || !rsp.group_info) {
        this.log.warn(`queryGroupInfo failed: code=${rsp.code}, msg=${rsp.msg}`);
        return cached?.owner ?? null;
      }

      const owner: GroupOwnerInfo = {
        userId: rsp.group_info.group_owner_user_id,
        nickName: rsp.group_info.group_owner_nickname || "unknown",
      };

      this.log.info(`group owner: ${owner.nickName} (${owner.userId}) for group=${groupCode}`);
      this.ownerCache.set(groupCode, { owner, fetchedAt: Date.now() });
      return owner;
    } catch (err) {
      this.log.error(`queryGroupInfo error: ${err instanceof Error ? err.message : String(err)}`);
      return cached?.owner ?? null;
    }
  }

  async queryGroupInfo(groupCode: string): Promise<GroupInfoData | null> {
    const cached = this.infoCache.get(groupCode);
    if (cached && Date.now() - cached.fetchedAt < GROUP_CACHE_TTL_MS) {
      this.log.debug(`group info cache hit for group=${groupCode}`);
      return cached.info;
    }

    // Get wsClient
    const wsClient = getActiveWsClient(this.accountId);
    if (!wsClient) {
      this.log.warn(`no active wsClient for account=${this.accountId}, skip queryGroupInfo`);
      return cached?.info ?? null;
    }

    if (wsClient.getState() !== "connected") {
      this.log.warn(`wsClient not connected (state=${wsClient.getState()}), skip queryGroupInfo`);
      return cached?.info ?? null;
    }

    try {
      this.log.debug(`querying full group info: account=${this.accountId}, group=${groupCode}`);
      const rsp = await wsClient.queryGroupInfo({ group_code: groupCode });

      if (rsp.code !== 0 || !rsp.group_info) {
        this.log.warn(`queryGroupInfo failed: code=${rsp.code}, msg=${rsp.msg}`);
        return cached?.info ?? null;
      }

      const info: GroupInfoData = {
        groupName: rsp.group_info.group_name || "unknown",
        ownerUserId: rsp.group_info.group_owner_user_id,
        ownerNickName: rsp.group_info.group_owner_nickname || "unknown",
        groupSize: rsp.group_info.group_size ?? 0,
      };

      this.log.info(
        `group info: name=${info.groupName}, size=${info.groupSize}, owner=${info.ownerNickName} for group=${groupCode}`,
      );
      this.infoCache.set(groupCode, { info, fetchedAt: Date.now() });

      // Also update ownerCache
      const owner: GroupOwnerInfo = { userId: info.ownerUserId, nickName: info.ownerNickName };
      this.ownerCache.set(groupCode, { owner, fetchedAt: Date.now() });

      return info;
    } catch (err) {
      this.log.error(
        `queryGroupInfo (full) error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return cached?.info ?? null;
    }
  }

  private async fetchFromApi(groupCode: string): Promise<UserRecord[]> {
    const wsClient = getActiveWsClient(this.accountId);
    if (!wsClient) {
      this.log.warn(`no active wsClient for account=${this.accountId}, skip fetch`);
      return [];
    }

    if (wsClient.getState() !== "connected") {
      this.log.warn(`wsClient not connected (state=${wsClient.getState()}), skip fetch`);
      return [];
    }

    try {
      this.log.debug(`fetching group members: account=${this.accountId}, group=${groupCode}`);
      const rsp = await wsClient.getGroupMemberList({ group_code: groupCode });

      if (rsp.code !== 0) {
        this.log.warn(`getGroupMemberList failed: code=${rsp.code}, msg=${rsp.message}`);
        return [];
      }

      const apiMembers = rsp.member_list ?? [];
      this.log.info(`got ${apiMembers.length} members from API for group=${groupCode}`);

      // Convert to UserRecord and sync to SessionMember
      const now = Date.now();
      const records: UserRecord[] = [];

      for (const m of apiMembers) {
        const existing = this.sessionMember.lookupUserById(groupCode, m.user_id);
        const record: UserRecord = {
          userId: m.user_id,
          nickName: m.nick_name || existing?.nickName || "unknown",
          lastSeen: existing?.lastSeen ?? now,
          userType: m.user_type,
        };
        // Sync to SessionMember to keep both layers consistent
        this.sessionMember.upsertUser(groupCode, record);
        records.push(record);
      }

      return records;
    } catch (err) {
      this.log.error(
        `getGroupMemberList error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }
}

// Member — Facade

export type FormattedUserRecord = {
  userId: string;
  nickName: string;
  lastSeen: string;
};

export class Member {
  readonly accountId: string;
  readonly session = new SessionMember();
  readonly group: GroupMember;
  private log = createLog("member");
  /** Fixed per environment, reused after first query */
  private yuanbaoUserIdCache: string | null = null;

  constructor(accountId: string) {
    this.accountId = accountId;
    this.group = new GroupMember(accountId, this.session);
  }

  recordUser(groupCode: string, userId: string, nickName: string): void {
    this.session.recordUser(groupCode, userId, nickName);
  }

  async queryMembers(groupCode: string, nameFilter?: string): Promise<UserRecord[]> {
    // Prioritize GroupMember
    const groupMembers = await this.group.getMembers(groupCode);
    if (groupMembers.length > 0) {
      if (!nameFilter) {
        return groupMembers;
      }

      const filter = nameFilter.trim().toLowerCase();
      const filtered = groupMembers.filter((u) => u.nickName.toLowerCase().includes(filter));
      if (filtered.length > 0) {
        return filtered;
      }
    }

    // Fall back to SessionMember
    this.log.debug(
      `GroupMember empty or no match, fallback to SessionMember for group=${groupCode}`,
    );
    return this.session.lookupUsers(groupCode, nameFilter);
  }

  lookupUsers(groupCode: string, nameFilter?: string): UserRecord[] {
    // Prioritize GroupMember cache
    const groupResults = this.group.lookupUsers(groupCode, nameFilter);
    if (groupResults.length > 0) {
      return groupResults;
    }

    // Fall back to SessionMember
    return this.session.lookupUsers(groupCode, nameFilter);
  }

  lookupUserByNickName(groupCode: string, nickName: string): UserRecord | undefined {
    // Prioritize GroupMember cache
    return (
      this.group.lookupUserByNickName(groupCode, nickName) ??
      this.session.lookupUserByNickName(groupCode, nickName)
    );
  }

  async queryGroupOwner(groupCode: string): Promise<GroupOwnerInfo | null> {
    return this.group.queryGroupOwner(groupCode);
  }

  async queryGroupInfo(groupCode: string): Promise<GroupInfoData | null> {
    return this.group.queryGroupInfo(groupCode);
  }

  async queryYuanbaoUserId(groupCode?: string): Promise<string | null> {
    if (this.yuanbaoUserIdCache) {
      return this.yuanbaoUserIdCache;
    }

    if (!groupCode) {
      this.log.debug("queryYuanbaoUserId skipped: no cache and no groupCode");
      return null;
    }

    const members = await this.group.getMembers(groupCode);
    // userType: 2=yuanbao, 3=bot; prefer yuanbao, bot as fallback
    const yuanbao = members.find((u) => u.userType === 2) ?? members.find((u) => u.userType === 3);
    if (!yuanbao?.userId) {
      this.log.warn(`queryYuanbaoUserId failed: no yuanbao/bot found in group=${groupCode}`);
      return null;
    }

    this.yuanbaoUserIdCache = yuanbao.userId;
    this.log.info(`cached yuanbaoUserId=${yuanbao.userId} from group=${groupCode}`);
    return this.yuanbaoUserIdCache;
  }

  listGroupCodes(): string[] {
    return this.session.listGroupCodes();
  }

  formatRecords(records: UserRecord[]): FormattedUserRecord[] {
    return records.map((u) => ({
      userId: u.userId,
      nickName: u.nickName,
      lastSeen: new Date(u.lastSeen).toISOString(),
    }));
  }
}

// Multi-instance Runtime — Managed by accountId

const activeMembers = new Map<string, Member>();
const runtimeLog = createLog("member:runtime");

export function getMember(accountId: string): Member {
  let inst = activeMembers.get(accountId);
  if (!inst) {
    inst = new Member(accountId);
    activeMembers.set(accountId, inst);
    runtimeLog.debug(`created Member instance for account=${accountId}`);
  }
  return inst;
}

export function removeMember(accountId: string): void {
  activeMembers.delete(accountId);
  runtimeLog.debug(`removed Member instance for account=${accountId}`);
}

export function getAllActiveMembers(): ReadonlyMap<string, Member> {
  return activeMembers;
}
