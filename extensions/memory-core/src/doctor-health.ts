import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  asOptionalObjectRecord,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { readDoctorAgentEntries } from "./doctor-agent-config.js";
import {
  LLAMA_CPP_PROVIDER_INSTALL_COMMAND,
  LOCAL_MEMORY_EMBEDDING_PROVIDER_ID,
  MISSING_LOCAL_MEMORY_EMBEDDING_PROVIDER_MESSAGE,
} from "./memory/local-embedding-provider.js";

const MEMORY_INDEX_META_KEY = "memory_index_meta_v1";

type ProviderFailure = {
  provider: string;
  reason: string;
  requirement?: string;
  fixHint?: string;
};
type VectorProviderFinding = ProviderFailure & {
  agentId: string;
  model: string;
  configPrefix: string;
};

type InspectConfiguredProvider = (params: {
  config: OpenClawConfig;
  agentId: string;
  env: NodeJS.ProcessEnv;
}) => Promise<ProviderFailure | null>;

function listConfiguredAgentIds(config: unknown): string[] {
  const { keyed, listed } = readDoctorAgentEntries(config);
  const ids = new Set(Object.keys(keyed ?? {}));
  for (const value of listed) {
    const entry = asOptionalObjectRecord(value);
    if (typeof entry?.id === "string" && entry.id.trim()) {
      ids.add(entry.id.trim());
    }
  }
  return ids.size > 0 ? [...ids] : ["main"];
}

async function readExistingVectorModel(databasePath: string): Promise<string | null> {
  if (!fs.existsSync(databasePath)) {
    return null;
  }
  const { openNodeSqliteDatabase, prepareSqliteReadOnlyLocation } =
    await import("openclaw/plugin-sdk/sqlite-runtime");
  let prepared: Awaited<ReturnType<typeof prepareSqliteReadOnlyLocation>> | undefined;
  let db: ReturnType<typeof openNodeSqliteDatabase> | undefined;
  let failure: unknown;
  let model: string | null = null;
  try {
    // The live agent database is written continuously; a byte-neutral raw copy needs
    // a quiescent WAL and cannot stabilize on a multi-GB live database. Online backup
    // holds an ordinary read transaction, like every Gateway reader.
    prepared = await prepareSqliteReadOnlyLocation(databasePath);
    db = openNodeSqliteDatabase(prepared.location, { readOnly: true });
    const table = db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'memory_index_meta'",
      )
      .get();
    if (table) {
      const row = db
        .prepare("SELECT value FROM memory_index_meta WHERE key = ?")
        .get(MEMORY_INDEX_META_KEY);
      const parsed = typeof row?.value === "string" ? JSON.parse(row.value) : null;
      const configuredModel =
        parsed && typeof parsed === "object" && typeof parsed.model === "string"
          ? parsed.model.trim()
          : "";
      model = configuredModel && configuredModel !== "fts-only" ? configuredModel : null;
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      db?.close();
    } catch (error) {
      failure ??= error;
    }
    if (prepared && !(await prepared.cleanupAsync())) {
      failure ??= new Error("Temporary SQLite inspection snapshot cleanup did not complete.");
    }
  }
  if (failure) {
    throw failure instanceof Error
      ? failure
      : new Error("Memory index inspection failed.", { cause: failure });
  }
  return model;
}

function resolveConfigPrefix(config: unknown, agentId: string): string {
  const { keyed, listed } = readDoctorAgentEntries(config);
  const keyedEntry = asOptionalObjectRecord(keyed?.[agentId]);
  if (asOptionalObjectRecord(keyedEntry?.memory)?.search) {
    return `agents.entries.${agentId}.memory.search`;
  }
  const listedEntry = listed.map(asOptionalObjectRecord).find((entry) => entry?.id === agentId);
  if (asOptionalObjectRecord(listedEntry?.memory)?.search) {
    return `agents.list[].memory.search (agent id ${agentId})`;
  }
  return "memory.search";
}

async function collectVectorProviderFindings(
  params: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    stateDir: string;
    shouldInspectAgent: (agentId: string) => boolean;
  },
  inspectProvider: InspectConfiguredProvider,
): Promise<VectorProviderFinding[]> {
  const findings: VectorProviderFinding[] = [];
  for (const agentId of listConfiguredAgentIds(params.config).filter(params.shouldInspectAgent)) {
    // A custom agentDir does not move the canonical per-agent memory index.
    const agentDatabasePath = path.join(
      params.stateDir,
      "agents",
      agentId,
      "agent",
      "openclaw-agent.sqlite",
    );
    const model = await readExistingVectorModel(agentDatabasePath);
    if (!model) {
      continue;
    }
    const failure = await inspectProvider({
      config: params.config,
      agentId,
      env: params.env,
    });
    if (failure) {
      findings.push({
        ...failure,
        agentId,
        model,
        configPrefix: resolveConfigPrefix(params.config, agentId),
      });
    }
  }
  return findings;
}

export const MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID =
  "memory-core/managed-local-embedding-setup";

export const pluginStateIsolatedDoctorCheckIds = [
  MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
] as const;

type InspectManagedLocalEmbeddingSetup = (params: {
  config: Parameters<typeof collectVectorProviderFindings>[0]["config"];
  env: NodeJS.ProcessEnv;
  agentId: string;
  provider: string;
}) => ProviderFailure | null | undefined | Promise<ProviderFailure | null | undefined>;

