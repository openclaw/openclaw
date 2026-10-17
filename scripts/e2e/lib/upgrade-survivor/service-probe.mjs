import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hasUnjoinedWork } from "../../../lib/managed-child-process.mts";

// The fixture manager owns definition writes. This adapter owns only the caller
// environment scope and the existing bounded command/reload/readback sequence.
export function createServiceProbe({ run, bin, artifacts, env, preload, selectors }) {
  const id = randomUUID();
  const receipt = path.join(artifacts, "service-probe-receipt.json");
  const manager = path.join(bin, "systemd-fixture.mjs");
  const environment = { ...selectors };
  let attempted = false;
  let finished;
  const reload = (name) => run(name, path.join(bin, "systemctl"), ["--user", "daemon-reload"]);
  const verify = async (name, phase, producer) => {
    const { unitSha256 } = JSON.parse(
      fs.readFileSync(path.join(artifacts, producer + ".stdout"), "utf8"),
    );
    assert.match(unitSha256, /^[a-f0-9]{64}$/);
    await run(name, process.execPath, [manager, "verify-env", receipt, id, phase, unitSha256]);
  };
  return {
    async install() {
      assert(!attempted && !fs.existsSync(receipt), "Service probe already has an owner");
      attempted = true;
      await run("service-probe-install", process.execPath, [
        manager,
        "instrument-env",
        receipt,
        id,
        JSON.stringify({ preload, environment }),
      ]);
      await reload("service-probe-reload");
      await verify("service-probe-verify", "installed", "service-probe-install");
    },
    async withCaller(work) {
      const options = env.NODE_OPTIONS || "";
      const overrides = {
        ...environment,
        NODE_OPTIONS:
          (options ? options + " " : "") +
          "--import=" +
          JSON.stringify(pathToFileURL(preload).href),
      };
      const before = Object.fromEntries(
        Object.keys(overrides).map((key) => [
          key,
          { present: Object.hasOwn(env, key), value: env[key] },
        ]),
      );
      Object.assign(env, overrides);
      try {
        return await work();
      } finally {
        for (const [key, value] of Object.entries(before)) {
          if (value.present) {
            env[key] = value.value;
          } else {
            delete env[key];
          }
        }
      }
    },
    async finish({ failures, serviceStopped }) {
      if (finished) {
        return finished;
      }
      if (!attempted) {
        return (finished = { retained: false });
      }
      if (!serviceStopped || failures.some(hasUnjoinedWork)) {
        if (!failures.length) {
          failures.push(new Error("Service probe settlement was not confirmed"));
        }
        return (finished = { retained: true });
      }
      try {
        assert(fs.existsSync(receipt), "Service probe receipt is missing; retaining runtime");
        await run("service-probe-restore", process.execPath, [manager, "restore-env", receipt, id]);
        await reload("service-probe-restore-reload");
        await verify("service-probe-restore-verify", "restored", "service-probe-restore");
        return (finished = { retained: false });
      } catch (error) {
        // Preserve the first failure (including timeout 124), appending cleanup
        // evidence while making the caller retain its still-instrumented runtime.
        failures.push(error);
        return (finished = { retained: true });
      }
    },
  };
}
