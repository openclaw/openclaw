import { SANDBOX_MATERIALIZED_SKILLS_DIRNAME } from "./constants.js";
/**
 * Reads the generated-skills mount layout of a live sandbox container.
 *
 * Retained hot containers can predate the direct `<workdir>/.openclaw-skills`
 * mount; prompt and file mapping must follow the layout the container actually
 * has until its normal safe recreation installs the current layout.
 */
import { execContainer } from "./container-engine.js";
import type { SandboxContainerEngine } from "./container-engine.js";
import type { SandboxSkillsMountLayout } from "./types.js";

export async function readContainerSkillsMountLayout(params: {
  engine: SandboxContainerEngine;
  containerName: string;
  workdir: string;
}): Promise<SandboxSkillsMountLayout | undefined> {
  const result = await execContainer(
    params.engine,
    ["inspect", "-f", "{{range .Mounts}}{{println .Destination}}{{end}}", params.containerName],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    return undefined;
  }
  const workdir = params.workdir.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const destinations = new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  if (destinations.has(`${workdir}/${SANDBOX_MATERIALIZED_SKILLS_DIRNAME}`)) {
    return "direct";
  }
  if (destinations.has(`${workdir}/.openclaw/sandbox-skills/skills`)) {
    return "nested";
  }
  return undefined;
}
