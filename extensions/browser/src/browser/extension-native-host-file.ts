import path from "node:path";
import { root } from "openclaw/plugin-sdk/file-access-runtime";

/** Read POSIX native-host artifacts through the descriptor that passed admission. */
export async function readPrivateNativeHostFile(filePath: string, executable: boolean) {
  const resolved = path.resolve(filePath);
  const directory = await root(path.dirname(resolved));
  await using file = await directory.open(path.basename(resolved), { hardlinks: "allow" });
  if (file.realPath !== resolved) {
    throw new Error("non-canonical native host file path");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && file.stat.uid !== uid) {
    throw new Error("foreign native host file owner");
  }
  if ((file.stat.mode & 0o077) !== 0 || (executable && (file.stat.mode & 0o100) === 0)) {
    throw new Error("native host file has unsafe mode");
  }
  return { realPath: file.realPath, buffer: await file.handle.readFile() };
}
