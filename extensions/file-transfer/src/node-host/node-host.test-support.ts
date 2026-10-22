import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";

export function useFiles(prefix: string, cleanup?: () => void) {
  let root: string;
  beforeEach(async () => {
    // Canonicalize macOS temp aliases so only explicit fixture links redirect.
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  });
  afterEach(async () => {
    cleanup?.();
    await fs.rm(root, { recursive: true, force: true });
  });
  const at = (...parts: string[]) => path.join(root, ...parts);
  const dir = async (name: string) => {
    const target = at(name);
    await fs.mkdir(target, { recursive: true });
    return target;
  };
  const file = async (name: string, content: string | Buffer = "x") => {
    const target = at(name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    return target;
  };
  const seed = async (names: string[], content: string | Buffer = "x") => {
    for (const name of names) {
      await file(name, content);
    }
  };
  return { at, dir, file, seed };
}
