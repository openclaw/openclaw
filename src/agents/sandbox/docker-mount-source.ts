import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isPathInside } from "../../infra/path-guards.js";
import { execContainer, type SandboxContainerEngine } from "./container-engine.js";
import { isSandboxHostPathAbsolute, normalizeSandboxHostPath } from "./host-paths.js";
import {
  normalizeMountContainerPath,
  sandboxMountOptionsReadOnly,
  type ManagedWorkspaceMount,
} from "./workspace-mounts.js";

export type InspectedSandboxMount = {
  type: string;
  source: string;
  destination: string;
  writable: boolean;
};

const SELF_INSPECT_TIMEOUT_MS = 5_000;
const MAX_SELF_CANDIDATES = 8;
const SELF_IDENTITY_PROBE =
  'const fs=require("node:fs");process.stdout.write(JSON.stringify([fs.readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim(),fs.readlinkSync("/proc/self/ns/mnt")]));';
let sourceNamespace:
  | { key: string; mounts: Promise<readonly InspectedSandboxMount[] | undefined> }
  | undefined;

export function parseInspectedSandboxMounts(
  value: unknown,
  tmpfs?: unknown,
): InspectedSandboxMount[] {
  if (!Array.isArray(value)) {
    throw new Error("Container inspect did not return a mount table.");
  }
  const mounts = value.map((mount: unknown) => {
    if (
      !isRecord(mount) ||
      typeof mount.Type !== "string" ||
      typeof mount.Destination !== "string" ||
      !path.posix.isAbsolute(mount.Destination) ||
      typeof mount.RW !== "boolean" ||
      (mount.Type === "bind" &&
        (typeof mount.Source !== "string" || !isSandboxHostPathAbsolute(mount.Source)))
    ) {
      throw new Error("Container inspect returned an invalid mount entry.");
    }
    return {
      type: mount.Type,
      source: typeof mount.Source === "string" ? normalizeSandboxHostPath(mount.Source) : "",
      destination: normalizeMountContainerPath(mount.Destination),
      writable: mount.RW,
    };
  });
  if (tmpfs != null && !isRecord(tmpfs)) {
    throw new Error("Container inspect returned invalid tmpfs destinations.");
  }
  // Docker --tmpfs is stored separately and hides any bind at the same target.
  // Include it so neither source translation nor retained-container checks see
  // the obscured host files instead of the Gateway's effective filesystem.
  for (const [destination, options] of Object.entries(tmpfs ?? {})) {
    if (!path.posix.isAbsolute(destination) || typeof options !== "string") {
      throw new Error("Container inspect returned an invalid tmpfs destination.");
    }
    mounts.push({
      type: "tmpfs",
      source: "",
      destination: normalizeMountContainerPath(destination),
      writable: !sandboxMountOptionsReadOnly(options),
    });
  }
  return [...new Map(mounts.map((mount) => [mount.destination, mount])).values()];
}

