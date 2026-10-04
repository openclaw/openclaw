import { buildPluginConfigSchema, type OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/core";
import {
  formatPluginConfigIssue,
  mapPluginConfigIssues,
} from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_SECONDS } from "openclaw/plugin-sdk/number-runtime";
import { z } from "zod";

const MXC_CONTAINMENTS = ["process", "processcontainer"] as const;
const MXC_NETWORK_MODES = ["none", "default"] as const;

type MxcContainment = (typeof MXC_CONTAINMENTS)[number];

type MxcNetworkMode = (typeof MXC_NETWORK_MODES)[number];

export type MxcConfig = {
  mxcBinaryPath?: string;
  containment: MxcContainment;
  network: MxcNetworkMode;
  timeoutSeconds: number;
  timeoutSecondsConfigured?: boolean;
  debug: boolean;
  mxcPolicyPaths?: string[];
  agents?: Record<string, MxcAgentConfig>;
};

type MxcAgentConfig = Partial<Pick<MxcConfig, "network" | "timeoutSeconds" | "mxcPolicyPaths">>;

// Validate ownership keys, rather than repairing a typo into a different policy owner.
const CANONICAL_AGENT_ID = /^(?!__proto__$|prototype$|constructor$)[a-z0-9_][a-z0-9_-]{0,63}$/;
const ABSOLUTE_POLICY_PATH = /^\s*(?:[a-zA-Z]:[\\/]|[\\/])/;

const DEFAULT_CONTAINMENT: MxcContainment = "process";
const DEFAULT_NETWORK: MxcNetworkMode = "none";
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_DEBUG = false;

const nonEmptyTrimmedString = (message: string) =>
  z.string({ error: message }).trim().min(1, { error: message });

const MxcDefaultConfigSchema = z.strictObject({
  mxcBinaryPath: nonEmptyTrimmedString("mxcBinaryPath must be a non-empty string")
    .describe(
      "Absolute path to the MXC executor (wxc-exec.exe). When unset, the executor is discovered from the installed @microsoft/mxc-sdk.",
    )
    .optional(),
  containment: z
    .enum(MXC_CONTAINMENTS, {
      error: `containment must be one of ${MXC_CONTAINMENTS.join(", ")}`,
    })
    .describe(
      "Windows containment mode. 'process' and 'processcontainer' currently both resolve to the Windows ProcessContainer sandbox.",
    )
    .optional(),
  network: z
    .enum(MXC_NETWORK_MODES, {
      error: `network must be one of ${MXC_NETWORK_MODES.join(", ")}`,
    })
    .describe(
      "Outbound network policy. 'none' blocks all network; 'default' allows outbound access via the internetClient capability.",
    )
    .optional(),
  timeoutSeconds: z
    .number({
      error: `timeoutSeconds must be a number between 1 and ${MAX_TIMER_TIMEOUT_SECONDS}`,
    })
    .min(1, { error: "timeoutSeconds must be a number >= 1" })
    .max(MAX_TIMER_TIMEOUT_SECONDS, {
      error: `timeoutSeconds must be a number <= ${MAX_TIMER_TIMEOUT_SECONDS}`,
    })
    .describe(
      "Per-command execution timeout in seconds. Capped to the sandbox policy baseline timeout when both are set.",
    )
    .optional(),
  debug: z
    .boolean({ error: "debug must be a boolean" })
    .describe("Forward verbose debug output from the MXC SDK launcher.")
    .optional(),
  mxcPolicyPaths: z
    .array(
      nonEmptyTrimmedString("mxcPolicyPaths must be an array of non-empty strings").regex(
        ABSOLUTE_POLICY_PATH,
        "mxcPolicyPaths entries must be absolute paths",
      ),
      {
        error: "mxcPolicyPaths must be an array of non-empty strings",
      },
    )
    .describe(
      "Absolute MXC policy file paths applied on top of the built-in sandbox baseline policy.",
    )
    .optional(),
});

