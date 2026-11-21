import { markBackgrounded } from "./bash-process-registry.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";
import { createProcessTool } from "./bash-tools.process.js";

const workspace = process.argv[2];
if (!workspace) {
  throw new Error("Missing workspace directory");
}
const command =
  'setTimeout(() => { require("node:fs").writeFileSync("result.txt", "background-complete"); }, 80)';
const run = await runExecProcess({
  command: "one-shot poll liveness",
  workdir: workspace,
  env: {},
  sandbox: {
    containerName: "poll-liveness-fixture",
    workspaceDir: workspace,
    containerWorkdir: workspace,
    async buildExecSpec() {
      return {
        argv: [process.execPath, "-e", command],
        env: {},
        stdinMode: "pipe-closed",
      };
    },
  },
  usePty: false,
  warnings: [],
  maxOutput: 1000,
  pendingMaxOutput: 1000,
  notifyOnExit: false,
  timeoutSec: 0,
});
markBackgrounded(run.session);
try {
  const result = await createProcessTool().execute("poll", {
    action: "poll",
    sessionId: run.session.id,
    timeout: 5000,
  });
  process.stdout.write(JSON.stringify(result) + "\n");
} finally {
  run.kill();
  await run.promise;
}
