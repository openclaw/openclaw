import fs from "node:fs/promises";
import { loadOpenClawEnvConfig } from "../config/load.js";
import { runDockerCompose } from "../utils/docker.js";

export type DownCommandOptions = {
  cwd: string;
  configPath?: string;
};

export async function downCommand(opts: DownCommandOptions): Promise<void> {
  const cfg = await loadOpenClawEnvConfig({ cwd: opts.cwd, configPath: opts.configPath });
  // Best-effort: compose may not exist yet.
  await fs.access(cfg.generated.composePath).catch(() => {
    // Continue; docker will print a helpful error if it can't read it.
  });
  await runDockerCompose(["-f", cfg.generated.composePath, "-p", cfg.projectName, "down"], {
    cwd: cfg.configDir,
  });
}
