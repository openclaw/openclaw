/** Real Docker/Podman CLI template proof against a synthetic API; no daemon or containers.
 * node --import ./scripts/tsx.mjs scripts/perf/sandbox-inspect-smoke.ts --engine docker --socket /short/private/path.sock
 * Repeat with --engine podman. The socket must not already exist.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import {
  DOCKER_SANDBOX_ENGINE,
  PODMAN_SANDBOX_ENGINE,
} from "../../src/agents/sandbox/container-engine.js";
import { containerState } from "../../src/agents/sandbox/container-inspect.js";

const { values } = parseArgs({
  options: { engine: { type: "string" }, socket: { type: "string" } },
});
assert(
  values.socket && ["docker", "podman"].includes(values.engine ?? ""),
  "--engine docker|podman --socket <unused path> required",
);
const id = "a".repeat(64);
let tmpfs: Record<string, string> | undefined;
const requests: string[] = [];
const server = createServer((request, response) => {
  requests.push(`${request.method} ${request.url}`);
  response.setHeader("API-Version", "1.53");
  response.setHeader("Libpod-API-Version", "5.0.0");
  const pathname = new URL(request.url ?? "/", "http://fixture").pathname;
  if (pathname.endsWith("/_ping")) {
    response.end("OK");
  } else if (pathname.endsWith(`/containers/${id}/json`)) {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        Id: id,
        State: { Running: true, Paused: false, Pid: 123 },
        Config: { Labels: { "openclaw.configHash": "fixture" } },
        HostConfig: { ReadonlyRootfs: true, ...(tmpfs ? { Tmpfs: tmpfs } : {}) },
        Mounts: [],
      }),
    );
  } else {
    console.error(`Unexpected synthetic API request: ${request.method} ${request.url}`);
    response.writeHead(404).end(JSON.stringify({ message: "Unexpected synthetic API request" }));
  }
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(values.socket, resolve);
});
try {
  const engine =
    values.engine === "docker"
      ? {
          ...DOCKER_SANDBOX_ENGINE,
          globalArgs: ["--host", `unix://${values.socket}`],
          baseEnv: { PATH: process.env.PATH },
        }
      : {
          ...PODMAN_SANDBOX_ENGINE,
          globalArgs: ["--url", `unix://${values.socket}`],
          baseEnv: { PATH: process.env.PATH },
        };
  for (tmpfs of [undefined, { "/tmp": "rw,size=64m" }]) {
    const state = await containerState(engine, id, { strict: true, includePaused: true });
    assert.deepEqual(state, {
      exists: true,
      running: true,
      paused: false,
      id,
      readOnlyRoot: true,
      configHash: "fixture",
      mounts: tmpfs ? [{ type: "tmpfs", source: "", destination: "/tmp", writable: true }] : [],
    });
  }
  console.log(
    JSON.stringify({
      engine: values.engine,
      cases: ["omitted tmpfs", "configured tmpfs"],
      requests,
      result: "passed",
    }),
  );
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
