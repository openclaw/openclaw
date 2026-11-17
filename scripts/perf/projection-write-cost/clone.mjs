import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { copyTree, createCloneSource, probeTreeClone } from "@openclaw/fs-safe/copy";
configureFsSafeNative({ mode: "require" });
if (process.argv[2] === "create") {
  await createCloneSource(process.argv[3]);
} else {
  if (probeTreeClone(process.argv[3]) !== "btrfs") {
    throw new Error("Expected btrfs");
  }
  await copyTree(process.argv[3], process.argv[4], { clone: "always" });
}
