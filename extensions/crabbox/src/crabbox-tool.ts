import { createHash } from "node:crypto";
import { readPositiveIntegerParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";

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

function operationId(sessionId: string, toolCallId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([sessionId, toolCallId]))
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
    async execute(toolCallId, rawArgs, signal) {
      signal?.throwIfAborted();
      // SAFETY: the tool executor validates the declared object schema before calling execute.
      const params = rawArgs as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const environmentId = readStringParam(params, "environmentId");
      const target = environmentId ? { environmentId } : {};
      if (action === "profiles") {
        const catalog = await gateway.request<{
          profiles?: Array<{ id: string; providerId: string }>;
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
        return jsonResult({ profiles: machineProfiles });
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
        return jsonResult(
          await gateway.request(
            "environments.session.create",
            {
              profileId,
              idempotencyKey: operationId(sessionId, toolCallId),
              ...(os ? { os } : {}),
              ...(machineClass ? { machineClass } : {}),
              ...(presentation ? { presentation } : {}),
            },
            { timeoutMs: 20 * 60_000, scopes: ["operator.admin"] },
          ),
        );
      }
      if (action === "status" || action === "stop") {
        return jsonResult(
          await gateway.request(
            action === "status" ? "environments.session.status" : "environments.session.destroy",
            target,
            {
              timeoutMs: action === "stop" ? 10 * 60_000 : 30_000,
              scopes: [action === "stop" ? "operator.admin" : "operator.read"],
            },
          ),
        );
      }
      if (action === "exec") {
        const argv = params.argv;
        if (
          !Array.isArray(argv) ||
          argv.length === 0 ||
          !argv.every((arg) => typeof arg === "string")
        ) {
          throw new Error("argv must be a non-empty array of strings");
        }
        const input = readStringParam(params, "input", { trim: false, allowEmpty: true });
        const timeoutMs = readPositiveIntegerParam(params, "timeoutMs", { max: 600_000 });
        if (params.background !== undefined && typeof params.background !== "boolean") {
          throw new Error("background must be a boolean");
        }
        const processId =
          params.background === true ? `app-${operationId(sessionId, toolCallId)}` : undefined;
        try {
          return jsonResult(
            await gateway.request(
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
            `${error instanceof Error ? error.message : String(error)}\nBackground processId: ${processId}. Check process_status for this ID before retrying; a failed response does not prove that the app failed to start.`,
            { cause: error },
          );
        }
      }
      if (action === "process_status" || action === "process_stop") {
        return jsonResult(
          await gateway.request(
            "environments.session.exec",
            {
              ...target,
              action: action === "process_status" ? "status" : "stop",
              processId: readStringParam(params, "processId", { required: true }),
            },
            { timeoutMs: 60_000, scopes: ["operator.admin"] },
          ),
        );
      }
      throw new Error(`Unknown Crabbox action: ${action}`);
    },
  };
}
