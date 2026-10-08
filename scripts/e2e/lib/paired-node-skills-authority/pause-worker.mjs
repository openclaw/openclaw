// Fault injection only: pause the second publication checkpoint after backup
// displacement, before it is sent through the unchanged Gateway/node transport.
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
const barrier = process.env.SKILL_AUTHORITY_BARRIER;
if (barrier) {
  // Workspace workers intentionally receive a minimal environment. Inject the
  // preload only into this fixture's native Skill workers, never product code.
  const spawn = childProcess.spawn;
  childProcess.spawn = (file, args, options) => {
    let injectedOptions = options;
    if (args?.some((arg) => arg.endsWith("/skills-worker-entry.js"))) {
      injectedOptions = {
        ...options,
        env: {
          ...options.env,
          SKILL_AUTHORITY_BARRIER: barrier,
          NODE_OPTIONS: `--import=${fileURLToPath(import.meta.url)}`,
        },
      };
    }
    return spawn(file, args, injectedOptions);
  };
  syncBuiltinESMExports();
  const write = process.stdout.write.bind(process.stdout);
  let applyCount = 0;
  process.stdout.write = function (chunk, ...args) {
    if (
      String(chunk).includes('"phase":"apply"') &&
      ++applyCount === 2 &&
      fs.existsSync(barrier + ".armed")
    ) {
      const watcher = fs.watch(barrier + ".release", () => {
        if (fs.readFileSync(barrier + ".release", "utf8") === "release") {
          watcher.close();
          write(chunk, ...args);
        }
      });
      fs.writeFileSync(barrier + ".paused", String(process.pid));
      return true;
    }
    return write(chunk, ...args);
  };
}
