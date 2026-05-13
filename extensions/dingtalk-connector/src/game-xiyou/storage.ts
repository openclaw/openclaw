/**
 * JSON 持久化层
 *
 * 所有养成数据存储在 ~/.dingtalk-connector/gamification/ 目录下，
 * 按 UID 哈希分文件存储，支持 profile / collection / history 三类数据。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHmac } from 'crypto';
import type {
  UserProfile, UserCollection, UserHistory, GamificationSettings, PityCounters,
  BountyHistory, ActiveEventState, EventStats,
} from './types.ts';
import { createDefaultBountyHistory } from './bounty-system.ts';
import { createDefaultActiveEventState, createDefaultEventStats } from './random-event-engine.ts';

const STORAGE_DIR = path.join(os.homedir(), '.dingtalk-connector', 'gamification');
const CHECKSUM_SECRET = 'xiyou-hmac-secret-2026';

function ensureStorageDir(): void {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

function getProfilePath(uidHash: string): string {
  return path.join(STORAGE_DIR, `profile-${uidHash}.json`);
}

function getCollectionPath(uidHash: string): string {
  return path.join(STORAGE_DIR, `collection-${uidHash}.json`);
}

function getHistoryPath(uidHash: string): string {
  return path.join(STORAGE_DIR, `history-${uidHash}.json`);
}

// ============ Checksum ============

function computeChecksum(profile: Omit<UserProfile, 'checksum'>): string {
  const payload = `${profile.uidHash}:${profile.totalExp}:${profile.level}:${profile.totalOperations}`;
  return createHmac('sha256', CHECKSUM_SECRET).update(payload).digest('hex').slice(0, 32);
}

export function verifyChecksum(profile: UserProfile): boolean {
  const expected = computeChecksum(profile);
  return profile.checksum === expected;
}

// ============ Profile ============

function createDefaultProfile(uidHash: string): UserProfile {
  const defaultSettings: GamificationSettings = {
    enabled: false,
    showDropAnimation: true,
    muteNormalDrops: false,
  };

  const defaultPity: PityCounters = {
    sinceLastRare: 0,
    sinceLastEpic: 0,
    sinceLastLegendary: 0,
    totalDropsWithoutShiny: 0,
  };

  const profile: Omit<UserProfile, 'checksum'> = {
    uidHash,
    level: 1,
    title: '凡人',
    totalExp: 0,
    totalOperations: 0,
    currentCombo: 0,
    maxCombo: 0,
    consecutiveSignInDays: 0,
    lastSignInDate: '',
    totalRecoveries: 0,
    consecutiveFailures: 0,
    productUsage: {},
    pityCounters: defaultPity,
    buffs: [],
    settings: defaultSettings,
    encounters: [],
    unlockedAchievements: [],
    treasures: [],
    consumedTreasures: [],
    createdAt: Date.now(),
    // v2 字段
    escapeHistory: {},
    totalEscapes: 0,
    dailyBounty: null,
    bountyHistory: createDefaultBountyHistory(),
    activeEvents: createDefaultActiveEventState(),
    eventStats: createDefaultEventStats(),
    eventHistory: [],
  };

  return { ...profile, checksum: computeChecksum(profile) };
}

export function loadProfile(uidHash: string): UserProfile {
  ensureStorageDir();
  const filePath = getProfilePath(uidHash);

  if (!fs.existsSync(filePath)) {
    const profile = createDefaultProfile(uidHash);
    saveProfile(profile);
    return profile;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const profile = JSON.parse(raw) as UserProfile;
    return migrateProfile(profile);
  } catch {
    const profile = createDefaultProfile(uidHash);
    saveProfile(profile);
    return profile;
  }
}

/**
 * 补全旧版本 profile 中缺失的 v2 字段，确保向后兼容
 */
function migrateProfile(profile: UserProfile): UserProfile {
  let migrated = false;

  if (!profile.escapeHistory) { profile.escapeHistory = {}; migrated = true; }
  if (profile.totalEscapes == null) { profile.totalEscapes = 0; migrated = true; }
  if (profile.dailyBounty === undefined) { profile.dailyBounty = null; migrated = true; }
  if (!profile.bountyHistory) { profile.bountyHistory = createDefaultBountyHistory(); migrated = true; }
  if (!profile.activeEvents) { profile.activeEvents = createDefaultActiveEventState(); migrated = true; }
  if (!profile.eventStats) { profile.eventStats = createDefaultEventStats(); migrated = true; }
  if (!profile.eventHistory) { profile.eventHistory = []; migrated = true; }

  if (migrated) {
    saveProfile(profile);
  }

  return profile;
}

export function saveProfile(profile: UserProfile): void {
  ensureStorageDir();
  const withChecksum: UserProfile = {
    ...profile,
    checksum: computeChecksum(profile),
  };
  const filePath = getProfilePath(profile.uidHash);
  fs.writeFileSync(filePath, JSON.stringify(withChecksum, null, 2), 'utf-8');
}

// ============ Collection ============

function createDefaultCollection(uidHash: string): UserCollection {
  return { uidHash, entries: [] };
}

export function loadCollection(uidHash: string): UserCollection {
  ensureStorageDir();
  const filePath = getCollectionPath(uidHash);

  if (!fs.existsSync(filePath)) {
    const collection = createDefaultCollection(uidHash);
    saveCollection(collection);
    return collection;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as UserCollection;
  } catch {
    const collection = createDefaultCollection(uidHash);
    saveCollection(collection);
    return collection;
  }
}

export function saveCollection(collection: UserCollection): void {
  ensureStorageDir();
  const filePath = getCollectionPath(collection.uidHash);
  fs.writeFileSync(filePath, JSON.stringify(collection, null, 2), 'utf-8');
}

// ============ History ============

const MAX_HISTORY_RECORDS = 500;

function createDefaultHistory(uidHash: string): UserHistory {
  return { uidHash, records: [] };
}

export function loadHistory(uidHash: string): UserHistory {
  ensureStorageDir();
  const filePath = getHistoryPath(uidHash);

  if (!fs.existsSync(filePath)) {
    return createDefaultHistory(uidHash);
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as UserHistory;
  } catch {
    return createDefaultHistory(uidHash);
  }
}

export function saveHistory(history: UserHistory): void {
  ensureStorageDir();
  // 只保留最近 500 条
  if (history.records.length > MAX_HISTORY_RECORDS) {
    history.records = history.records.slice(-MAX_HISTORY_RECORDS);
  }
  const filePath = getHistoryPath(history.uidHash);
  fs.writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf-8');
}