type MemoryCoreDoctorRegistrationHost = {
  registerHealthCheck: (check: HealthCheck) => void;
  getHealthCheck: (id: string) => HealthCheck | undefined;
  inspectEmbeddingProviderSetup: InspectManagedLocalEmbeddingSetup;
  memoryCoreActive: boolean;
};

type MemoryCoreDoctorRegistrationState = Pick<
  MemoryCoreDoctorRegistrationHost,
  "inspectEmbeddingProviderSetup" | "memoryCoreActive"
>;

type MemoryCoreDoctorCheck = HealthCheck & {
  readonly defaultEnabled: false;
};

const registrationsByHost = new WeakMap<
  MemoryCoreDoctorRegistrationHost["registerHealthCheck"],
  {
    readonly check: MemoryCoreDoctorCheck;
    readonly state: MemoryCoreDoctorRegistrationState;
  }
>();

function resolveSelectedMemoryProvider(config: unknown, agentId: string): string | null {
  const cfg = asOptionalObjectRecord(config);
  const { keyed, listed } = readDoctorAgentEntries(config);
  const agent =
    asOptionalObjectRecord(keyed?.[agentId]) ??
    listed.map(asOptionalObjectRecord).find((entry) => entry?.id === agentId);
  const defaults = asOptionalObjectRecord(asOptionalObjectRecord(cfg?.memory)?.search);
  const overrides = asOptionalObjectRecord(asOptionalObjectRecord(agent?.memory)?.search);
  if (!(overrides?.enabled ?? defaults?.enabled ?? true)) {
    return null;
  }
  const provider = normalizeOptionalLowercaseString(overrides?.provider ?? defaults?.provider);
  return !provider || provider === "auto" ? "openai" : provider;
}

function createManagedLocalEmbeddingSetupCheck(
  state: MemoryCoreDoctorRegistrationState,
): MemoryCoreDoctorCheck {
  return {
    id: MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
    kind: "plugin",
    source: "memory-core",
    defaultEnabled: false,
    description: "Checks existing semantic indexes for required managed local embedding setup.",
    async detect(ctx) {
      if (!state.memoryCoreActive) {
        return [];
      }
      const env = ctx.env ?? process.env;
      let findings: Awaited<ReturnType<typeof collectVectorProviderFindings>>;
      try {
        findings = await collectVectorProviderFindings(
          {
            config: ctx.cfg,
            env,
            stateDir: resolveStateDir(env),
            shouldInspectAgent: (agentId) =>
              resolveSelectedMemoryProvider(ctx.cfg, agentId) ===
              LOCAL_MEMORY_EMBEDDING_PROVIDER_ID,
          },
          async (params) => {
            const failure = await state.inspectEmbeddingProviderSetup({
              ...params,
              provider: LOCAL_MEMORY_EMBEDDING_PROVIDER_ID,
            });
            if (failure === undefined) {
              return {
                provider: LOCAL_MEMORY_EMBEDDING_PROVIDER_ID,
                reason: MISSING_LOCAL_MEMORY_EMBEDDING_PROVIDER_MESSAGE,
                requirement: "memory-embedding-provider-plugin",
                fixHint:
                  `Run \`${LLAMA_CPP_PROVIDER_INSTALL_COMMAND}\`, check that the plugin is enabled, ` +
                  "then rerun this check.",
              };
            }
            return failure;
          },
        );
      } catch (error) {
        return [
          {
            checkId: MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
            severity: "error",
            source: "memory-core",
            target: "memory-core",
            requirement: "memory-index-inspection",
            message:
              "Memory Core semantic-index readiness could not be verified " +
              `(${formatErrorMessage(error)}).`,
            fixHint:
              "Keep the current Gateway running, resolve the database inspection error, then rerun this check.",
          },
        ];
      }
      return findings.map((finding) => ({
        checkId: MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
        severity: "error" as const,
        source: "memory-core",
        path: `${finding.configPrefix}.provider`,
        target: `${finding.agentId}/${finding.provider}`,
        requirement: finding.requirement ?? "managed-local-embedding-setup",
        message:
          `Memory index for agent ${finding.agentId} uses vector model ${finding.model}, but ` +
          `embedding provider "${finding.provider}" cannot initialize (${finding.reason}).`,
        fixHint: finding.fixHint,
      }));
    },
  };
}

export function registerMemoryCoreDoctorChecks(host: MemoryCoreDoctorRegistrationHost): void {
  let registration = registrationsByHost.get(host.registerHealthCheck);
  if (registration) {
    registration.state.inspectEmbeddingProviderSetup = host.inspectEmbeddingProviderSetup;
    registration.state.memoryCoreActive = host.memoryCoreActive;
  } else {
    const state: MemoryCoreDoctorRegistrationState = {
      inspectEmbeddingProviderSetup: host.inspectEmbeddingProviderSetup,
      memoryCoreActive: host.memoryCoreActive,
    };
    registration = {
      check: createManagedLocalEmbeddingSetupCheck(state),
      state,
    };
    registrationsByHost.set(host.registerHealthCheck, registration);
  }
  if (host.getHealthCheck(MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID) === registration.check) {
    return;
  }
  host.registerHealthCheck(registration.check);
}
