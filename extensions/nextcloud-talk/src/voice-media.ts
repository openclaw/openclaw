import { constants, promises as fs } from "node:fs";
import path from "node:path";

const BOX_HEADER_BYTES = 8;
const LARGE_BOX_HEADER_BYTES = 16;
const MAX_BOX_COUNT = 4_096;
const MAX_BOX_DEPTH = 8;

type IsoBmffTrack = {
  handlerType?: string;
  sampleEntryTypes: string[];
};

type IsoBmffInspection = "audio-only-aac" | "video" | "ambiguous" | "not-isobmff";

type Box = {
  type: string;
  payloadStart: number;
  end: number;
};

type InspectionState = {
  boxCount: number;
  sawFtyp: boolean;
  tracks: IsoBmffTrack[];
};

const CONTAINER_BOX_TYPES = new Set(["moov", "mdia", "minf", "stbl"]);

async function readExactly(
  handle: Awaited<ReturnType<typeof fs.open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new Error("truncated ISO-BMFF box");
  }
  return buffer;
}

async function readBox(
  handle: Awaited<ReturnType<typeof fs.open>>,
  offset: number,
  parentEnd: number,
): Promise<Box> {
  if (parentEnd - offset < BOX_HEADER_BYTES) {
    throw new Error("truncated ISO-BMFF box header");
  }
  const header = await readExactly(handle, offset, BOX_HEADER_BYTES);
  const size32 = header.readUInt32BE(0);
  const type = header.toString("ascii", 4, 8);
  let headerBytes = BOX_HEADER_BYTES;
  let size: number;
  if (size32 === 0) {
    size = parentEnd - offset;
  } else if (size32 === 1) {
    if (parentEnd - offset < LARGE_BOX_HEADER_BYTES) {
      throw new Error("truncated ISO-BMFF large box header");
    }
    const largeSize = (await readExactly(handle, offset + BOX_HEADER_BYTES, 8)).readBigUInt64BE(0);
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("oversized ISO-BMFF box");
    }
    size = Number(largeSize);
    headerBytes = LARGE_BOX_HEADER_BYTES;
  } else {
    size = size32;
  }
  if (size < headerBytes || offset + size > parentEnd) {
    throw new Error("invalid ISO-BMFF box bounds");
  }
  return { type, payloadStart: offset + headerBytes, end: offset + size };
}

async function readSampleEntryTypes(
  handle: Awaited<ReturnType<typeof fs.open>>,
  box: Box,
  state: InspectionState,
): Promise<string[]> {
  if (box.end - box.payloadStart < 8) {
    throw new Error("invalid ISO-BMFF sample description");
  }
  const prefix = await readExactly(handle, box.payloadStart, 8);
  const entryCount = prefix.readUInt32BE(4);
  if (entryCount === 0 || entryCount > MAX_BOX_COUNT) {
    throw new Error("invalid ISO-BMFF sample entry count");
  }
  const entryTypes: string[] = [];
  let offset = box.payloadStart + 8;
  for (let index = 0; index < entryCount; index += 1) {
    state.boxCount += 1;
    if (state.boxCount > MAX_BOX_COUNT) {
      throw new Error("ISO-BMFF box count exceeded");
    }
    const entry = await readBox(handle, offset, box.end);
    entryTypes.push(entry.type);
    offset = entry.end;
  }
  if (offset !== box.end) {
    throw new Error("invalid ISO-BMFF sample description bounds");
  }
  return entryTypes;
}

