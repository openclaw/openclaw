import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { promptConfirm, promptSelect, promptText } from "../utils/prompt.js";

type ProfileId = "safe" | "dev" | "integrations";

export type InitCommandOptions = {
  cwd: string;
  profile?: string;
  force: boolean;
};

type DraftConfig = {
  schema_version: "openclaw_env.v1";
  openclaw: { image: string; command?: string[]; env: Record<string, string> };
  workspace: { path: string; mode: "ro" | "rw"; write_allowlist: string[] };
  mounts: Array<{ host: string; container: string; mode: "ro" | "rw" }>;
  network: { mode: "off" | "full" | "restricted"; restricted: { allowlist: string[] } };
  secrets: {
    mode: "none" | "env_file" | "docker_secrets";
    env_file: string;
    docker_secrets: Array<{ name: string; file: string }>;
  };
  limits: { cpus: number; memory: string; pids: number };
  runtime: { user: string };
  write_guards: {
    enabled: boolean;
    max_file_writes?: number;
    max_bytes_written?: number;
    dry_run_audit: boolean;
    poll_interval_ms: number;
  };
};

type MountPresetId = "data_rw" | "gitconfig_ro" | "ssh_never";

function parseProfile(input?: string): ProfileId | null {
  const raw = (input ?? "").trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (raw === "safe" || raw === "dev" || raw === "integrations") {
    return raw;
  }
  return null;
}

function defaultAllowlistForProfile(profile: ProfileId): string[] {
  if (profile === "safe") {
    return [];
  }
  // Keep this small but practical for common dev workflows.
  return [
    "api.openai.com",
    "api.anthropic.com",
    "github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "registry.npmjs.org",
    "pypi.org",
    "files.pythonhosted.org",
  ];
}

function defaultDraft(profile: ProfileId): DraftConfig {
  const workspaceMode: "ro" | "rw" = profile === "safe" ? "ro" : "rw";
  const networkMode: "off" | "full" | "restricted" = profile === "safe" ? "off" : "restricted";
  const secretsMode: "none" | "env_file" | "docker_secrets" =
    profile === "integrations" ? "env_file" : "none";

  return {
    schema_version: "openclaw_env.v1",
    openclaw: {
      image: "openclaw:local",
      env: {
        OPENCLAW_LOG_LEVEL: "info",
      },
    },
    workspace: {
      path: ".",
      mode: workspaceMode,
      write_allowlist: [],
    },
    mounts: [],
    network: {
      mode: networkMode,
      restricted: {
        allowlist: defaultAllowlistForProfile(profile),
      },
    },
    secrets: {
      mode: secretsMode,
      env_file: ".env.openclaw",
      docker_secrets: [],
    },
    limits: {
      cpus: 2,
      memory: "4g",
      pids: 256,
    },
    runtime: {
      user: "1000:1000",
    },
    write_guards: {
      enabled: false,
      dry_run_audit: false,
      poll_interval_ms: 2000,
    },
  };
}

