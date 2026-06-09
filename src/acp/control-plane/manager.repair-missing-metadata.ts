import { resolveAcpSessionCwd } from "@openclaw/acp-core/runtime/session-identifiers";
import {
  resolveRuntimeResumeSessionId,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
/** Repairs ACP sessions whose JSON store row exists but SQLite metadata was lost. */
import type { AcpRuntimeSessionMode } from "@openclaw/acp-core/runtime/types";
import { resolveSpawnedWorkspaceInheritance } from "../../agents/spawned-context.js";
import type { AcpSessionRuntimeOptions, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { isAcpSessionKey } from "../../sessions/session-key-utils.js";
import { resolveConfiguredAcpBindingSpecBySessionKey } from "../persistent-bindings.resolve.js";
import { readAcpSessionEntry } from "../runtime/session-meta.js";
import { resolveAcpAgentFromSessionKey } from "./manager.utils.js";

export type RepairMissingAcpSessionMetadataPlan = {
  sessionKey: string;
  agent: string;
  mode: AcpRuntimeSessionMode;
  backendId?: string;
  cwd?: string;
  runtimeOptions?: Partial<AcpSessionRuntimeOptions>;
  resumeSessionId?: string;
};

function isPersistentAcpBindingSessionKey(sessionKey: string): boolean {
  return sessionKey.includes(":acp:binding:");
}

function resolveRepairMode(entry: SessionEntry, sessionKey: string): AcpRuntimeSessionMode | null {
  if (entry.hubDelegated) {
    return "persistent";
  }
  if (entry.acp?.mode === "persistent") {
    return "persistent";
  }
  if (isPersistentAcpBindingSessionKey(sessionKey)) {
    return "persistent";
  }
  if (getSessionBindingService().listBySession(sessionKey).length > 0) {
    return "persistent";
  }
  if (entry.spawnedBy || entry.parentSessionKey) {
    return "oneshot";
  }
  return null;
}

function resolveRepairInitializeInput(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  entry: SessionEntry;
  agent: string;
  mode: AcpRuntimeSessionMode;
}): Pick<RepairMissingAcpSessionMetadataPlan, "cwd" | "runtimeOptions" | "resumeSessionId"> {
  const legacyMeta = params.entry.acp;
  const runtimeOptions = legacyMeta?.runtimeOptions ? { ...legacyMeta.runtimeOptions } : undefined;
  let cwd = resolveAcpSessionCwd(legacyMeta);

  const bindingSpec = resolveConfiguredAcpBindingSpecBySessionKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  if (!cwd && bindingSpec?.cwd) {
    cwd = bindingSpec.cwd;
  }

  const requesterSessionKey =
    params.entry.hubDelegated?.ownerSessionKey ??
    params.entry.spawnedBy ??
    params.entry.parentSessionKey;
  if (!cwd && params.entry.hubDelegated && requesterSessionKey) {
    cwd = resolveSpawnedWorkspaceInheritance({
      config: params.cfg,
      targetAgentId: params.agent,
      requesterSessionKey,
    });
  }

  const resumeSessionId =
    params.mode === "persistent"
      ? resolveRuntimeResumeSessionId(resolveSessionIdentityFromMeta(legacyMeta))
      : undefined;

  return {
    ...(cwd ? { cwd } : {}),
    ...(runtimeOptions && Object.keys(runtimeOptions).length > 0 ? { runtimeOptions } : {}),
    ...(resumeSessionId ? { resumeSessionId } : {}),
  };
}

export function shouldRepairMissingAcpSessionMetadata(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): RepairMissingAcpSessionMetadataPlan | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey || !isAcpSessionKey(sessionKey)) {
    return null;
  }
  const storeEntry = readAcpSessionEntry({
    sessionKey,
    cfg: params.cfg,
    clone: false,
  });
  if (!storeEntry?.entry || storeEntry.acp) {
    return null;
  }
  const mode = resolveRepairMode(storeEntry.entry, sessionKey);
  if (!mode) {
    return null;
  }
  const agent = resolveAcpAgentFromSessionKey(sessionKey);
  return {
    sessionKey,
    agent,
    mode,
    backendId: params.cfg.acp?.backend,
    ...resolveRepairInitializeInput({
      cfg: params.cfg,
      sessionKey,
      entry: storeEntry.entry,
      agent,
      mode,
    }),
  };
}

export function hasPersistedAcpSessionMetadata(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): boolean {
  return Boolean(
    readAcpSessionEntry({
      sessionKey: params.sessionKey,
      cfg: params.cfg,
      clone: false,
    })?.acp,
  );
}
