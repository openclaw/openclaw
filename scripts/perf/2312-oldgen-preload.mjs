// Diagnostic census through the already-built admission owner's exported reads.
// Resolve the generated export aliases without importing a second source graph.
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  let timer;
  let output;
  let owner;
  let configuredAgents = [];
  const loadOwner = async () => {
    const dist = path.dirname(path.resolve(process.argv[1]));
    const name = readdirSync(dist).find((entry) => {
      if (!/^agent-database-admission-.*\.mjs$/.test(entry)) {
        return false;
      }
      return readFileSync(path.join(dist, entry), "utf8").includes(
        "function listAgentDatabaseAdmissionRefusals(",
      );
    });
    if (!name) {
      throw new Error("Compiled admission owner was not found");
    }
    const source = readFileSync(path.join(dist, name), "utf8");
    const exports = await import(pathToFileURL(path.join(dist, name)).href);
    const read = (identifier) => {
      const alias = new RegExp(`\\b${identifier} as ([\\w$]+)`).exec(source)?.[1];
      const fn = exports[alias ?? identifier];
      if (typeof fn !== "function") {
        throw new Error(`Missing built admission read: ${identifier}`);
      }
      return fn;
    };
    const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
    configuredAgents = Object.keys(config.agents?.entries ?? {});
    return {
      list: read("listAgentDatabaseAdmissionRefusals"),
      read: read("readAgentDatabaseReadAdmissionRefusal"),
    };
  };
  const record = (phase) => {
    const refusals = owner.list();
    appendFileSync(
      path.join(output, "oldgen-admission-counts.jsonl"),
      JSON.stringify({
        atEpochMs: Date.now(),
        processUptimeMs: process.uptime() * 1000,
        phase,
        configured: configuredAgents.length,
        writable: configuredAgents.length - refusals.length,
        readable: configuredAgents.filter((id) => owner.read(id) === undefined).length,
        pending: refusals.filter((item) => item.code === "agent-database-inspection-pending")
          .length,
        refused: refusals.length,
      }) + "\n",
    );
  };
  process.on("message", (message) => {
    if (message?.channel !== "team-shape-stress") {
      return;
    }
    if (message.action === "start") {
      output = message.output;
      void loadOwner()
        .then((loaded) => {
          owner = loaded;
          record("start");
          timer = setInterval(() => record("sample"), 60_000);
          timer.unref();
        })
        .catch((/** @type {unknown} */ error) => {
          appendFileSync(
            path.join(output, "oldgen-admission-counts.jsonl"),
            JSON.stringify({ error: String(error) }) + "\n",
          );
        });
    } else if (message.action === "stop") {
      clearInterval(timer);
      if (owner) {
        record("stop");
      }
    }
  });
}
