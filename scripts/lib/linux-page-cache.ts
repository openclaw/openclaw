import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

export function evictLinuxFilePageCache(filename: string): void {
  const evict = spawnSync(
    "python3",
    [
      "-c",
      "import os,sys; f=os.open(sys.argv[1],os.O_RDONLY); os.fsync(f); os.posix_fadvise(f,0,0,os.POSIX_FADV_DONTNEED); os.close(f)",
      filename,
    ],
    { encoding: "utf8" },
  );
  assert.equal(evict.status, 0, evict.stderr);
}