function parseCsvList(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseNumberLike(input: string, fallback: number): number {
  const n = Number.parseFloat(String(input).trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseIntegerLike(input: string, fallback: number): number {
  return Math.trunc(parseNumberLike(input, fallback));
}

function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function presetMount(preset: MountPresetId): {
  mount?: DraftConfig["mounts"][number];
  blockedReason?: string;
} {
  if (preset === "data_rw") {
    return {
      mount: {
        host: "./data",
        container: "/workspace/data",
        mode: "rw",
      },
    };
  }
  if (preset === "gitconfig_ro") {
    return {
      mount: {
        host: "~/.gitconfig",
        container: "/state/home/.gitconfig",
        mode: "ro",
      },
    };
  }
  return {
    blockedReason: "Preset ~/.ssh is intentionally blocked (NEVER) to reduce secret exposure.",
  };
}

async function confirmOverwrite(configPath: string): Promise<boolean> {
  return promptConfirm({
    message: `File exists: ${configPath}. Overwrite?`,
    defaultValue: false,
  });
}

export async function initCommand(opts: InitCommandOptions): Promise<void> {
  const configPath = path.resolve(opts.cwd, "openclaw.env.yml");
  const outputDir = path.resolve(opts.cwd, ".openclaw-env");

  const existing = await fs
    .access(configPath)
    .then(() => true)
    .catch(() => false);
  if (existing && !opts.force) {
    const ok = await confirmOverwrite(configPath);
    if (!ok) {
      process.stdout.write("Aborted.\n");
      return;
    }
  }

  const chosenProfile = parseProfile(opts.profile);

  const baseProfile: ProfileId =
    chosenProfile ??
    (await promptSelect({
      message: "Choose a preset profile",
      options: [
        { label: "safe (workspace ro, network off, secrets none)", value: "safe" },
        { label: "dev (workspace rw, network restricted, secrets none)", value: "dev" },
        {
          label: "integrations (workspace rw, restricted, secrets env_file)",
          value: "integrations",
        },
      ],
      defaultValue: "safe",
    }));

  const draft = defaultDraft(baseProfile);

  const image = await promptText({
    message: "OpenClaw image",
    defaultValue: draft.openclaw.image,
  });
  const workspaceMode = await promptSelect<"ro" | "rw">({
    message: "Workspace access",
    options: [
      { label: "read-only (ro)", value: "ro" },
      { label: "read-write (rw)", value: "rw" },
    ],
    defaultValue: draft.workspace.mode,
  });
  const workspaceWriteAllowlistInput =
    workspaceMode === "ro"
      ? await promptText({
          message:
            "Workspace write allowlist subpaths (comma-separated, relative to workspace; empty = none)",
          defaultValue: "",
        })
      : "";
  const networkMode = await promptSelect<"off" | "full" | "restricted">({
    message: "Network mode",
    options: [
      { label: "off (no network)", value: "off" },
      { label: "restricted (egress proxy allowlist)", value: "restricted" },
      { label: "full (unrestricted)", value: "full" },
    ],
    defaultValue: draft.network.mode,
  });
  const allowlist =
    networkMode === "restricted"
      ? await promptText({
          message: "Restricted allowlist domains (comma-separated)",
          defaultValue: draft.network.restricted.allowlist.join(", "),
        })
      : "";
  const secretsMode = await promptSelect<"none" | "env_file" | "docker_secrets">({
    message: "Secrets mode",
    options: [
      { label: "none", value: "none" },
      { label: "env_file (path only)", value: "env_file" },
      { label: "docker_secrets (names + files)", value: "docker_secrets" },
    ],
    defaultValue: draft.secrets.mode,
  });
  const envFile =
    secretsMode === "env_file"
      ? await promptText({
          message: "Env file path (relative to repo)",
          defaultValue: draft.secrets.env_file,
        })
      : "";
  const cpus = await promptText({
    message: "CPU limit (e.g. 2)",
    defaultValue: String(draft.limits.cpus),
  });
  const memory = await promptText({
    message: "Memory limit (e.g. 4g)",
    defaultValue: draft.limits.memory,
  });
  const pids = await promptText({
    message: "PIDs limit (e.g. 256)",
    defaultValue: String(draft.limits.pids),
  });
  const user = await promptText({
    message: "Container user (uid:gid)",
    defaultValue: draft.runtime.user,
  });

  const enableWriteGuards = await promptConfirm({
    message: "Enable write guards (max file writes / max bytes)?",
    defaultValue: false,
  });
  const maxFileWritesInput = enableWriteGuards
    ? await promptText({
        message: "Max file writes before stop (integer; empty = unset)",
        defaultValue: "200",
      })
    : "";
  const maxBytesWrittenInput = enableWriteGuards
    ? await promptText({
        message: "Max bytes written before stop (integer; empty = unset)",
        defaultValue: "10485760",
      })
    : "";
  const dryRunAudit = enableWriteGuards
    ? await promptConfirm({
        message: "Dry-run write audit only (log limit breaches, do not stop)?",
        defaultValue: false,
      })
    : false;

  const mounts: DraftConfig["mounts"] = [];
  while (true) {
    const usePreset = await promptConfirm({
      message: "Apply a mount preset?",
      defaultValue: false,
    });
    if (!usePreset) {
      break;
    }
    const preset = await promptSelect<MountPresetId | "done">({
      message: "Choose a mount preset",
      options: [
        { label: "mount ./data rw", value: "data_rw" },
        { label: "mount ~/.gitconfig ro", value: "gitconfig_ro" },
        { label: "mount ~/.ssh NEVER", value: "ssh_never" },
        { label: "done", value: "done" },
      ],
      defaultValue: "data_rw",
    });
    if (preset === "done") {
      break;
    }
    const picked = presetMount(preset);
    if (picked.blockedReason) {
      process.stdout.write(`${picked.blockedReason}\n`);
      continue;
    }
    if (!picked.mount) {
      continue;
    }
    const duplicate = mounts.some(
      (m) => m.host === picked.mount?.host && m.container === picked.mount?.container,
    );
    if (duplicate) {
      process.stdout.write("Preset mount already present. Skipping.\n");
      continue;
    }
    mounts.push(picked.mount);
    process.stdout.write(
      `Added preset mount: ${picked.mount.host} -> ${picked.mount.container} (${picked.mount.mode})\n`,
    );
  }

  while (true) {
    const addMount = await promptConfirm({
      message: "Add an extra mount?",
      defaultValue: false,
    });
    if (!addMount) {
      break;
    }
    const host = await promptText({ message: "Host path (relative to repo ok)" });
    const container = await promptText({ message: "Container path (e.g. /data)" });
    const mode = await promptSelect<"ro" | "rw">({
      message: "Mount mode",
      options: [
        { label: "read-only (ro)", value: "ro" },
        { label: "read-write (rw)", value: "rw" },
      ],
      defaultValue: "ro",
    });
    if (host.trim() && container.trim()) {
      mounts.push({ host: host.trim(), container: container.trim(), mode });
    }
  }

  const dockerSecrets: DraftConfig["secrets"]["docker_secrets"] = [];
  if (secretsMode === "docker_secrets") {
    while (true) {
      const addSecret = await promptConfirm({
        message: "Add a docker secret?",
        defaultValue: false,
      });
      if (!addSecret) {
        break;
      }
      const name = await promptText({ message: "Secret name (used as /run/secrets/<name>)" });
      const file = await promptText({ message: "Secret file path (relative to repo ok)" });
      if (name.trim() && file.trim()) {
        dockerSecrets.push({ name: name.trim(), file: file.trim() });
      }
    }
  }

  const workspaceWriteAllowlist =
    workspaceMode === "ro"
      ? dedupeStrings(
          parseCsvList(workspaceWriteAllowlistInput)
            .map((s) => s.trim().replace(/\\/g, "/").replace(/^\/+/, ""))
            .filter((s) => Boolean(s) && s !== "." && s !== ".."),
        )
      : [];

  const maxFileWrites =
    enableWriteGuards && maxFileWritesInput.trim().length > 0
      ? parseIntegerLike(maxFileWritesInput, 200)
      : undefined;
  const maxBytesWritten =
    enableWriteGuards && maxBytesWrittenInput.trim().length > 0
      ? parseIntegerLike(maxBytesWrittenInput, 10_485_760)
      : undefined;

  const config: DraftConfig = {
    ...draft,
    openclaw: {
      ...draft.openclaw,
      image: image.trim() || draft.openclaw.image,
    },
    workspace: {
      ...draft.workspace,
      mode: workspaceMode,
      write_allowlist: workspaceWriteAllowlist,
    },
    mounts,
    network: {
      mode: networkMode,
      restricted: {
        allowlist: networkMode === "restricted" ? parseCsvList(allowlist) : [],
      },
    },
    secrets: {
      mode: secretsMode,
      env_file: envFile.trim() || draft.secrets.env_file,
      docker_secrets: dockerSecrets,
    },
    limits: {
      cpus: parseNumberLike(cpus, draft.limits.cpus),
      memory: memory.trim() || draft.limits.memory,
      pids: Math.trunc(parseNumberLike(pids, draft.limits.pids)),
    },
    runtime: {
      user: user.trim() || draft.runtime.user,
    },
    write_guards: {
      enabled:
        enableWriteGuards ||
        dryRunAudit ||
        maxFileWrites !== undefined ||
        maxBytesWritten !== undefined,
      max_file_writes: maxFileWrites,
      max_bytes_written: maxBytesWritten,
      dry_run_audit: dryRunAudit,
      poll_interval_ms: draft.write_guards.poll_interval_ms,
    },
  };

  const yaml = YAML.stringify(config, { lineWidth: 0 });
  await fs.writeFile(configPath, yaml, "utf-8");
  await fs.mkdir(outputDir, { recursive: true });

  process.stdout.write(`Wrote ${configPath}\n`);
  process.stdout.write(`Created ${outputDir}/\n`);
  process.stdout.write("Next:\n");
  process.stdout.write("  openclaw-env print\n");
  process.stdout.write("  openclaw-env up\n");
}
