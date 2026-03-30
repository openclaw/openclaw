import { inspectMatrixDirectRoomEvidence } from "./direct-room.js";
import type { MatrixClient } from "./sdk.js";
import { EventType, type MatrixDirectAccountData } from "./send/types.js";
import { isMatrixQualifiedUserId } from "./target-ids.js";

export type MatrixDirectRoomCandidate = {
  roomId: string;
  joinedMembers: string[] | null;
  strict: boolean;
  explicit: boolean;
  source: "account-data" | "joined";
};

export type MatrixDirectRoomInspection = {
  selfUserId: string | null;
  remoteUserId: string;
  mappedRoomIds: string[];
  mappedRooms: MatrixDirectRoomCandidate[];
  discoveredStrictRoomIds: string[];
  activeRoomId: string | null;
};

export type MatrixDirectRoomRepairResult = MatrixDirectRoomInspection & {
  createdRoomId: string | null;
  changed: boolean;
  directContentBefore: MatrixDirectAccountData;
  directContentAfter: MatrixDirectAccountData;
};

async function readMatrixDirectAccountData(client: MatrixClient): Promise<MatrixDirectAccountData> {
  try {
    const direct = (await client.getAccountData(EventType.Direct)) as MatrixDirectAccountData;
    return direct && typeof direct === "object" && !Array.isArray(direct) ? direct : {};
  } catch {
    return {};
  }
}

function normalizeRemoteUserId(remoteUserId: string): string {
  const normalized = remoteUserId.trim();
  if (!isMatrixQualifiedUserId(normalized)) {
    throw new Error(`Matrix user IDs must be fully qualified (got "${remoteUserId}")`);
  }
  return normalized;
}

function normalizeMappedRoomIds(direct: MatrixDirectAccountData, remoteUserId: string): string[] {
  const current = direct[remoteUserId];
  if (!Array.isArray(current)) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of current) {
    const roomId = typeof value === "string" ? value.trim() : "";
    if (!roomId || seen.has(roomId)) {
      continue;
    }
    seen.add(roomId);
    normalized.push(roomId);
  }
  return normalized;
}

function normalizeRoomIdList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const roomId = value.trim();
    if (!roomId || seen.has(roomId)) {
      continue;
    }
    seen.add(roomId);
    normalized.push(roomId);
  }
  return normalized;
}

async function classifyDirectRoomCandidate(params: {
  client: MatrixClient;
  roomId: string;
  remoteUserId: string;
  selfUserId: string | null;
  source: "account-data" | "joined";
}): Promise<MatrixDirectRoomCandidate> {
  const evidence = await inspectMatrixDirectRoomEvidence({
    client: params.client,
    roomId: params.roomId,
    remoteUserId: params.remoteUserId,
    selfUserId: params.selfUserId,
  });
  return {
    roomId: params.roomId,
    joinedMembers: evidence.joinedMembers,
    strict:
      evidence.strict && (params.source === "account-data" || evidence.memberStateFlag !== false),
    explicit:
      evidence.strict &&
      (params.source === "account-data" || evidence.memberStateFlag !== false) &&
      (params.source === "account-data" || evidence.viaMemberState),
    source: params.source,
  };
}

function buildNextDirectContent(params: {
  directContent: MatrixDirectAccountData;
  remoteUserId: string;
  roomId: string;
}): MatrixDirectAccountData {
  const current = normalizeMappedRoomIds(params.directContent, params.remoteUserId);
  const nextRooms = normalizeRoomIdList([params.roomId, ...current]);
  return {
    ...params.directContent,
    [params.remoteUserId]: nextRooms,
  };
}

export async function persistMatrixDirectRoomMapping(params: {
  client: MatrixClient;
  remoteUserId: string;
  roomId: string;
}): Promise<boolean> {
  const remoteUserId = normalizeRemoteUserId(params.remoteUserId);
  const directContent = await readMatrixDirectAccountData(params.client);
  const current = normalizeMappedRoomIds(directContent, remoteUserId);
  if (current[0] === params.roomId) {
    return false;
  }
  await params.client.setAccountData(
    EventType.Direct,
    buildNextDirectContent({
      directContent,
      remoteUserId,
      roomId: params.roomId,
    }),
  );
  return true;
}

export async function inspectMatrixDirectRooms(params: {
  client: MatrixClient;
  remoteUserId: string;
}): Promise<MatrixDirectRoomInspection> {
  const remoteUserId = normalizeRemoteUserId(params.remoteUserId);
  const selfUserId = (await params.client.getUserId().catch(() => null))?.trim() || null;
  const directContent = await readMatrixDirectAccountData(params.client);
  const mappedRoomIds = normalizeMappedRoomIds(directContent, remoteUserId);
  const mappedRooms = await Promise.all(
    mappedRoomIds.map(
      async (roomId) =>
        await classifyDirectRoomCandidate({
          client: params.client,
          roomId,
          remoteUserId,
          selfUserId,
          source: "account-data",
        }),
    ),
  );
  const mappedStrict = mappedRooms.find((room) => room.strict);

  let joinedRooms: string[] = [];
  if (!mappedStrict && typeof params.client.getJoinedRooms === "function") {
    try {
      const resolved = await params.client.getJoinedRooms();
      joinedRooms = Array.isArray(resolved) ? resolved : [];
    } catch {
      joinedRooms = [];
    }
  }
  const discoveredStrictRooms: MatrixDirectRoomCandidate[] = [];
  for (const roomId of normalizeRoomIdList(joinedRooms)) {
    if (mappedRoomIds.includes(roomId)) {
      continue;
    }
    const candidate = await classifyDirectRoomCandidate({
      client: params.client,
      roomId,
      remoteUserId,
      selfUserId,
      source: "joined",
    });
    if (candidate.strict) {
      discoveredStrictRooms.push(candidate);
    }
  }
  const discoveredStrictRoomIds = discoveredStrictRooms.map((room) => room.roomId);
  const discoveredExplicit = discoveredStrictRooms.find((room) => room.explicit);

  return {
    selfUserId,
    remoteUserId,
    mappedRoomIds,
    mappedRooms,
    discoveredStrictRoomIds,
    activeRoomId:
      mappedStrict?.roomId ?? discoveredExplicit?.roomId ?? discoveredStrictRoomIds[0] ?? null,
  };
}

export async function repairMatrixDirectRooms(params: {
  client: MatrixClient;
  remoteUserId: string;
  encrypted?: boolean;
}): Promise<MatrixDirectRoomRepairResult> {
  const remoteUserId = normalizeRemoteUserId(params.remoteUserId);
  const directContentBefore = await readMatrixDirectAccountData(params.client);
  const inspected = await inspectMatrixDirectRooms({
    client: params.client,
    remoteUserId,
  });
  const activeRoomId =
    inspected.activeRoomId ??
    (await params.client.createDirectRoom(remoteUserId, {
      encrypted: params.encrypted === true,
    }));
  const createdRoomId = inspected.activeRoomId ? null : activeRoomId;
  const directContentAfter = buildNextDirectContent({
    directContent: directContentBefore,
    remoteUserId,
    roomId: activeRoomId,
  });
  const changed =
    JSON.stringify(directContentAfter[remoteUserId] ?? []) !==
    JSON.stringify(directContentBefore[remoteUserId] ?? []);
  if (changed) {
    await persistMatrixDirectRoomMapping({
      client: params.client,
      remoteUserId,
      roomId: activeRoomId,
    });
  }
  return {
    ...inspected,
    activeRoomId,
    createdRoomId,
    changed,
    directContentBefore,
    directContentAfter,
  };
}
