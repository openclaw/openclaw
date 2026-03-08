import { spawn, spawnSync } from "node:child_process";

export type DockerComposeCommand = {
  command: string;
  baseArgs: string[];
  kind: "docker_compose_v2" | "docker-compose_v1";
};

function canRun(cmd: string, args: string[]): boolean {
  try {
    const res = spawnSync(cmd, args, {
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

export function resolveDockerComposeCommand(): DockerComposeCommand {
  if (canRun("docker", ["compose", "version"])) {
    return { command: "docker", baseArgs: ["compose"], kind: "docker_compose_v2" };
  }
  if (canRun("docker-compose", ["version"])) {
    return { command: "docker-compose", baseArgs: [], kind: "docker-compose_v1" };
  }
  throw new Error(
    "Docker Compose not found. Install Docker Desktop or Docker Compose v2 (docker compose).",
  );
}

export async function runDockerCompose(args: string[], options?: { cwd?: string }): Promise<void> {
  const resolved = resolveDockerComposeCommand();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolved.command, [...resolved.baseArgs, ...args], {
      stdio: "inherit",
      cwd: options?.cwd,
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Docker compose failed: ${resolved.command} ${[...resolved.baseArgs, ...args].join(" ")} (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });
  });
}
