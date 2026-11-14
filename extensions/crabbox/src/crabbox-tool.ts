import { createHash } from "node:crypto";
import { isStringArray } from "openclaw/plugin-sdk/collection-input-runtime";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { readPositiveIntegerParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  WorkerMachineOption,
} from "openclaw/plugin-sdk/plugin-entry";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { textResult } from "openclaw/plugin-sdk/tool-results";

// These are the fields used for presentation, not replacements for Gateway receipts.
type CrabboxEnvironment = {
  id: string;
  status: string;
  worker: { state: string; error?: string };
};
type CrabboxAttachment = { environmentId: string };
type CrabboxProfile = {
  id: string;
  providerId: string;
  machines?: WorkerMachineOption[];
  operatingSystems?: Array<{ id: string; disabledReason?: string }>;
};
type CrabboxExecResult = SpawnResult & {
  environmentId: string;
  workspaceDir: string;
  process?: { processId: string; state: "running" | "exited" };
};

function crabboxEnvironmentText(environment: CrabboxEnvironment): string {
  return `Environment: ${environment.status} (${environment.worker.state}).${environment.worker.error ? `\n${environment.worker.error}` : ""}`;
}

function crabboxExecResult(result: CrabboxExecResult) {
  const process = result.process;
  const summary = process
    ? `Process ${process.processId}: ${process.state}.` +
      (process.state === "running" ? " App readiness has not been checked." : "")
    : result.code === 0 && result.termination === "exit"
      ? "Command completed."
      : "Command failed.";
  const lines = [
    summary,
    `exit code: ${result.code}; termination: ${result.termination}; signal: ${result.signal}; killed: ${result.killed}`,
    `Environment: ${result.environmentId}; workspace: ${result.workspaceDir}`,
  ];
  if (result.stdoutTruncatedBytes) {
    lines.push(`stdout truncated: ${result.stdoutTruncatedBytes} bytes`);
  }
  if (result.stderrTruncatedBytes) {
    lines.push(`stderr truncated: ${result.stderrTruncatedBytes} bytes`);
  }
  if (result.outputLimitExceeded) {
    lines.push(
      `Output limit exceeded${result.outputErrorStream ? ` (${result.outputErrorStream})` : ""}.`,
    );
  }
  // Keep output bytes intact; Code Mode also consumes the unchanged structured receipt.
  return textResult(
    `${lines.join("\n")}\n\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    result,
  );
}

const CRABBOX_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["profiles", "create", "status", "exec", "process_status", "process_stop", "stop"],
    },
    profileId: {
      type: "string",
      description: "create: configured Crabbox profile; optional when only one is configured.",
    },
    environmentId: {
      type: "string",
      description: "Target attached to this conversation. Omit to use its current attachment.",
    },
    os: { type: "string", description: "create: an operating system advertised by the profile." },
    machineClass: {
      type: "string",
      description: "create: a machine class advertised by the profile.",
    },
    presentation: {
      type: "string",
      enum: ["desktop", "portal"],
      description:
        "create: for open-and-show requests, open the native Desktop or web Portal sidebar immediately with provisioning progress. Omit when no viewer was requested.",
    },
    argv: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 128,
      description:
        "exec: executable and arguments, run in the remote workspace. Use a shell explicitly for shell syntax.",
    },
    input: { type: "string", description: "exec: bounded standard input for the command." },
    timeoutMs: {
      type: "integer",
      minimum: 1,
      maximum: 600000,
      description: "exec: foreground command timeout.",
    },
    background: {
      type: "boolean",
      description: "exec: start an owned app/server that survives this turn. Returns processId.",
    },
    processId: {
      type: "string",
      description: "process_status/process_stop: identifier returned by background exec.",
    },
  },
} as const;

type CrabboxToolOptions = {
  context: OpenClawPluginToolContext;
  gateway: OpenClawPluginApi["runtime"]["gateway"];
};

// Unchanged attachment state dedupes in-flight creates; the service reuses live boxes.
// After stop, the previous attachment distinguishes a new create with a repeated call ID.
function operationId(
  sessionId: string,
  toolCallId: string,
  previousEnvironmentId?: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        previousEnvironmentId
          ? [sessionId, toolCallId, previousEnvironmentId]
          : [sessionId, toolCallId],
      ),
    )
    .digest("hex");
}

export function createCrabboxTool({ context, gateway }: CrabboxToolOptions): AnyAgentTool | null {
  const config = () => context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config;
  const profiles = () =>
    Object.entries(config()?.cloudWorkers?.profiles ?? {}).filter(
      ([, profile]) => profile.provider === "crabbox",
    );
  if (context.sandboxed || !context.sessionKey || !context.sessionId || profiles().length === 0) {
    return null;
  }
  const sessionId = context.sessionId;
  return {
    name: "crabbox",
    label: "Crabbox",
    description:
      "Create and use a temporary Crabbox attached to this conversation while keeping the agent and its main workspace in place. profiles lists configured machines and desktop capability; create reuses the current attachment. For open-and-show requests, pass presentation=desktop for native apps or portal for web apps to open the sidebar during provisioning. exec runs commands there, with background=true for persistent apps and servers. Inspect/stop owned processes or stop the entire box. Desktop-enabled profiles support native app viewing and computer use. Read the crabbox-apps skill for the complete workflow.",
    parameters: CRABBOX_TOOL_PARAMETERS,
    resultContentSource: "network",
    async execute(toolCallId, rawArgs, signal, onUpdate) {
      signal?.throwIfAborted();
      // SAFETY: the tool executor validates the declared object schema before calling execute.
      const params = rawArgs as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const environmentId = readStringParam(params, "environmentId");
      const target = environmentId ? { environmentId } : {};
      const reportProgress = (text: string) => {
        try {
          onUpdate?.({
            ...textResult(text, { action, status: "running" }),
            progress: { text, visibility: "channel", privacy: "public" },
          });
        } catch {
          // Optional display feedback must not change command dispatch or reconciliation.
        }
      };
      if (action === "profiles") {
        const catalog = await gateway.request<{
          profiles?: CrabboxProfile[];
        }>("environments.list", { projection: "profiles" });
        const configured = new Map(profiles());
        const machineProfiles = [];
        for (const profile of catalog.profiles ?? []) {
          if (profile.providerId === "crabbox") {
            machineProfiles.push({
              ...profile,
              desktop: configured.get(profile.id)?.settings?.desktop === true,
            });
          }
        }
        const lines = machineProfiles.map((profile) => {
          const choices = [
            profile.desktop ? "desktop enabled" : "desktop disabled",
            ...(profile.operatingSystems?.map((os) =>
              os.disabledReason ? `${os.id} (unavailable: ${os.disabledReason})` : os.id,
            ) ?? []),
            ...(profile.machines?.map(
              (machine) => `${machine.id}${machine.os ? ` (${machine.os})` : ""}`,
            ) ?? []),
          ];
          return `- ${profile.id}: ${choices.join("; ")}`;
        });
        return textResult(
          lines.length
            ? `Crabbox profiles:\n${lines.join("\n")}\nUse action=create with a profileId to create or reuse a Crabbox.`
            : "No Crabbox profiles are currently available.",
          { profiles: machineProfiles },
        );
      }
      if (action === "create") {
        const available = profiles();
        const profileId =
          readStringParam(params, "profileId") ??
          (available.length === 1 ? available[0]?.[0] : undefined);
        if (!profileId || !available.some(([id]) => id === profileId)) {
          throw new Error(
            "Choose a configured Crabbox profile using action=profiles, then pass its profileId to create.",
          );
        }
        const os = readStringParam(params, "os");
        const machineClass = readStringParam(params, "machineClass");
        const presentation = readStringParam(params, "presentation");
        if (presentation !== undefined && presentation !== "desktop" && presentation !== "portal") {
          throw new Error("presentation must be desktop or portal");
        }
        reportProgress("Requesting a Crabbox for this conversation (create or reuse)…");
        const status = await gateway.request<{
          attachment: { environmentId: string } | null;
        }>("environments.session.status", {}, { timeoutMs: 30_000, scopes: ["operator.read"] });
        const result = await gateway.request<{
          attachment: CrabboxAttachment;
          environment: CrabboxEnvironment;
          reused: boolean;
        }>(
          "environments.session.create",
          {
            profileId,
            idempotencyKey: operationId(sessionId, toolCallId, status.attachment?.environmentId),
            ...(os ? { os } : {}),
            ...(machineClass ? { machineClass } : {}),
            ...(presentation ? { presentation } : {}),
          },
          { timeoutMs: 20 * 60_000, scopes: ["operator.admin"] },
        );
        return textResult(
          `${result.reused ? "Reusing" : "Created"} Crabbox ${result.attachment.environmentId}.\n${crabboxEnvironmentText(result.environment)}`,
          result,
        );
      }
      if (action === "status") {
        const result = await gateway.request<
          | { attachment: null }
          | { attachment: CrabboxAttachment; closed: boolean; environment: CrabboxEnvironment }
        >("environments.session.status", target, { timeoutMs: 30_000, scopes: ["operator.read"] });
        if (!result.attachment) {
          return textResult(
            "No Crabbox is attached to this conversation. Use action=create to create one.",
            result,
          );
        }
        return textResult(
          `Crabbox ${result.attachment.environmentId} ${result.closed ? "is no longer attached. Use action=create to create one." : "is attached to this conversation."}\n${crabboxEnvironmentText(result.environment)}`,
          result,
        );
      }
      if (action === "stop") {
        reportProgress("Requesting Crabbox shutdown…");
        const result = await gateway.request<{ stopped: true; environment?: CrabboxEnvironment }>(
          "environments.session.destroy",
          target,
          { timeoutMs: 10 * 60_000, scopes: ["operator.admin"] },
        );
        return textResult(
          result.environment
            ? `Crabbox ${result.environment.id} is detached from this conversation.\n${crabboxEnvironmentText(result.environment)}`
            : "No Crabbox is attached to this conversation. Nothing to stop.",
          result,
        );
      }
      if (action === "exec") {
        const argv = params.argv;
        if (!isStringArray(argv) || argv.length === 0) {
          throw new Error("argv must be a non-empty array of strings");
        }
        const input = readStringParam(params, "input", { trim: false, allowEmpty: true });
        const timeoutMs = readPositiveIntegerParam(params, "timeoutMs", { max: 600_000 });
        if (params.background !== undefined && typeof params.background !== "boolean") {
          throw new Error("background must be a boolean");
        }
        const processId =
          params.background === true ? `app-${operationId(sessionId, toolCallId)}` : undefined;
        reportProgress(
          params.background === true
            ? "Requesting a background process in the attached Crabbox…"
            : "Requesting command execution in the attached Crabbox…",
        );
        try {
          return crabboxExecResult(
            await gateway.request<CrabboxExecResult>(
              "environments.session.exec",
              {
                ...target,
                action: params.background === true ? "start" : "run",
                argv,
                ...(input === undefined ? {} : { input }),
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
                ...(processId ? { processId } : {}),
              },
              {
                timeoutMs: 30 * 60_000 + (timeoutMs ?? 120_000) + 15_000,
                scopes: ["operator.admin"],
              },
            ),
          );
        } catch (error) {
          if (!processId) {
            throw error;
          }
          throw new Error(
            `${coerceErrorMessage(error)}\nBackground processId: ${processId}. Check process_status for this ID before retrying; a failed response does not prove that the app failed to start.`,
            { cause: error },
          );
        }
      }
      if (action === "process_status" || action === "process_stop") {
        const processId = readStringParam(params, "processId", { required: true });
        reportProgress(
          action === "process_stop"
            ? "Requesting background process shutdown…"
            : "Checking the Crabbox background process…",
        );
        return crabboxExecResult(
          await gateway.request<CrabboxExecResult>(
            "environments.session.exec",
            {
              ...target,
              action: action === "process_status" ? "status" : "stop",
              processId,
            },
            { timeoutMs: 60_000, scopes: ["operator.admin"] },
          ),
        );
      }
      throw new Error(`Unknown Crabbox action: ${action}`);
    },
  };
}
