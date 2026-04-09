import { execSync } from "node:child_process";
import { waitForHealth, verifyModelIdentity, detectActiveModel } from "./health.js";
import {
  writeMarker,
  readMarker,
  deleteMarker,
  isMarkerStale,
  incrementMarkerAttempt,
} from "./marker.js";
import type { ModelSwitchConfig, SwitchMarker } from "./types.js";

export type ExecutorDeps = {
  config: ModelSwitchConfig;
  stateDir: string;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  enqueueFollowupTurn: (params: {
    sessionKey: string;
    prompt: string;
    source: string;
  }) => Promise<boolean>;
  /** Resolved by the executor when the switch completes (or fails). */
  onSwitchComplete: () => void;
};

/** Module-level state shared between tool, gate, and executor. */
export type SwitchState = {
  switching: boolean;
  activeModelId: string | null;
  switchPromise: Promise<boolean> | null;
};

/**
 * Execute a model switch: stop current → start target → health check → identity verify → followup.
 *
 * ## Security
 *
 * Shell commands (startCommand, stopCommand) come from plugin config — operator-controlled,
 * never from agent input. The agent provides only a model ID, which is resolved to a
 * config-defined command. No interpolation of agent-provided strings.
 * This matches the security model of the gateway-restart extension.
 */
export async function executeSwitch(
  params: {
    sessionKey: string;
    targetModelId: string;
    reason?: string;
    continuationPrompt: string;
  },
  state: SwitchState,
  deps: ExecutorDeps,
): Promise<boolean> {
  const { config, stateDir, logger, enqueueFollowupTurn } = deps;
  const target = config.models[params.targetModelId];
  if (!target) {
    logger.error(`[model-switch] Unknown target model: ${params.targetModelId}`);
    return false;
  }

  const sourceModelId = state.activeModelId;
  const source = sourceModelId ? config.models[sourceModelId] : null;
  const startTime = Date.now();

  // Write switch marker for crash recovery
  const marker: SwitchMarker = {
    sessionKey: params.sessionKey,
    sourceModel: sourceModelId ?? "unknown",
    targetModel: params.targetModelId,
    reason: params.reason,
    continuationPrompt: params.continuationPrompt,
    requestedAt: new Date().toISOString(),
    attemptCount: 0,
  };
  writeMarker(stateDir, marker);

  try {
    // Step 1: Stop current model (synchronous — blocks until process exits)
    if (source) {
      logger.info(`[model-switch] Stopping ${sourceModelId}: ${source.stopCommand}`);
      try {
        execSync(source.stopCommand, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: config.switchTimeoutMs,
        });
      } catch {
        logger.warn(`[model-switch] Stop command returned non-zero (may already be stopped)`);
      }
    }

    // Step 2: Verify old model is actually stopped (brief reverse health check)
    if (source) {
      const stillUp = await waitForHealth(source, {
        timeoutMs: 3000,
        pollIntervalMs: 500,
      });
      if (stillUp) {
        logger.warn(
          `[model-switch] Source model still responding after stop command. Proceeding anyway.`,
        );
      }
    }

    // Step 3: Start target model
    logger.info(`[model-switch] Starting ${params.targetModelId}: ${target.startCommand}`);
    try {
      execSync(target.startCommand, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: config.switchTimeoutMs,
      });
    } catch (err) {
      logger.error(`[model-switch] Start command failed: ${String(err)}`);
      return false;
    }

    // Step 4: Wait for health
    logger.info(`[model-switch] Waiting for ${params.targetModelId} health...`);
    const healthy = await waitForHealth(target, {
      timeoutMs: config.healthTimeoutMs,
      pollIntervalMs: config.healthPollIntervalMs,
    });

    if (!healthy) {
      logger.error(
        `[model-switch] Health check timed out for ${params.targetModelId} after ${config.healthTimeoutMs}ms`,
      );
      return false;
    }

    // Step 5: Verify model identity via /v1/models
    const identity = await verifyModelIdentity(target);
    if (!identity.matched) {
      logger.error(
        `[model-switch] Identity mismatch: expected "${identity.expectedIdentifier}", got "${identity.foundId}"`,
      );
      return false;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[model-switch] ${params.targetModelId} healthy and verified (${elapsed}s)`);

    // Step 6: Update active model state
    state.activeModelId = params.targetModelId;

    // Step 7: Enqueue followup turn (fires FIRST before gate opens)
    const followupPrompt = [
      `[model-switch] Switched from ${sourceModelId ?? "unknown"} to ${params.targetModelId} (took ${elapsed}s).`,
      params.reason ? `Reason: ${params.reason}.` : "",
      params.continuationPrompt,
    ]
      .filter(Boolean)
      .join(" ");

    const enqueued = await enqueueFollowupTurn({
      sessionKey: params.sessionKey,
      prompt: followupPrompt,
      source: "model-switch",
    });

    if (!enqueued) {
      logger.warn(
        `[model-switch] Failed to enqueue followup turn for session ${params.sessionKey}`,
      );
    }

    // Step 8: Delete marker on success
    deleteMarker(stateDir);
    return true;
  } catch (err) {
    logger.error(`[model-switch] Switch failed: ${String(err)}`);
    return false;
  } finally {
    // Step 9: Clear switching flag (releases gate — AFTER followup is enqueued)
    state.switching = false;
    deps.onSwitchComplete();
  }
}

/**
 * On gateway startup, check for stale switch markers and attempt recovery.
 */
export async function recoverFromMarker(state: SwitchState, deps: ExecutorDeps): Promise<void> {
  const { config, stateDir, logger, enqueueFollowupTurn } = deps;
  const marker = readMarker(stateDir);
  if (!marker) {
    return;
  }

  if (isMarkerStale(marker, config.staleMarkerMaxAgeMs)) {
    logger.warn(
      `[model-switch] Stale switch marker found (requested at ${marker.requestedAt}). Deleting.`,
    );
    deleteMarker(stateDir);
    return;
  }

  if (marker.attemptCount >= config.maxMarkerRetries) {
    logger.error(
      `[model-switch] Switch marker has ${marker.attemptCount} failed attempts. Giving up.`,
    );
    deleteMarker(stateDir);
    return;
  }

  const activeId = await detectActiveModel(config.models);

  if (activeId === marker.targetModel) {
    logger.info(
      `[model-switch] Recovery: target ${marker.targetModel} already active. Enqueuing followup.`,
    );
    state.activeModelId = activeId;
    const enqueued = await enqueueFollowupTurn({
      sessionKey: marker.sessionKey,
      prompt: `[model-switch] Gateway restarted. ${marker.targetModel} active. ${marker.continuationPrompt}`,
      source: "model-switch-recovery",
    });
    if (enqueued) {
      deleteMarker(stateDir);
    }
    return;
  }

  if (activeId !== null && activeId !== marker.sourceModel && activeId !== marker.targetModel) {
    logger.warn(
      `[model-switch] Recovery: ${activeId} is active (not ${marker.targetModel} or ${marker.sourceModel}). Manual intervention detected. Deleting marker.`,
    );
    state.activeModelId = activeId;
    deleteMarker(stateDir);
    return;
  }

  logger.info(
    `[model-switch] Recovery: completing interrupted switch to ${marker.targetModel} (attempt ${marker.attemptCount + 1})`,
  );
  incrementMarkerAttempt(stateDir, marker);

  state.switching = true;
  await executeSwitch(
    {
      sessionKey: marker.sessionKey,
      targetModelId: marker.targetModel,
      reason: `Recovery: ${marker.reason ?? "interrupted switch"}`,
      continuationPrompt: marker.continuationPrompt,
    },
    state,
    deps,
  );
}
