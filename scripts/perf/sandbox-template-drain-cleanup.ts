import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { readRegistry } from "../../src/agents/sandbox/registry.js";

/** The caller has stopped and joined its Gateway before retiring persistent runtimes. */
export async function cleanupDrainFixtureContainers(params: {
  env: NodeJS.ProcessEnv;
  engine: string;
  backend: "docker" | "podman";
  output: string;
}) {
  const inspect = (name: string) => {
    const result = spawnSync(params.engine, ["container", "inspect", "--format", "{{.Id}}", name], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0 && /no such (?:object|container)/iu.test(result.stderr)) {
      return undefined;
    }
    assert.equal(result.status, 0, `Fixture container inspection failed: ${result.stderr}`);
    const id = result.stdout.trim();
    assert.match(id, /^[a-f0-9]{64}$/u, "Container inspection must return an immutable ID");
    return id;
  };
  // Allocation reserves this registry before native effects, including partial builders.
  // The CLI wrapper does not observe runtime allocations routed through the node worker.
  const { entries } = await readRegistry({ env: params.env });
  assert(entries.every((entry) => entry.backendId === params.backend));
  const ids = [...new Set(entries.flatMap((entry) => inspect(entry.containerName) ?? []))];
  if (ids.length) {
    execFileSync(params.engine, ["rm", "--force", ...ids], { timeout: 60_000, stdio: "pipe" });
  }
  for (const id of ids) {
    assert.equal(inspect(id), undefined, `Fixture container cleanup is unresolved: ${id}`);
  }
  await fs.writeFile(
    path.join(params.output, "cleanup.json"),
    JSON.stringify({ registered: entries.length, removedIds: ids, verifiedAbsent: true }, null, 2),
  );
}
