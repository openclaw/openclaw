// Prepare both real Bash roots before native output-lifecycle deadlines begin.
const currentModuleUrl = import.meta.url;

export const bashOutputSpillEntrypoints = {
  tool: {
    currentModuleUrl,
    sourceWorkerName: "tools/bash",
    distWorkerPath: "agents/sessions/tools/bash.js",
  },
  executor: {
    currentModuleUrl,
    sourceWorkerName: "bash-executor",
    distWorkerPath: "agents/sessions/bash-executor.js",
  },
} as const;
