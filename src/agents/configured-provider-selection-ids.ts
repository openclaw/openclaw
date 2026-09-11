// Reads provider ids selected by auth, model, channel, and media configuration.
import {
  collectConfiguredModelRefs,
  listModelRefsFromConfigValue,
} from "@openclaw/model-catalog-core/configured-model-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString as normalizeId } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { cronStoreKey } from "../cron/store/key.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store/path.js";
import { loadedCronStoreFromRows, loadCronRows } from "../cron/store/row-codec.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { listAgentIds, tryResolveAmbientOwnerAgentId } from "./agent-scope-config.js";
import {
  collectSelectedModelProviders,
  resolveDefaultModelForAgent,
} from "./model-selection-config.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "./model-selection-shared.js";

function collectConfiguredProviderIds(cfg: OpenClawConfig): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    const id = normalizeId(value);
    if (id) {
      ids.add(id.toLowerCase());
    }
  };
  for (const profile of Object.values(asNullableRecord(cfg.auth?.profiles) ?? {})) {
    add(asNullableRecord(profile)?.provider);
  }
  for (const providerId of Object.keys(asNullableRecord(cfg.models?.providers) ?? {})) {
    add(providerId);
  }
  const modelByChannel = asNullableRecord(cfg.channels?.modelByChannel);
  for (const [providerId, channelMap] of Object.entries(modelByChannel ?? {})) {
    add(providerId);
    for (const modelRef of Object.values(asNullableRecord(channelMap) ?? {})) {
      if (typeof modelRef !== "string") {
        continue;
      }
      const slash = modelRef.indexOf("/");
      if (slash > 0) {
        add(modelRef.slice(0, slash));
      }
    }
  }
  for (const { value } of collectConfiguredModelRefs(cfg, {
    includeChannelModelOverrides: false,
  })) {
    const slash = value.indexOf("/");
    if (slash > 0) {
      add(value.slice(0, slash));
    }
  }
  return ids;
}

export type ConfiguredProviderUseSelection = {
  agentId: string;
  provider: string;
  /** Version one already covered primary/fallback selections. */
  previouslyCovered: boolean;
};

/** Resolve every executable selector in its agent scope; catalog aliases alone are not use. */
export function collectConfiguredProviderUseSelections(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentIds?: Iterable<string>;
}): ConfiguredProviderUseSelection[] {
  const { config, env } = params;
  const selections: ConfiguredProviderUseSelection[] = [
    ...(params.agentIds ?? listAgentIds(config)),
  ].flatMap((agentId) =>
    collectSelectedModelProviders({ cfg: config, agentId }).map(({ provider, mainModel }) => ({
      agentId,
      provider,
      previouslyCovered: mainModel,
    })),
  );
  const contexts = new Map<
    string,
    {
      defaultProvider: string;
      aliasIndex: ReturnType<typeof buildModelAliasIndex>;
    }
  >();
  const add = (agentId: string, raw: string, previouslyCovered: boolean) => {
    let context = contexts.get(agentId);
    const selection = {
      cfg: config,
      agentId,
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    };
    if (!context) {
      const defaultProvider = resolveDefaultModelForAgent(selection).provider;
      context = {
        defaultProvider,
        aliasIndex: buildModelAliasIndex({ ...selection, defaultProvider }),
      };
      contexts.set(agentId, context);
    }
    const resolved = resolveModelRefFromString({ ...selection, ...context, raw });
    if (resolved) {
      selections.push({
        agentId,
        provider: normalizeProviderId(resolved.ref.provider),
        previouslyCovered,
      });
    }
  };
  const storePath = resolveCronJobsStorePathFromConfig(config, env);
  const cron = withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) =>
      tableExists(db, "cron_jobs")
        ? loadedCronStoreFromRows(loadCronRows(db, cronStoreKey(storePath)))
        : undefined,
    { env },
  );
  if (cron?.invalidConfigRows.length) {
    throw new Error("Cannot complete provider migration with unreadable cron selections.");
  }
  for (const job of [...(cron?.store.jobs ?? []), ...(cron?.configJobs ?? [])]) {
    const record = asNullableRecord(job);
    const payload = asNullableRecord(record?.payload);
    const values = listModelRefsFromConfigValue({
      primary: payload?.model,
      fallbacks: payload?.fallbacks,
    });
    if (values.length === 0) {
      continue;
    }
    const agentId =
      normalizeId(record?.agentId) ??
      normalizeId(asNullableRecord(record?.owner)?.agentId) ??
      parseAgentSessionKey(normalizeId(record?.sessionKey) ?? "")?.agentId ??
      tryResolveAmbientOwnerAgentId(config);
    if (!agentId) {
      throw new Error("Cannot complete provider migration without the selected cron agent owner.");
    }
    for (const value of values) {
      add(agentId, value, false);
    }
  }
  return selections;
}

function collectConfiguredMediaProviderIds(cfg: OpenClawConfig): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    const id = normalizeId(value);
    if (id) {
      ids.add(id.toLowerCase());
    }
  };
  const addModels = (value: unknown) => {
    if (!Array.isArray(value)) {
      return;
    }
    for (const model of value) {
      add(asNullableRecord(model)?.provider);
    }
  };
  const media = cfg.tools?.media;
  addModels(media?.models);
  return ids;
}

/** Provider ids used by static and installed-registry plugin matching. */
export function collectConfiguredProviderSelectionIds(cfg: OpenClawConfig): ReadonlySet<string> {
  return new Set([...collectConfiguredProviderIds(cfg), ...collectConfiguredMediaProviderIds(cfg)]);
}

export function collectConfiguredMediaProviderSelectionIds(
  cfg: OpenClawConfig,
): ReadonlySet<string> {
  return collectConfiguredMediaProviderIds(cfg);
}

export function collectConfiguredModelProviderSelectionIds(
  cfg: OpenClawConfig,
): ReadonlySet<string> {
  return collectConfiguredProviderIds(cfg);
}
