import fs from "node:fs/promises";
import { normalizeBoundedOptionalString as readBoundedString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { MAX_STRING_LENGTH } from "./session-catalog-desktop.js";
import { parseBoundedJsonNumberToken } from "./session-catalog-shared.js";

const SESSION_INDEX_PROBE_CHUNK_BYTES = 16 * 1024;

// A JSON string token's encoded form can cost up to six raw characters per
// decoded character ("\uXXXX"). Collect encoded tokens up to this bound so any
// string the admitted reader would accept within a decoded field cap still
// decodes; the decoded caps applied below remain the effective limits.
const MAX_PROBE_ENCODED_STRING_CHARS = MAX_STRING_LENGTH * 6;

// Ordinary-entry metadata captured from rejected indexes so their sessions keep
// their released catalog visibility. Field caps match the admitted-index reader.
const PROBE_STRING_FIELD_CAPS = {
  sessionId: 256,
  fullPath: MAX_STRING_LENGTH,
  summary: 500,
  firstPrompt: 500,
  projectPath: MAX_STRING_LENGTH,
  gitBranch: 500,
} as const;

const PROBE_TIMESTAMP_KEYS = new Set(["created", "modified", "fileMtime"]);

function isTimestampKey(key: string | undefined): key is TimestampKey {
  return key !== undefined && PROBE_TIMESTAMP_KEYS.has(key);
}

type TimestampKey = "created" | "modified" | "fileMtime";

type RejectedSessionIndexEntry = {
  sessionId: string;
  fullPath?: string;
  summary?: string;
  firstPrompt?: string;
  projectPath?: string;
  gitBranch?: string;
  created?: unknown;
  modified?: unknown;
  fileMtime?: unknown;
};

type RejectedSessionIndexProbe = {
  sidechainIds: Set<string>;
  entries: RejectedSessionIndexEntry[];
};

type SessionIndexProbeFrame = {
  kind: "object" | "array";
  state: "key" | "colon" | "value" | "comma";
  key?: string;
  isEntriesArray?: boolean;
};

type SessionIndexProbeCapture = {
  depth: number;
  sessionId?: string;
  isSidechain?: boolean;
  fullPath?: string;
  summary?: string;
  firstPrompt?: string;
  projectPath?: string;
  gitBranch?: string;
  created?: unknown;
  modified?: unknown;
  fileMtime?: unknown;
};

function isTrackedStringKey(key: string | undefined): key is keyof typeof PROBE_STRING_FIELD_CAPS {
  return key !== undefined && key in PROBE_STRING_FIELD_CAPS;
}

export async function probeRejectedSessionIndex(
  filePath: string,
  onIoFailure: () => void,
): Promise<RejectedSessionIndexProbe> {
  const sidechainIds = new Set<string>();
  const entries: RejectedSessionIndexEntry[] = [];
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0) {
      return { sidechainIds, entries };
    }

    const decoder = new TextDecoder();
    const stack: SessionIndexProbeFrame[] = [];
    let token: "normal" | "string" | "primitive" = "normal";
    let tokenRaw = "";
    let tokenNeedsDecode = false;
    let tokenOverflowed = false;
    let primitiveRaw = "";
    let primitiveNeedsCapture = false;
    let primitiveOverflowed = false;
    let currentPrimitiveKey: string | undefined = undefined;
    let stringEscaped = false;
    let capture: SessionIndexProbeCapture | undefined;
    let done = false;
    let invalid = false;

    const trackCapture = (character: string, structural: boolean): void => {
      const current = capture;
      if (!current) {
        return;
      }
      if (!structural) {
        return;
      }
      if (character === "{" || character === "[") {
        current.depth += 1;
      } else if (character === "}" || character === "]") {
        current.depth -= 1;
        if (current.depth === 0) {
          if (current.sessionId) {
            if (current.isSidechain) {
              sidechainIds.add(current.sessionId);
            } else {
              entries.push({
                sessionId: current.sessionId,
                ...(current.fullPath !== undefined ? { fullPath: current.fullPath } : {}),
                ...(current.summary !== undefined ? { summary: current.summary } : {}),
                ...(current.firstPrompt !== undefined ? { firstPrompt: current.firstPrompt } : {}),
                ...(current.projectPath !== undefined ? { projectPath: current.projectPath } : {}),
                ...(current.gitBranch !== undefined ? { gitBranch: current.gitBranch } : {}),
                ...(current.created !== undefined ? { created: current.created } : {}),
                ...(current.modified !== undefined ? { modified: current.modified } : {}),
                ...(current.fileMtime !== undefined ? { fileMtime: current.fileMtime } : {}),
              });
            }
          }
          capture = undefined;
        }
      }
    };

    const finishPrimitive = (): void => {
      if (capture && primitiveNeedsCapture) {
        if (primitiveRaw === "true") {
          capture.isSidechain = true;
        } else if (isTimestampKey(currentPrimitiveKey)) {
          // Numeric timestamps stay numeric with the admitted reader's exact
          // JSON semantics: valid decimals and exponents decode like
          // JSON.parse, while truncated prefixes are rejected rather than
          // silently shortened.
          const numeric = parseBoundedJsonNumberToken(primitiveRaw, primitiveOverflowed);
          if (numeric !== undefined) {
            capture[currentPrimitiveKey] = numeric;
          }
        }
      }
      primitiveRaw = "";
      primitiveNeedsCapture = false;
      primitiveOverflowed = false;
      currentPrimitiveKey = undefined;
    };

    const finishValue = (): void => {
      const frame = stack.at(-1);
      if (frame) {
        frame.state = "comma";
      }
    };

    const finishString = (): void => {
      let value: unknown;
      if (!tokenNeedsDecode || tokenOverflowed) {
        value = undefined;
      } else {
        try {
          value = JSON.parse(`"${tokenRaw}"`) as unknown;
        } catch {
          invalid = true;
          return;
        }
      }
      const frame = stack.at(-1);
      if (frame?.kind === "object" && frame.state === "key") {
        frame.key = typeof value === "string" ? value : undefined;
        frame.state = "colon";
      } else {
        if (
          capture &&
          frame?.kind === "object" &&
          stack.length === 3 &&
          frame.state === "value" &&
          typeof value === "string"
        ) {
          if (isTrackedStringKey(frame.key)) {
            const bounded = readBoundedString(value, PROBE_STRING_FIELD_CAPS[frame.key]);
            if (bounded !== undefined) {
              capture[frame.key] = bounded;
            }
          } else if (isTimestampKey(frame.key)) {
            capture[frame.key] = value;
          }
        }
        finishValue();
      }
    };

    const consume = (text: string): void => {
      let index = 0;
      while (index < text.length) {
        if (done || invalid) {
          return;
        }
        const character = text[index];
        if (character === undefined) {
          break;
        }
        if (token === "primitive") {
          if (character === "," || character === "}" || character === "]" || /\s/.test(character)) {
            finishPrimitive();
            token = "normal";
            continue;
          }
          trackCapture(character, false);
          if (primitiveNeedsCapture) {
            if (primitiveRaw.length < 16) {
              primitiveRaw += character;
            } else {
              // A longer token was truncated: reject the whole value at
              // finish instead of interpreting the shorter prefix.
              primitiveOverflowed = true;
            }
          }
          index += 1;
          continue;
        }
        if (token === "string") {
          trackCapture(character, false);
          if (stringEscaped) {
            if (tokenNeedsDecode) {
              if (tokenRaw.length < MAX_PROBE_ENCODED_STRING_CHARS) {
                tokenRaw += character;
              } else {
                tokenOverflowed = true;
              }
            }
            stringEscaped = false;
          } else if (character === "\\") {
            if (tokenNeedsDecode) {
              if (tokenRaw.length < MAX_PROBE_ENCODED_STRING_CHARS) {
                tokenRaw += character;
              } else {
                tokenOverflowed = true;
              }
            }
            stringEscaped = true;
          } else if (character === '"') {
            finishString();
            token = "normal";
            tokenRaw = "";
            tokenNeedsDecode = false;
            tokenOverflowed = false;
          } else if (tokenNeedsDecode) {
            if (tokenRaw.length < MAX_PROBE_ENCODED_STRING_CHARS) {
              tokenRaw += character;
            } else {
              tokenOverflowed = true;
            }
          }
          index += 1;
          continue;
        }
        if (/\s/.test(character)) {
          trackCapture(character, false);
          index += 1;
          continue;
        }
        if (character === '"') {
          trackCapture(character, false);
          token = "string";
          tokenRaw = "";
          const frame = stack.at(-1);
          tokenNeedsDecode =
            frame?.kind === "object" &&
            (frame.state === "key" ||
              (frame.state === "value" &&
                frame.key !== undefined &&
                (isTrackedStringKey(frame.key) || isTimestampKey(frame.key))));
          tokenOverflowed = false;
          stringEscaped = false;
          index += 1;
          continue;
        }
        if (character === "{" || character === "[") {
          const parent = stack.at(-1);
          const isEntriesArray =
            character === "[" &&
            stack.length === 1 &&
            parent?.kind === "object" &&
            parent.key === "entries";
          const startsEntry =
            character === "{" && parent?.isEntriesArray === true && stack.length === 2;
          if (startsEntry) {
            capture = { depth: 1 };
          } else {
            trackCapture(character, true);
          }
          stack.push({
            kind: character === "{" ? "object" : "array",
            state: character === "{" ? "key" : "value",
            ...(isEntriesArray ? { isEntriesArray: true } : {}),
          });
          index += 1;
          continue;
        }
        if (character === "}" || character === "]") {
          trackCapture(character, true);
          const frame = stack.pop();
          if (!frame || (character === "}" ? frame.kind !== "object" : frame.kind !== "array")) {
            invalid = true;
            continue;
          }
          if (frame.isEntriesArray) {
            done = true;
          }
          finishValue();
          index += 1;
          continue;
        }
        if (character === ":") {
          trackCapture(character, false);
          const frame = stack.at(-1);
          if (frame?.kind !== "object" || frame.state !== "colon") {
            invalid = true;
            continue;
          }
          frame.state = "value";
          index += 1;
          continue;
        }
        if (character === ",") {
          trackCapture(character, false);
          const frame = stack.at(-1);
          if (!frame) {
            invalid = true;
            continue;
          }
          frame.state = frame.kind === "object" ? "key" : "value";
          index += 1;
          continue;
        }
        if (character === "-" || /[0-9tfn]/.test(character)) {
          trackCapture(character, false);
          const frame = stack.at(-1);
          const frameKey = frame?.key;
          const tracksPrimitive =
            capture !== undefined &&
            frame?.kind === "object" &&
            stack.length === 3 &&
            frame.state === "value" &&
            frameKey !== undefined &&
            (frameKey === "isSidechain" || PROBE_TIMESTAMP_KEYS.has(frameKey));
          primitiveNeedsCapture = tracksPrimitive;
          currentPrimitiveKey = tracksPrimitive ? frameKey : undefined;
          primitiveRaw = primitiveNeedsCapture ? character : "";
          primitiveOverflowed = false;
          token = "primitive";
          index += 1;
          continue;
        }
        invalid = true;
      }
    };

    const buffer = Buffer.allocUnsafe(SESSION_INDEX_PROBE_CHUNK_BYTES);
    let offset = 0;
    while (offset < stat.size) {
      if (done || invalid) {
        break;
      }
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - offset),
        offset,
      );
      if (bytesRead === 0) {
        onIoFailure();
        return { sidechainIds, entries };
      }
      offset += bytesRead;
      consume(decoder.decode(buffer.subarray(0, bytesRead), { stream: offset < stat.size }));
    }
    if (!done && !invalid) {
      consume(decoder.decode());
    }
    return { sidechainIds, entries };
  } catch {
    onIoFailure();
    return { sidechainIds, entries };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
