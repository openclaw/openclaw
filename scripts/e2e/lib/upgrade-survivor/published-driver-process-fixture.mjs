import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
// Synthetic commands for the registered Docker driver lifecycle regression, never package acceptance.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
const mode = JSON.parse(fs.readFileSync("/fixture/control.json")).mode;
assert(
  [
    "success",
    "interrupt",
    "timeout",
    "status-failure",
    "success-status-failure",
    "stop-failure",
  ].includes(mode),
  "Unsupported lifecycle fixture mode",
);
const trace = (event, data = {}) =>
  fs.appendFileSync(
    "/fixture/events.jsonl",
    JSON.stringify({ event, pid: process.pid, ppid: process.ppid, at: Date.now(), ...data }) + "\n",
  );
const [role, ...args] = process.argv.slice(2);
const build = { version: "2026.10.1", commit: "synthetic-lifecycle-candidate" };
const output = (value) => console.log(JSON.stringify(value));
const ctl = (...a) => {
  const r = spawnSync(path.join(process.env.npm_config_prefix, "bin/systemctl"), ["--user", ...a], {
    stdio: "inherit",
    env: process.env,
  });
  assert.equal(r.status, 0, "synthetic service command failed");
};
if (role === "npm") {
  if (args[0] === "view") {
    output("2026.9.7");
  } else if (args[0] === "install") {
    const prefix = process.env.npm_config_prefix;
    assert(prefix.startsWith("/tmp/openclaw-published-driver-"));
    fs.mkdirSync(path.join(prefix, "lib/node_modules/openclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(prefix, "lib/node_modules/openclaw/package.json"),
      JSON.stringify({ version: "2026.9.7" }),
    );
    fs.writeFileSync(
      path.join(prefix, "bin/openclaw"),
      '#!/bin/sh\nexec node /proof/fixture.mjs openclaw "$@"\n',
      { mode: 0o755 },
    );
  } else {
    throw new Error("unexpected npm args " + args.join(","));
  }
} else if (role === "server") {
  const c = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH));
  const server = http.createServer((_, r) => {
    r.setHeader("content-type", "application/json");
    r.end(JSON.stringify({ ready: true }));
  });
  server.listen(c.gateway.port, "127.0.0.1", () => trace("server-ready"));
  process.on("SIGTERM", () =>
    server.close(() => {
      trace("server-closed");
      process.exit(0);
    }),
  );
} else if (role === "child") {
  process.on("SIGTERM", () => {
    trace("update-child-closed");
    process.exit(0);
  });
  process.on("message", (message) => {
    if (message === "release") {
      trace("update-child-released");
      process.exit(0);
    }
  });
  process.send("ready");
} else if (role === "openclaw") {
  trace("cli", { args });
  if (args[0] === "doctor") {
    trace("doctor");
  } else if (args[0] === "gateway" && args[1] === "install") {
    const unit = path.join(process.env.HOME, ".config/systemd/user/openclaw-gateway.service");
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(
      unit,
      "[Unit]\nDescription=Synthetic driver lifecycle service\n[Service]\nExecStart=/usr/local/bin/node /proof/fixture.mjs server\nEnvironment=OPENCLAW_CONFIG_PATH=/home/appuser/.openclaw/openclaw.json\nTimeoutStopSec=2\n[Install]\nWantedBy=default.target\n",
    );
    ctl("daemon-reload");
    ctl("start", "openclaw-gateway.service");
  } else if (args[0] === "update" && args[1] === "status") {
    const events = fs
      .readFileSync("/fixture/events.jsonl", "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    const started = events.find((e) => e.event === "update-start");
    const gone = (pid) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (e) {
        if (e.code === "ESRCH") {
          return true;
        }
        throw e;
      }
    };
    trace("status", {
      childSettled: events.some((e) => e.event === "update-child-closed"),
      childGone: started ? gone(started.child) : null,
      updaterGone: started ? gone(started.pid) : null,
      runtimeExists: fs.existsSync(process.env.npm_config_prefix),
    });
    if (mode === "status-failure" || mode === "success-status-failure") {
      process.exit(9);
    }
    output({
      lastRun: {
        runId: "synthetic-run",
        phase: mode === "success" ? "finished" : "installing",
        status: mode === "success" ? "succeeded" : "running",
      },
    });
  } else if (args[0] === "update") {
    if (mode === "interrupt" || mode === "timeout") {
      const child = spawn(process.execPath, ["/proof/fixture.mjs", "child"], {
        env: process.env,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      const done = new Promise((resolve) => {
        child.once("close", resolve);
      });
      process.on("SIGTERM", () => {
        child.kill("SIGTERM");
      });
      try {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            child.off("message", ready);
            child.off("error", failed);
            child.off("close", closed);
          };
          const ready = (message) => {
            cleanup();
            if (message === "ready") {
              resolve();
            } else {
              reject(new Error(`Unexpected fixture readiness message: ${message}`));
            }
          };
          const failed = (error) => {
            cleanup();
            reject(
              error instanceof Error ? error : new Error("Fixture child failed", { cause: error }),
            );
          };
          const closed = (code, signal) => {
            cleanup();
            reject(new Error(`Fixture child closed before readiness: ${code}/${signal}`));
          };
          child.once("message", ready);
          child.once("error", failed);
          child.once("close", closed);
        });
      } catch (error) {
        child.kill("SIGTERM");
        await done;
        throw error;
      }
      assert.equal(child.exitCode, null);
      process.kill(child.pid, 0);
      trace("update-start", { child: child.pid, observedAlive: true });
      if (mode === "interrupt") {
        process.kill(process.ppid, "SIGTERM");
      }
      await done;
      trace("update-settled");
      process.exitCode = 143;
    } else if (mode === "success" || mode === "success-status-failure") {
      ctl("restart", "openclaw-gateway.service");
      fs.mkdirSync(path.join(process.env.npm_config_prefix, "lib/node_modules/openclaw/dist"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(process.env.npm_config_prefix, "lib/node_modules/openclaw/dist/build-info.json"),
        JSON.stringify(build),
      );
      output({
        status: "ok",
        after: { version: build.version },
        run: { runId: "synthetic-run", phase: "finished", status: "succeeded" },
      });
    } else {
      if (mode === "stop-failure") {
        const ctlPath = path.join(process.env.npm_config_prefix, "bin/systemctl");
        fs.renameSync(ctlPath, ctlPath + ".original");
        fs.writeFileSync(
          ctlPath,
          '#!/bin/sh\n"$(dirname "$0")/systemctl.original" "$@"\nexit 11\n',
          { mode: 0o755 },
        );
      }
      output({ status: "error" });
      process.exitCode = 7;
    }
  } else if (args[0] === "gateway" && args[1] === "probe") {
    output({
      targets: [
        {
          url: args[args.indexOf("--url") + 1],
          connect: { ok: true },
          server: { version: build.version },
        },
      ],
    });
  } else {
    throw new Error("unexpected CLI args " + args.join(","));
  }
} else {
  throw new Error("unexpected role " + role);
}