function readOptionalProcFile(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

async function discoverSourceNamespace(
  engine: SandboxContainerEngine,
): Promise<readonly InspectedSandboxMount[] | undefined> {
  if (engine.id !== "docker" || process.platform !== "linux") {
    return undefined;
  }
  const cgroup = readOptionalProcFile("/proc/self/cgroup");
  const ids: string[] = [];
  for (const match of cgroup.matchAll(/(?:\/docker\/|docker-)([a-f0-9]{64})(?:\/|\.scope|$)/gm)) {
    const id = match[1];
    if (id) {
      ids.push(id);
    }
  }
  // Host mount tables also contain other containers' IDs. Only Docker's mounts
  // of this process's own hostname/resolver files identify a self candidate.
  for (const line of readOptionalProcFile("/proc/self/mountinfo").split("\n")) {
    const fields = line.split(" ");
    if (!/^\/etc\/(?:hosts|hostname|resolv\.conf)$/.test(fields[4] ?? "")) {
      continue;
    }
    const id = fields[3]?.match(
      /\/containers\/([a-f0-9]{64})\/(?:hosts|hostname|resolv\.conf)$/,
    )?.[1];
    if (id) {
      ids.push(id);
    }
  }
  if (!fs.existsSync("/.dockerenv") && !fs.existsSync("/run/.containerenv") && ids.length === 0) {
    return undefined;
  }
  const candidates = [...new Set([os.hostname(), ...ids])].slice(0, MAX_SELF_CANDIDATES);
  const signal = AbortSignal.timeout(SELF_INSPECT_TIMEOUT_MS);
  let lastError: unknown;
  try {
    const identity = JSON.stringify([
      fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      fs.readlinkSync("/proc/self/ns/mnt"),
    ]);
    // A hostname or cgroup ID is only a candidate. Prove the selected daemon's
    // container shares this process's kernel and mount namespace before trusting
    // its host paths; private cgroup-v2 namespaces often contain no container ID.
    for (const candidate of candidates) {
      try {
        const result = await execContainer(
          engine,
          [
            "inspect",
            "--type",
            "container",
            "--format",
            // Docker templates use the Go field ID. The JSON spelling Id forces
            // raw-map fallback, where an omitted Tmpfs field fails inspection.
            '{"Id":{{json .ID}},"Mounts":{{json .Mounts}},"Tmpfs":{{json .HostConfig.Tmpfs}}}',
            candidate,
          ],
          {
            signal,
          },
        );
        const container: unknown = JSON.parse(result.stdout);
        if (
          !isRecord(container) ||
          typeof container.Id !== "string" ||
          !/^[a-f0-9]{64}$/.test(container.Id)
        ) {
          throw new Error("Container inspect did not return a full container ID.");
        }
        const probe = await execContainer(
          engine,
          ["exec", container.Id, process.execPath, "-e", SELF_IDENTITY_PROBE],
          { signal },
        );
        if (probe.stdout !== identity) {
          throw new Error("The selected Docker daemon did not identify this Gateway container.");
        }
        return parseInspectedSandboxMounts(container.Mounts, container.Tmpfs);
      } catch (error) {
        lastError = error;
        if (signal.aborted) {
          break;
        }
      }
    }
  } catch (error) {
    lastError = error;
  }
  throw new Error(
    "Cannot resolve sandbox bind sources from this Gateway container. Connect Docker to the daemon that runs the Gateway and make its container inspectable, then restart the Gateway. A hostname alone cannot establish container identity.",
    { cause: lastError },
  );
}

export async function resolveDockerSourceNamespace(
  engine: SandboxContainerEngine,
): Promise<readonly InspectedSandboxMount[] | undefined> {
  if (engine.id !== "docker" || process.platform !== "linux") {
    return undefined;
  }
  const key = JSON.stringify([engine, process.env.DOCKER_HOST, process.env.DOCKER_CONTEXT]);
  if (sourceNamespace?.key === key) {
    return await sourceNamespace.mounts;
  }
  const pending = { key, mounts: discoverSourceNamespace(engine) };
  sourceNamespace = pending;
  try {
    return await pending.mounts;
  } catch (error) {
    // A temporary daemon failure must not become a permanent identity mapping.
    if (sourceNamespace === pending) {
      sourceNamespace = undefined;
    }
    throw error;
  }
}

export function translateSandboxMountSources(params: {
  source: string;
  containerPath: string;
  allowedRoots: readonly string[];
  mounts: readonly InspectedSandboxMount[];
  readOnly: boolean;
  shadowedTargets: readonly string[];
}): ManagedWorkspaceMount[] {
  const source = fs.realpathSync(params.source);
  if (!params.allowedRoots.some((root) => isPathInside(fs.realpathSync(root), source))) {
    throw new Error(`Sandbox mount source ${params.source} escapes its Gateway workspace roots.`);
  }
  const mount = params.mounts
    .filter((entry) => isPathInside(entry.destination, source))
    .toSorted((a, b) => b.destination.length - a.destination.length)[0];
  if (!mount || mount.type !== "bind") {
    throw new Error(
      `Sandbox mount source ${params.source} ${mount ? `uses an unsupported ${mount.type} mount` : "is not backed by a Gateway bind mount"}. Bind-mount the workspace and OpenClaw state directories from the Docker host into the Gateway, then restart the Gateway.`,
    );
  }
  if (!mount.writable && !params.readOnly) {
    throw new Error(
      `Sandbox mount source ${params.source} is read-only in the Gateway. Use workspaceAccess=ro or make the Gateway bind writable before requesting a writable sandbox.`,
    );
  }
  const containerPath = normalizeMountContainerPath(params.containerPath);
  const translated = [
    {
      // Only the Gateway namespace is locally resolvable. Inspect's Source is
      // authoritative; local realpath/stat would check an unrelated host path.
      hostPath: path.posix.join(mount.source, path.posix.relative(mount.destination, source)),
      containerPath,
      readOnly: params.readOnly,
    },
  ];
  // Gateway-only submounts do not propagate through a sibling's host bind.
  // Project visible children too, except where another final mount takes over.
  for (const child of params.mounts.toSorted((a, b) =>
    a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0,
  )) {
    if (child.destination === source || !isPathInside(source, child.destination)) {
      continue;
    }
    const target = normalizeMountContainerPath(
      path.posix.join(containerPath, path.posix.relative(source, child.destination)),
    );
    if (params.shadowedTargets.some((shadow) => isPathInside(shadow, target))) {
      continue;
    }
    if (child.type !== "bind") {
      throw new Error(
        `Sandbox mount source ${child.destination} uses an unsupported nested ${child.type} mount. Use Gateway bind mounts for this subtree or replace its sandbox destination with an explicit Docker bind, then restart the Gateway.`,
      );
    }
    if (!isPathInside(source, fs.realpathSync(child.destination))) {
      throw new Error(
        `Sandbox mount source ${child.destination} escapes its Gateway workspace root.`,
      );
    }
    translated.push({
      hostPath: child.source,
      containerPath: target,
      readOnly: params.readOnly || !child.writable,
    });
  }
  return translated;
}
