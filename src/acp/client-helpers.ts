import * as readline from "node:readline";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "../plugin-sdk/windows-spawn.js";
import {
  listKnownProviderAuthEnvVarNamesCore,
  omitEnvKeysCaseInsensitive,
} from "../secrets/provider-env-vars.js";
import { classifyAcpToolApproval } from "./approval-classifier.js";

type PermissionResolverDeps = {
  prompt?: (toolName: string | undefined, toolTitle?: string) => Promise<boolean>;
  log?: (line: string) => void;
  cwd?: string;
  signal?: AbortSignal;
};

function promptUserPermission(
  toolName: string | undefined,
  toolTitle?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    console.error(`[permission denied] ${toolName ?? "unknown"}: non-interactive terminal`);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    const finish = (approved: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onClose);
      rl.off("close", onClose);
      rl.close();
      resolve(approved);
    };

    const onClose = () => finish(false);
    rl.once("close", onClose);
    signal?.addEventListener("abort", onClose, { once: true });
    const timeout = setTimeout(() => {
      console.error(`\n[permission timeout] denied: ${toolName ?? "unknown"}`);
      finish(false);
    }, 30_000);

    const label = toolTitle
      ? toolName
        ? `${toolTitle} (${toolName})`
        : toolTitle
      : (toolName ?? "unknown tool");
    rl.question(`\n[permission] Allow "${label}"? (y/N) `, (answer) => {
      const approved = normalizeLowercaseStringOrEmpty(answer) === "y";
      console.error(`[permission ${approved ? "approved" : "denied"}] ${toolName ?? "unknown"}`);
      finish(approved);
    });
  });
}

export async function resolvePermissionRequest(
  params: RequestPermissionRequest,
  deps: PermissionResolverDeps = {},
): Promise<RequestPermissionResponse> {
  const log = deps.log ?? ((line: string) => console.error(line));
  if (deps.signal?.aborted) {
    return { outcome: { outcome: "cancelled" } };
  }
  const prompt =
    deps.prompt ?? ((toolName, title) => promptUserPermission(toolName, title, deps.signal));
  const cwd = deps.cwd ?? process.cwd();
  const options = params.options ?? [];
  const toolTitle = sanitizeTerminalText(params.toolCall?.title ?? "tool");
  const classification = classifyAcpToolApproval({ toolCall: params.toolCall, cwd });
  const toolName = classification.toolName;
  const toolKind =
    !toolName && classification.approvalClass === "unknown"
      ? undefined
      : classification.approvalClass;

  if (options.length === 0) {
    log(`[permission cancelled] ${toolName ?? "unknown"}: no options available`);
    return { outcome: { outcome: "cancelled" } };
  }

  const allowOption =
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => option.kind === "allow_always");
  const rejectOption =
    options.find((option) => option.kind === "reject_once") ??
    options.find((option) => option.kind === "reject_always");
  if (classification.autoApprove) {
    if (!allowOption) {
      log(`[permission cancelled] ${toolName ?? "unknown"}: missing allow option`);
      return { outcome: { outcome: "cancelled" } };
    }
    log(`[permission auto-approved] ${toolName} (${toolKind ?? "unknown"})`);
    return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
  }

  log(
    `\n[permission requested] ${toolTitle}${toolName ? ` (${toolName})` : ""}${toolKind ? ` [${toolKind}]` : ""}`,
  );
  const approved = await prompt(toolName, toolTitle);
  if (deps.signal?.aborted) {
    return { outcome: { outcome: "cancelled" } };
  }

  if (approved && allowOption) {
    return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
  }
  if (!approved && rejectOption) {
    return { outcome: { outcome: "selected", optionId: rejectOption.optionId } };
  }

  log(
    `[permission cancelled] ${toolName ?? "unknown"}: missing ${approved ? "allow" : "reject"} option`,
  );
  return { outcome: { outcome: "cancelled" } };
}

type AcpClientSpawnEnvOptions = {
  stripKeys?: Iterable<string>;
};

export function resolveAcpClientSpawnEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: AcpClientSpawnEnvOptions = {},
): NodeJS.ProcessEnv {
  const env = omitEnvKeysCaseInsensitive(baseEnv, options.stripKeys ?? []);
  env.OPENCLAW_SHELL = "acp-client";
  return env;
}

export function shouldStripProviderAuthEnvVarsForAcpServer(
  params: {
    serverCommand?: string;
    serverArgs?: string[];
    defaultServerCommand?: string;
    defaultServerArgs?: string[];
  } = {},
): boolean {
  const serverCommand = normalizeOptionalString(params.serverCommand);
  if (!serverCommand) {
    return true;
  }
  const defaultServerCommand = normalizeOptionalString(params.defaultServerCommand);
  if (!defaultServerCommand || serverCommand !== defaultServerCommand) {
    return false;
  }
  const serverArgs = params.serverArgs ?? [];
  const defaultServerArgs = params.defaultServerArgs ?? [];
  return (
    serverArgs.length === defaultServerArgs.length &&
    serverArgs.every((arg, index) => arg === defaultServerArgs[index])
  );
}

export function buildAcpClientStripKeys(params: {
  stripProviderAuthEnvVars?: boolean;
  activeSkillEnvKeys?: Iterable<string>;
}): Set<string> {
  const stripKeys = new Set<string>(params.activeSkillEnvKeys ?? []);
  if (params.stripProviderAuthEnvVars) {
    for (const key of listKnownProviderAuthEnvVarNamesCore()) {
      stripKeys.add(key);
    }
  }
  return stripKeys;
}

type AcpSpawnRuntime = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
};

const DEFAULT_ACP_SPAWN_RUNTIME: AcpSpawnRuntime = {
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
};

export function resolveAcpClientSpawnInvocation(
  params: { serverCommand: string; serverArgs: string[] },
  runtime: AcpSpawnRuntime = DEFAULT_ACP_SPAWN_RUNTIME,
): { command: string; args: string[]; shell?: boolean; windowsHide?: boolean } {
  const program = resolveWindowsSpawnProgram({
    command: params.serverCommand,
    platform: runtime.platform,
    env: runtime.env,
    execPath: runtime.execPath,
    packageName: "openclaw",
  });
  const resolved = materializeWindowsSpawnProgram(program, params.serverArgs);
  return {
    command: resolved.command,
    args: resolved.argv,
    shell: resolved.shell,
    windowsHide: resolved.windowsHide,
  };
}
