import { getAiTransportHost } from "../host.js";
import { isSanitizedFrozenResponsesInput } from "./responses-image-payload-sanitizer.js";

// Carry exact sizes for immutable history, and strings in mutable hook/image
// payloads. Each commit keeps only facts encountered in its current baseline.
export function retainedJsonBytes(value: unknown, previous?: ReadonlyMap<string | object, number>) {
  const jsonBytes = new Map<string | object, number>();
  const immutable = getAiTransportHost().immutableData;
  let valueBytes = 0;
  const skeleton = JSON.stringify(value, (_key, member: unknown) => {
    if (
      typeof member !== "string" &&
      !(
        member &&
        typeof member === "object" &&
        (previous?.has(member) ||
          isSanitizedFrozenResponsesInput(member) ||
          immutable?.isDeeplyFrozenPlainData(member))
      )
    ) {
      return member;
    }
    let bytes = jsonBytes.get(member) ?? previous?.get(member);
    if (bytes === undefined) {
      bytes = Buffer.byteLength(JSON.stringify(member), "utf8") - 2;
    }
    jsonBytes.set(member, bytes);
    valueBytes += bytes;
    return "";
  });
  return { retainedBytes: valueBytes + Buffer.byteLength(skeleton, "utf8"), jsonBytes };
}