const MxcPluginConfigSchema = MxcDefaultConfigSchema.extend({
  agents: z
    .record(
      z.string().regex(CANONICAL_AGENT_ID),
      MxcDefaultConfigSchema.pick({ network: true, timeoutSeconds: true, mxcPolicyPaths: true }),
    )
    .describe(
      "Per-agent policy defaults overrides, keyed by configured canonical agent ID. Explicit policy file lists replace plugin defaults, including empty lists.",
    )
    .optional(),
});

// Zod records discard __proto__ before validating keys; reject it on the raw input.
// Keep JSON Schema export on the declarative schema above, which rejects it by pattern.
const MxcRuntimeConfigSchema = z.preprocess((value, ctx) => {
  const agents = value && typeof value === "object" && "agents" in value ? value.agents : undefined;
  if (agents && typeof agents === "object" && Object.hasOwn(agents, "__proto__")) {
    ctx.addIssue({
      code: "custom",
      path: ["agents", "__proto__"],
      message: "agents keys must be safe canonical agent IDs",
    });
    return z.NEVER;
  }
  return value;
}, MxcPluginConfigSchema);

export function createMxcPluginConfigSchema(): OpenClawPluginConfigSchema {
  return buildPluginConfigSchema(MxcPluginConfigSchema, {
    safeParse(value) {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      const parsed = MxcRuntimeConfigSchema.safeParse(value);
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }
      return {
        success: false,
        error: {
          issues: mapPluginConfigIssues(parsed.error.issues),
        },
      };
    },
  });
}

export function resolveConfig(value: unknown): MxcConfig {
  if (value === undefined) {
    return {
      mxcBinaryPath: undefined,
      containment: DEFAULT_CONTAINMENT,
      network: DEFAULT_NETWORK,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      debug: DEFAULT_DEBUG,
    };
  }

  const parsed = MxcRuntimeConfigSchema.safeParse(value);
  if (!parsed.success) {
    const message = formatPluginConfigIssue(parsed.error.issues[0]);
    throw new Error(`Invalid mxc plugin config: ${message}`);
  }

  const config = parsed.data;
  const resolved: MxcConfig = {
    mxcBinaryPath: config.mxcBinaryPath,
    containment: config.containment ?? DEFAULT_CONTAINMENT,
    network: config.network ?? DEFAULT_NETWORK,
    timeoutSeconds: config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    debug: config.debug ?? DEFAULT_DEBUG,
    mxcPolicyPaths: config.mxcPolicyPaths,
    ...(config.agents !== undefined ? { agents: config.agents } : {}),
  };

  if (config.timeoutSeconds !== undefined) {
    resolved.timeoutSecondsConfigured = true;
  }

  return resolved;
}

export function resolveMxcAgentConfig(
  config: MxcConfig,
  agentId: string | undefined,
  scope: string,
): MxcConfig {
  const { agents, ...defaults } = config;
  if (Object.keys(agents ?? {}).length > 0 && (!agentId || !CANONICAL_AGENT_ID.test(agentId))) {
    throw new Error(
      "MXC per-agent policy requires a resolved canonical agentId from the host; update OpenClaw.",
    );
  }
  const override =
    agentId && agents && Object.hasOwn(agents, agentId) ? agents[agentId] : undefined;
  if (override && scope === "shared") {
    throw new Error(
      "MXC per-agent policy cannot use shared sandbox scope; select agent or session scope.",
    );
  }
  // Snapshot the selected list: explicit [] replaces default grants, never unions them.
  const policyPaths = override?.mxcPolicyPaths ?? defaults.mxcPolicyPaths;
  return {
    ...defaults,
    network: override?.network ?? defaults.network,
    timeoutSeconds: override?.timeoutSeconds ?? defaults.timeoutSeconds,
    ...(policyPaths !== undefined ? { mxcPolicyPaths: [...policyPaths] } : {}),
    ...(override?.timeoutSeconds !== undefined ? { timeoutSecondsConfigured: true } : {}),
  };
}
