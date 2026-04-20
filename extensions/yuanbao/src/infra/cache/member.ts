/** Member module — group member recording and querying with GroupMember (API) and SessionMember (cache). */

import { getActiveWsClient } from "../../access/ws/runtime.js";
import { createLog } from "../../logger.js";

export type UserRecord = {
  userId: string;
  nickName: string;
  lastSeen: number;
  userType?: number;
};

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
    this.groupUsers
      .get(groupCode)!
      .set(userId, { userId, nickName: nickName || "unknown", lastSeen: Date.now() });
    this.cleanExpired();
  }

  lookupUsers(groupCode: string, nameFilter?: string): UserRecord[] {
    const users = this.groupUsers.get(groupCode);
    if (!users || users.size === 0) {
      return [];
    }
    let results = Array.from(users.values());
    if (nameFilter) {
      const f = nameFilter.trim().toLowerCase();
      results = results.filter((u) => u.nickName.toLowerCase().includes(f));
    }
    return results.toSorted((a, b) => b.lastSeen - a.lastSeen);
  }

  lookupUserByNickName(groupCode: string, nickName: string): UserRecord | undefined {
    const users = this.groupUsers.get(groupCode);
    if (!users) {
      return undefined;
    }
    const target = nickName.trim().toLowerCase();
    for (const r of users.values()) {
      if (r.nickName.toLowerCase() === target) {
        return r;
      }
    }
    return undefined;
  }

  lookupUserById(groupCode: string, userId: string): UserRecord | undefined {
    return this.groupUsers.get(groupCode)?.get(userId);
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
      for (const [id, r] of users) {
        if (now - r.lastSeen > SESSION_TTL_MS) {
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

type GroupOwnerInfo = { userId: string; nickName: string };

export interface GroupInfoData {
  groupName: string;
  ownerUserId: string;
  ownerNickName: string;
  groupSize: number;
}

type GroupOwnerCache = { owner: GroupOwnerInfo; fetchedAt: number };
type GroupInfoCache = { info: GroupInfoData; fetchedAt: number };

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
      return cached.members;
    }
    const fetched = await this.fetchFromApi(groupCode);
    if (fetched.length > 0) {
      this.cache.set(groupCode, { members: fetched, fetchedAt: Date.now() });
      return fetched;
    }
    return cached?.members ?? [];
  }

  lookupUsers(groupCode: string, nameFilter?: string): UserRecord[] {
    const cached = this.cache.get(groupCode);
    if (!cached) {
      return [];
    }
    if (!nameFilter) {
      return cached.members;
    }
    const f = nameFilter.trim().toLowerCase();
    return cached.members.filter((u) => u.nickName.toLowerCase().includes(f));
  }

  lookupUserByNickName(groupCode: string, nickName: string): UserRecord | undefined {
    const target = nickName.trim().toLowerCase();
    return this.cache.get(groupCode)?.members.find((u) => u.nickName.toLowerCase() === target);
  }

  hasCachedData(groupCode: string): boolean {
    return this.cache.has(groupCode);
  }

  async refresh(groupCode: string): Promise<UserRecord[]> {
    this.cache.delete(groupCode);
    return this.getMembers(groupCode);
  }

  private getWsClient(): ReturnType<typeof getActiveWsClient> | null {
    const ws = getActiveWsClient(this.accountId);
    if (!ws || ws.getState() !== "connected") {
      return null;
    }
    return ws;
  }

  async queryGroupOwner(groupCode: string): Promise<GroupOwnerInfo | null> {
    const cached = this.ownerCache.get(groupCode);
    if (cached && Date.now() - cached.fetchedAt < GROUP_CACHE_TTL_MS) {
      return cached.owner;
    }
    const ws = this.getWsClient();
    if (!ws) {
      return cached?.owner ?? null;
    }
    try {
      const rsp = await ws.queryGroupInfo({ group_code: groupCode });
      if (rsp.code !== 0 || !rsp.group_info) {
        return cached?.owner ?? null;
      }
      const owner: GroupOwnerInfo = {
        userId: rsp.group_info.group_owner_user_id,
        nickName: rsp.group_info.group_owner_nickname || "unknown",
      };
      this.ownerCache.set(groupCode, { owner, fetchedAt: Date.now() });
      return owner;
    } catch {
      return cached?.owner ?? null;
    }
  }

  async queryGroupInfo(groupCode: string): Promise<GroupInfoData | null> {
    const cached = this.infoCache.get(groupCode);
    if (cached && Date.now() - cached.fetchedAt < GROUP_CACHE_TTL_MS) {
      return cached.info;
    }
    const ws = this.getWsClient();
    if (!ws) {
      return cached?.info ?? null;
    }
    try {
      const rsp = await ws.queryGroupInfo({ group_code: groupCode });
      if (rsp.code !== 0 || !rsp.group_info) {
        return cached?.info ?? null;
      }
      const info: GroupInfoData = {
        groupName: rsp.group_info.group_name || "unknown",
        ownerUserId: rsp.group_info.group_owner_user_id,
        ownerNickName: rsp.group_info.group_owner_nickname || "unknown",
        groupSize: rsp.group_info.group_size ?? 0,
      };
      this.infoCache.set(groupCode, { info, fetchedAt: Date.now() });
      this.ownerCache.set(groupCode, {
        owner: { userId: info.ownerUserId, nickName: info.ownerNickName },
        fetchedAt: Date.now(),
      });
      return info;
    } catch {
      return cached?.info ?? null;
    }
  }

  private async fetchFromApi(groupCode: string): Promise<UserRecord[]> {
    const ws = this.getWsClient();
    if (!ws) {
      return [];
    }
    try {
      const rsp = await ws.getGroupMemberList({ group_code: groupCode });
      if (rsp.code !== 0) {
        return [];
      }
      const now = Date.now();
      return (rsp.member_list ?? []).map((m) => {
        const existing = this.sessionMember.lookupUserById(groupCode, m.user_id);
        const record: UserRecord = {
          userId: m.user_id,
          nickName: m.nick_name || existing?.nickName || "unknown",
          lastSeen: existing?.lastSeen ?? now,
          userType: m.user_type,
        };
        this.sessionMember.upsertUser(groupCode, record);
        return record;
      });
    } catch {
      return [];
    }
  }
}