async function inspectBoxes(params: {
  handle: Awaited<ReturnType<typeof fs.open>>;
  start: number;
  end: number;
  depth: number;
  state: InspectionState;
  track?: IsoBmffTrack;
}): Promise<void> {
  if (params.depth > MAX_BOX_DEPTH) {
    throw new Error("ISO-BMFF box depth exceeded");
  }
  let offset = params.start;
  while (offset < params.end) {
    params.state.boxCount += 1;
    if (params.state.boxCount > MAX_BOX_COUNT) {
      throw new Error("ISO-BMFF box count exceeded");
    }
    const box = await readBox(params.handle, offset, params.end);
    if (params.depth === 0 && box.type === "ftyp") {
      params.state.sawFtyp = true;
    }
    if (box.type === "trak") {
      const track: IsoBmffTrack = { sampleEntryTypes: [] };
      await inspectBoxes({
        ...params,
        start: box.payloadStart,
        end: box.end,
        depth: params.depth + 1,
        track,
      });
      params.state.tracks.push(track);
    } else if (box.type === "hdlr" && params.track) {
      if (box.end - box.payloadStart < 12) {
        throw new Error("invalid ISO-BMFF handler box");
      }
      params.track.handlerType = (
        await readExactly(params.handle, box.payloadStart + 8, 4)
      ).toString("ascii");
    } else if (box.type === "stsd" && params.track) {
      params.track.sampleEntryTypes = await readSampleEntryTypes(params.handle, box, params.state);
    } else if (CONTAINER_BOX_TYPES.has(box.type)) {
      await inspectBoxes({
        ...params,
        start: box.payloadStart,
        end: box.end,
        depth: params.depth + 1,
      });
    }
    offset = box.end;
  }
}

async function inspectIsoBmff(filePath: string, expectedSize: number): Promise<IsoBmffInspection> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expectedSize || stat.size < BOX_HEADER_BYTES) {
      return "ambiguous";
    }
    const firstHeader = await readExactly(handle, 0, BOX_HEADER_BYTES);
    if (firstHeader.toString("ascii", 4, 8) !== "ftyp") {
      return "not-isobmff";
    }
    const firstBox = await readBox(handle, 0, stat.size);
    if (firstBox.type !== "ftyp") {
      return "ambiguous";
    }
    const state: InspectionState = { boxCount: 0, sawFtyp: false, tracks: [] };
    await inspectBoxes({ handle, start: 0, end: stat.size, depth: 0, state });
    if (!state.sawFtyp || state.tracks.length === 0) {
      return "ambiguous";
    }
    if (state.tracks.some((track) => track.handlerType === "vide")) {
      return "video";
    }
    return state.tracks.every(
      (track) =>
        track.handlerType === "soun" &&
        track.sampleEntryTypes.length > 0 &&
        track.sampleEntryTypes.every((entryType) => entryType === "mp4a"),
    )
      ? "audio-only-aac"
      : "ambiguous";
  } catch {
    return "ambiguous";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function replaceExtension(value: string, extension: string): string {
  const currentExtension = path.extname(value);
  const stem = currentExtension ? value.slice(0, -currentExtension.length) : value;
  return `${stem}${extension}`;
}

export type NextcloudTalkStagedMedia = {
  id: string;
  path: string;
  size: number;
  contentType?: string;
};

export async function canonicalizeNextcloudTalkNativeVoiceMedia(
  media: NextcloudTalkStagedMedia,
): Promise<{ ok: true; media: NextcloudTalkStagedMedia } | { ok: false }> {
  if (path.basename(media.path) !== media.id) {
    return { ok: false };
  }
  const inspection = await inspectIsoBmff(media.path, media.size);
  if (inspection === "not-isobmff") {
    return media.contentType?.startsWith("audio/") ? { ok: true, media } : { ok: false };
  }
  if (inspection !== "audio-only-aac") {
    return { ok: false };
  }
  const canonicalId = replaceExtension(media.id, ".m4a");
  const canonicalPath = path.join(path.dirname(media.path), canonicalId);
  if (canonicalPath !== media.path) {
    await fs.rename(media.path, canonicalPath);
  }
  return {
    ok: true,
    media: {
      ...media,
      id: canonicalId,
      path: canonicalPath,
      contentType: "audio/mp4",
    },
  };
}
