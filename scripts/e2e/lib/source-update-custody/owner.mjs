import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [root, mode] = process.argv.slice(2);
assert.equal(process.platform, "linux");
assert(fs.existsSync("/.dockerenv"));
assert.equal(root, "/home/appuser/source-custody/release");
assert(["legacy", "escaped", "leaf"].includes(mode));
if (mode === "leaf") {
  // This deliberately escaped fixture remains in the task's Docker PID namespace.
  // The container owner joins teardown; this is never a native settlement receipt.
  setInterval(() => {}, 60_000);
  process.send("ready");
} else {
  const { acquireDistArtifactOwnership } = await import(
    pathToFileURL(path.join(root, "scripts/lib/dist-artifact-lock.mts")).href
  );
  await acquireDistArtifactOwnership(root);
  if (mode === "escaped") {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), root, "leaf"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Fixture descendant exited before readiness")));
      child.once("message", (message) =>
        message === "ready" ? resolve() : reject(new Error("Unexpected fixture readiness")),
      );
    });
    const fields = fs
      .readFileSync("/proc/" + child.pid + "/stat", "utf8")
      .split(") ")[1]
      .split(" ");
    fs.writeFileSync("/proof/leaf.json", JSON.stringify({ pid: child.pid, starttime: fields[19] }));
    child.disconnect();
    child.unref();
  }
  // Exercise the RELEASED owner's retained-on-exit contract, without editing it.
  process.exit(0);
}