export type FormattedUserRecord = { userId: string; nickName: string; lastSeen: string };

export class Member {
  readonly accountId: string;
  readonly session = new SessionMember();
  readonly group: GroupMember;
  private log = createLog("member");
  private yuanbaoUserIdCache: string | null = null;

  constructor(accountId: string) {
    this.accountId = accountId;
    this.group = new GroupMember(accountId, this.session);
  }

  recordUser(groupCode: string, userId: string, nickName: string): void {
    this.session.recordUser(groupCode, userId, nickName);
  }

  async queryMembers(groupCode: string, nameFilter?: string): Promise<UserRecord[]> {
    const members = await this.group.getMembers(groupCode);
    if (members.length > 0) {
      if (!nameFilter) {
        return members;
      }
      const f = nameFilter.trim().toLowerCase();
      const filtered = members.filter((u) => u.nickName.toLowerCase().includes(f));
      if (filtered.length > 0) {
        return filtered;
      }
    }
    return this.session.lookupUsers(groupCode, nameFilter);
  }

  lookupUsers(groupCode: string, nameFilter?: string): UserRecord[] {
    return this.group.lookupUsers(groupCode, nameFilter).length > 0
      ? this.group.lookupUsers(groupCode, nameFilter)
      : this.session.lookupUsers(groupCode, nameFilter);
  }

  lookupUserByNickName(groupCode: string, nickName: string): UserRecord | undefined {
    return (
      this.group.lookupUserByNickName(groupCode, nickName) ??
      this.session.lookupUserByNickName(groupCode, nickName)
    );
  }

  queryGroupOwner(groupCode: string) {
    return this.group.queryGroupOwner(groupCode);
  }
  queryGroupInfo(groupCode: string) {
    return this.group.queryGroupInfo(groupCode);
  }

  async queryYuanbaoUserId(groupCode?: string): Promise<string | null> {
    if (this.yuanbaoUserIdCache) {
      return this.yuanbaoUserIdCache;
    }
    if (!groupCode) {
      return null;
    }
    const members = await this.group.getMembers(groupCode);
    const yuanbao = members.find((u) => u.userType === 2) ?? members.find((u) => u.userType === 3);
    if (!yuanbao?.userId) {
      return null;
    }
    this.yuanbaoUserIdCache = yuanbao.userId;
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
