import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hasErrnoCode } from "../../infra/errno.js";
import { execContainer, type SandboxContainerEngine } from "./container-engine.js";

/** Capture before installation: after exit, even inspect waits for conmon cleanup. */
export async function capturePodmanBuilderCgroup(engine: SandboxContainerEngine, id: string) {
  if (
    process.platform !== "linux" ||
    engine.id !== "podman" ||
    engine.globalArgs?.[0] !== "--remote=false"
  ) {
    return undefined;
  }
  let events: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const root = "/sys/fs/cgroup";
    if ((await fs.statfs(root)).type !== 0x63677270) {
      return undefined;
    }
    const inspected = await execContainer(
      engine,
      ["inspect", "--format", "{{.Id}}\n{{.State.CgroupPath}}", id],
      {
        signal: AbortSignal.timeout(5_000),
      },
    );
    const [recordedId, relative] = inspected.stdout.trim().split("\n");
    if (
      recordedId !== id ||
      !relative?.startsWith("/") ||
      !relative.endsWith(`/libpod-${id}.scope`) ||
      path.posix.normalize(relative) !== relative
    ) {
      return undefined;
    }
    // Podman's systemd CgroupPath is the container scope, including descendants.
    // Pin that reported path, never a guessed name or a later path lookup.
    events = await fs.open(path.join(root, relative, "cgroup.events"), "r");
    const handle = events;
    const buffer = Buffer.alloc(4096);
    const populated = async () => {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const value = /^populated ([01])$/mu.exec(buffer.toString("utf8", 0, bytesRead))?.[1];
      if (value === undefined) {
        throw new Error("Dependency builder cgroup population is unreadable; template retained");
      }
      return value === "1";
    };
    if (!(await populated())) {
      await handle.close();
      return undefined;
    }
    return {
      close: () => handle.close(),
      async waitStopped() {
        const deadline = performance.now() + 5_000;
        while (true) {
          try {
            if (!(await populated())) {
              return;
            }
          } catch (error) {
            // kernfs returns ENODEV on this pinned file after cgroup removal.
            // Linux rejects removal while tasks or live child cgroups remain.
            if (hasErrnoCode(error, "ENODEV")) {
              return;
            }
            throw error;
          }
          if (performance.now() >= deadline) {
            throw new Error("Dependency builder cgroup is still populated; template retained");
          }
          await delay(25);
        }
      },
    };
  } catch {
    await events?.close();
    // Without an exact local cgroup-v2 capture, only the engine wait/inspect
    // path can prove extinction (including recovery after losing this handle).
    return undefined;
  }
}
