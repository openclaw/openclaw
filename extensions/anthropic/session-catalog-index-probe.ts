import fs from "node:fs/promises";
import { normalizeBoundedOptionalString as readBoundedString } from "openclaw/plugin-sdk/string-coerce-runtime";

const SESSION_INDEX_PROBE_CHUNK_BYTES = 16 * 1024;

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
};

export async function probeRejectedSessionIndex(
  filePath: string,
  onIoFailure: () => void,
): Promise<Set<string>> {
  const sidechainIds = new Set<string>();
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0) {
      return sidechainIds;
    }

    const decoder = new TextDecoder();
    const stack: SessionIndexProbeFrame[] = [];
    let token: "normal" | "string" | "primitive" = "normal";
    let tokenRaw = "";
    let tokenNeedsDecode = false;
    let tokenOverflowed = false;
    let primitiveRaw = "";
    let primitiveNeedsCapture = false;
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
          if (current.isSidechain && current.sessionId) {
            sidechainIds.add(current.sessionId);
          }
          capture = undefined;
        }
      }
    };

    const finishPrimitive = (): void => {
      if (capture && primitiveNeedsCapture && primitiveRaw === "true") {
        capture.isSidechain = true;
      }
      primitiveRaw = "";
      primitiveNeedsCapture = false;
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
          frame.key === "sessionId" &&
          typeof value === "string"
        ) {
          const sessionId = readBoundedString(value, 256);
          if (sessionId) {
            capture.sessionId = sessionId;
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
          if (primitiveNeedsCapture && primitiveRaw.length < 16) {
            primitiveRaw += character;
          }
          index += 1;
          continue;
        }
        if (token === "string") {
          trackCapture(character, false);
          if (stringEscaped) {
            if (tokenNeedsDecode) {
              if (tokenRaw.length < 1024) {
                tokenRaw += character;
              } else {
                tokenOverflowed = true;
              }
            }
            stringEscaped = false;
          } else if (character === "\\") {
            if (tokenNeedsDecode) {
              if (tokenRaw.length < 1024) {
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
            if (tokenRaw.length < 1024) {
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
            (frame.state === "key" || (frame.state === "value" && frame.key === "sessionId"));
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
          primitiveNeedsCapture =
            capture !== undefined &&
            frame?.kind === "object" &&
            stack.length === 3 &&
            frame.state === "value" &&
            frame.key === "isSidechain";
          primitiveRaw = primitiveNeedsCapture ? character : "";
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
        return sidechainIds;
      }
      offset += bytesRead;
      consume(decoder.decode(buffer.subarray(0, bytesRead), { stream: offset < stat.size }));
    }
    if (!done && !invalid) {
      consume(decoder.decode());
    }
    return sidechainIds;
  } catch {
    onIoFailure();
    return sidechainIds;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
