import fs, { type FileHandle } from "node:fs/promises";
import { vi } from "vitest";

export async function injectFileShortReads(filePath: string, maxBytes: number): Promise<void> {
  const handle = await fs.open(filePath, "r");
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  const realRead = Object.getOwnPropertyDescriptor(prototype, "read")?.value;
  await handle.close();
  if (typeof realRead !== "function") {
    throw new Error("FileHandle.read is unavailable");
  }
  vi.spyOn(prototype, "read").mockImplementation(function (
    this: FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) {
    return Reflect.apply(realRead, this, [buffer, offset, Math.min(length, maxBytes), position]);
  } as FileHandle["read"]);
}
