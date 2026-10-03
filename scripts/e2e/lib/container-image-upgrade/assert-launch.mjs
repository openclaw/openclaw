import assert from "node:assert/strict";
import fs from "node:fs";
const [imagePath, containerPath, mode, logPath, phase] = process.argv.slice(2);
const [image] = JSON.parse(fs.readFileSync(imagePath, "utf8"));
assert.deepEqual(image.Config.Entrypoint, [
  "tini",
  "-s",
  "--",
  "node",
  "/app/docker-entrypoint.mjs",
]);
assert.deepEqual(image.Config.Cmd, ["node", "openclaw.mjs", "gateway"]);
assert.equal(image.Config.User, "node");
assert.equal(image.Config.WorkingDir, "/app");
if (containerPath) {
  const [container] = JSON.parse(fs.readFileSync(containerPath, "utf8"));
  assert.equal(container.Image, image.Id);
  assert.equal(container.State.OOMKilled, false);
  if (mode === "old-shape") {
    assert.deepEqual(container.Config.Entrypoint, ["tini"]);
    assert.deepEqual(container.Config.Cmd, ["-s", "--", "node", "openclaw.mjs", "gateway"]);
  } else {
    assert.deepEqual(container.Config.Entrypoint, image.Config.Entrypoint);
    assert.deepEqual(
      container.Config.Cmd,
      mode === "compose"
        ? ["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "18789"]
        : image.Config.Cmd,
    );
  }
  if (mode === "unsafe" || mode === "old-shape") {
    assert.equal(container.State.Running, false);
    assert.equal(container.State.Status, "exited");
    assert.notEqual(container.State.ExitCode, 0);
    assert(
      ![137, 143].includes(container.State.ExitCode),
      "Termination is not an activation refusal",
    );
    const log = fs.readFileSync(logPath, "utf8");
    assert(
      !/listening on (?:ws|http)s?:\/\//i.test(log),
      "Refused activation started a Gateway listener",
    );
    assert(
      mode === "unsafe"
        ? log.includes("metadata schema version 18 does not match 19")
        : /doctor.*--fix/i.test(log),
      "Missing concrete retained-state refusal diagnostic",
    );
  } else if (phase === "stopped") {
    assert.equal(container.State.Running, false);
    assert.equal(container.State.Status, "exited");
    assert.equal(container.State.Error, "");
    // The Gateway stop owner exits zero after draining; signal exits and Docker
    // timeout SIGKILL (137) cannot qualify subsequent preserved-state checks.
    assert.equal(container.State.ExitCode, 0, "Gateway did not complete a clean stop");
  } else {
    assert.equal(container.State.Running, true);
  }
}
console.log(JSON.stringify({ imageId: image.Id, mode: mode ?? "image-contract", qualified: true }));
