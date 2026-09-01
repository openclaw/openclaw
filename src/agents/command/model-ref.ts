import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildModelAliasIndex,
  completeModelRefSelection,
  resolveModelRefFromString,
} from "../model-selection.js";

export function normalizeAgentCommandModelRef(
  cfg: OpenClawConfig,
  provider: string,
  model: string,
  modelManifestContext: Parameters<typeof completeModelRefSelection>[1],
) {
  return completeModelRefSelection(
    { ref: { provider, model }, normalization: "pending" },
    { ...modelManifestContext, cfg },
  );
}

export function parseAgentCommandModelRef(
  cfg: OpenClawConfig,
  agentId: string,
  raw: string,
  defaultProvider: string,
  modelManifestContext: Parameters<typeof completeModelRefSelection>[1],
) {
  const parsed = resolveModelRefFromString({
    cfg,
    agentId,
    raw,
    defaultProvider,
    aliasIndex: buildModelAliasIndex({
      cfg,
      agentId,
      defaultProvider,
      ...modelManifestContext,
      allowPluginNormalization: false,
    }),
    ...modelManifestContext,
    allowPluginNormalization: false,
  })?.ref;
  return parsed
    ? completeModelRefSelection(
        { ref: parsed, normalization: "applied" },
        { ...modelManifestContext, cfg },
      )
    : null;
}
