import { randomUUID } from "node:crypto";
import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applySessionModelSelection,
  type ApplySessionModelSelectionParams,
} from "openclaw/plugin-sdk/model-session-runtime";
import { buildPreparedModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import { resolveStorePath, type SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { type PendingPickerSelection, sessionModelRef } from "./picker-pending-selection.js";

type PickerModelData = Pick<
  Awaited<ReturnType<typeof buildPreparedModelsProviderData>>,
  "modelCatalog" | "modelMenu"
>;

/** Builds the shared selection owner's input for one Telegram picker selection. */
export function prepareTelegramPickerSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  currentModelRef: string | undefined;
  modelData: PickerModelData;
  selection: { provider: string; model: string };
}) {
  const { cfg, agentId, sessionKey, selection } = params;
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const resolvedDefault = resolveDefaultModelForAgent({ cfg, agentId });
  const isDefaultSelection =
    selection.provider === resolvedDefault?.provider && selection.model === resolvedDefault?.model;
  const sessionEntry = params.sessionEntry ?? { sessionId: randomUUID(), updatedAt: Date.now() };
  const previousAuthProfileId = sessionEntry.authProfileOverride?.trim();
  const sessionStore = { [sessionKey]: sessionEntry };
  const currentModelRef = params.currentModelRef?.trim();
  const separator = currentModelRef?.indexOf("/") ?? -1;
  const current =
    currentModelRef && separator > 0
      ? {
          provider: currentModelRef.slice(0, separator),
          model: currentModelRef.slice(separator + 1),
        }
      : resolvedDefault;
  const input: ApplySessionModelSelectionParams = {
    cfg,
    agentId,
    sessionKey,
    storePath,
    sessionEntry,
    sessionStore,
    allowCreate: params.sessionEntry === undefined,
    defaultProvider: resolvedDefault?.provider ?? selection.provider,
    defaultModel: resolvedDefault?.model,
    currentProvider: current?.provider,
    currentModel: current?.model,
    modelCatalog: params.modelData.modelCatalog,
    canPersistStickyModelSelection: false,
    // The shared selection owner enforces the picker auth policy from these
    // menu facts; Telegram only renders its result.
    authReadinessMenu: params.modelData.modelMenu,
    request: {
      provider: selection.provider,
      model: selection.model,
      isDefault: isDefaultSelection,
      runtime: isDefaultSelection ? { kind: "clear" } : { kind: "unchanged" },
    },
    markLiveSwitchPending: true,
  };
  return { input, isDefaultSelection, previousAuthProfileId, sessionStore };
}

/**
 * Applies a picker selection that waited for this sign-in. Skips it when the
 * chat picked another model meanwhile or the model left the picker; the gate
 * re-checks sign-in with fresh menu facts.
 */
export async function applyPendingTelegramPickerSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  pending: PendingPickerSelection;
}): Promise<boolean> {
  const { cfg, agentId, sessionKey, sessionEntry, pending } = params;
  if (sessionModelRef(sessionEntry) !== pending.sessionModelRef) {
    return false;
  }
  const modelData = await buildPreparedModelsProviderData(cfg, agentId, { sessionEntry });
  if (!modelData.byProvider.get(pending.provider)?.has(pending.model)) {
    return false;
  }
  const { input } = prepareTelegramPickerSelection({
    cfg,
    agentId,
    sessionKey,
    sessionEntry,
    currentModelRef: pending.currentModelRef,
    modelData,
    selection: pending,
  });
  return (await applySessionModelSelection(input)).status === "applied";
}
