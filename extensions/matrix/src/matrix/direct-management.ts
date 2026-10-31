import { enqueueKeyedTask } from "openclaw/plugin-sdk/keyed-async-queue";
import {
  normalizeOptionalString,
  normalizeUniqueTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
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

const directAccountDataWriteQueues = new WeakMap<MatrixClient, Promise<void>>();

async function readMatrixDirectAccountData(client: MatrixClient): Promise<MatrixDirectAccountData> {
  const direct = (await client.getAccountData(EventType.Direct)) as MatrixDirectAccountData;
  return direct && typeof direct === "object" && !Array.isArray(direct) ? direct : {};
}

function normalizeRemoteUserId(remoteUserId: string): string {
  const normalized = normalizeOptionalString(remoteUserId) ?? "";
  if (!isMatrixQualifiedUserId(normalized)) {
    throw new Error(`Matrix user IDs must be fully qualified (got "${remoteUserId}")`);
  }
  return normalized;
}

async function writeMatrixDirectRoomMappings(params: {
  client: MatrixClient;
  remoteUserId: string;
  roomIds: readonly string[];
}) {
  return await enqueueKeyedTask({
    tails: directAccountDataWriteQueues,
    key: params.client,
    task: async () => {
      const directContentBefore = await readMatrixDirectAccountData(params.client);
      const current = normalizeUniqueTrimmedStringList(directContentBefore[params.remoteUserId]);
      const next = normalizeUniqueTrimmedStringList([...params.roomIds, ...current]);
      const directContentAfter = { ...directContentBefore, [params.remoteUserId]: next };
      const changed =
        current.length !== next.length || current.some((roomId, index) => roomId !== next[index]);
      if (changed) {
        await params.client.setAccountData(EventType.Direct, directContentAfter);
      }
      return {
        changed,
        directContentBefore,
        directContentAfter,
      };
    },
  });
}

export async function persistMatrixDirectRoomMapping(params: {
  client: MatrixClient;
  remoteUserId: string;
  roomId: string;
}): Promise<boolean> {
  const remoteUserId = normalizeRemoteUserId(params.remoteUserId);
  return (
    await writeMatrixDirectRoomMappings({
      client: params.client,
      remoteUserId,
      roomIds: [params.roomId],
    })
  ).changed;
}

export async function promoteMatrixDirectRoomCandidate(params: {
  client: MatrixClient;
  remoteUserId: string;
  roomId: string;
  selfUserId?: string | null;
}) {
  const remoteUserId = normalizeRemoteUserId(params.remoteUserId);
  const evidence = await inspectMatrixDirectRoomEvidence({
    client: params.client,
    roomId: params.roomId,
    remoteUserId,
    selfUserId: params.selfUserId,
  });
  if (!evidence.strict || evidence.memberStateFlag === false) {
    return {
      classifyAsDirect: false,
      repaired: false,
      reason: evidence.strict ? "local-explicit-false" : "not-strict",
    } as const;
  }

  try {
    const repaired = await persistMatrixDirectRoomMapping({
      client: params.client,
      remoteUserId,
      roomId: params.roomId,
    });
    return {
      classifyAsDirect: true,
      repaired,
      reason: repaired ? "promoted" : "already-mapped",
    } as const;
  } catch {
    return {
      classifyAsDirect: true,
      repaired: false,
      reason: "repair-failed",
    } as const;
  }
}

export async function inspectMatrixDirectRooms(params: {
  client: MatrixClient;
  remoteUserId: string;
}) {
  const remoteUserId = normalizeRemoteUserId(params.remoteUserId);
  const selfUserId =
    normalizeOptionalString(await params.client.getUserId().catch(() => null)) ?? null;
  const classifyRoom = async (
    roomId: string,
    source: MatrixDirectRoomCandidate["source"],
  ): Promise<MatrixDirectRoomCandidate> => {
    const evidence = await inspectMatrixDirectRoomEvidence({
      client: params.client,
      roomId,
      remoteUserId,
      selfUserId,
    });
    const strict =
      evidence.strict && (source === "account-data" || evidence.memberStateFlag !== false);
    return {
      roomId,
      joinedMembers: evidence.joinedMembers,
      strict,
      explicit: strict && (source === "account-data" || evidence.viaMemberState),
      source,
    };
  };
  const directContent: MatrixDirectAccountData = await readMatrixDirectAccountData(
    params.client,
  ).catch(() => ({}));
  const mappedRoomIds = normalizeUniqueTrimmedStringList(directContent[remoteUserId]);
  const mappedRooms = await Promise.all(
    mappedRoomIds.map(async (roomId) => await classifyRoom(roomId, "account-data")),
  );
  const mappedStrict = mappedRooms.find((room) => room.strict);

  const joinedRooms = await params.client.getJoinedRooms().catch(() => []);
  const discoveredStrictRooms: MatrixDirectRoomCandidate[] = [];
  for (const roomId of normalizeUniqueTrimmedStringList(joinedRooms)) {
    if (mappedRoomIds.includes(roomId)) {
      continue;
    }
    const candidate = await classifyRoom(roomId, "joined");
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
}) {
  const remoteUserId = normalizeRemoteUserId(params.remoteUserId);
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
  const mappingWrite = await writeMatrixDirectRoomMappings({
    client: params.client,
    remoteUserId,
    roomIds: [activeRoomId, ...inspected.discoveredStrictRoomIds],
  });
  return {
    ...inspected,
    activeRoomId,
    createdRoomId,
    changed: mappingWrite.changed,
    directContentBefore: mappingWrite.directContentBefore,
    directContentAfter: mappingWrite.directContentAfter,
  };
}
