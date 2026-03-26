import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/core";
import { loadRenderMonitorConfig } from "./config.js";
import type {
  RenderMonitorState,
  RenderServiceSnapshot,
  StoredRenderIncident,
} from "./types.js";
import { RenderClient } from "./render-client.js";
import { detectRenderIncidents } from "./detection.js";
import {
  computeIncidentFingerprint,
  loadRenderMonitorState,
  saveRenderMonitorState,
  markIncidentAlerted,
  resolveIncidentById,
  shouldDedupeIncident,
  upsertIncident,
} from "./state-store.js";
import { buildIncidentAlertText, resolveRenderDashboardLinks } from "./alerting.js";

async function sendTelegramAlert(params: {
  api: OpenClawPluginApi;
  chatId: string;
  text: string;
}): Promise<void> {
  const send = params.api.runtime?.channel?.telegram?.sendMessageTelegram;
  if (!send) {
    params.api.logger.warn?.(`render-monitor: telegram runtime unavailable; skipping send.`);
    return;
  }
  await send(params.chatId, params.text, { silent: false, textMode: "markdown" });
}

function pruneState(params: {
  state: RenderMonitorState;
  nowMs: number;
  dedupeTtlMinutes: number;
}): RenderMonitorState {
  // Keep incidents only for a window, to avoid unbounded growth.
  const maxAgeMs = params.dedupeTtlMinutes * 6 * 60_000;
  const kept: Record<string, StoredRenderIncident> = {};
  for (const [id, incident] of Object.entries(params.state.incidentsById)) {
    if (params.nowMs - incident.lastDetectedAtMs <= maxAgeMs) {
      kept[id] = incident;
    }
  }
  const incidentIdByFingerprint: Record<string, string> = {};
  for (const [fingerprint, incidentId] of Object.entries(params.state.incidentIdByFingerprint)) {
    if (kept[incidentId]) {
      incidentIdByFingerprint[fingerprint] = incidentId;
    }
  }
  return {
    ...params.state,
    incidentsById: kept,
    incidentIdByFingerprint,
  };
}

export function createRenderMonitorService(api: OpenClawPluginApi): OpenClawPluginService {
  let interval: ReturnType<typeof setInterval> | null = null;
  let state: RenderMonitorState | null = null;
  let client: RenderClient | null = null;
  let cfgResolved: ReturnType<typeof loadRenderMonitorConfig> | null = null;

  return {
    id: "render-monitor",
    async start(ctx) {
      cfgResolved = loadRenderMonitorConfig(api);
      if (!cfgResolved.enabled) {
        api.logger.info?.(`render-monitor: disabled (missing config/services).`);
        return;
      }

      const stateDir = ctx.stateDir;
      state = await loadRenderMonitorState(stateDir);
      client = new RenderClient({
        apiKey: cfgResolved.renderApiKey,
        baseUrl: cfgResolved.renderApiBaseUrl,
      });

      const pollMs = Math.max(10_000, Math.round(cfgResolved.pollIntervalMinutes * 60_000));

      const tick = async () => {
        if (!cfgResolved || !state || !client) {
          return;
        }
        const nowMs = Date.now();
        state = pruneState({ state, nowMs, dedupeTtlMinutes: cfgResolved.dedupeTtlMinutes });

        for (const service of cfgResolved.services) {
          let snapshot: RenderServiceSnapshot;
          try {
            snapshot = await client.getService(service.serviceId);
          } catch (err) {
            api.logger.warn?.(
              `render-monitor: render api failed for service=${service.serviceId}: ${String(
                (err as Error)?.message ?? err,
              )}`,
            );
            continue;
          }

          const streak = state.serviceErrorStreakByServiceId[service.serviceId] ?? {
            count: 0,
            updatedAtMs: nowMs,
          };

          const incidents = await detectRenderIncidents({
            service,
            snapshot,
            httpProbeEnabled: cfgResolved.httpProbeEnabled,
            httpProbeTimeoutMs: cfgResolved.httpProbeTimeoutMs,
            consecutiveServiceErrorStreakCount: streak.count,
            nowMs,
          });

          if (incidents.length === 0) {
            // Reset streak only when we have no service-level error.
            const serviceError =
              typeof snapshot.status === "string" &&
              ["error", "failed"].some((needle) => snapshot.status?.toLowerCase().includes(needle));
            if (!serviceError && streak.count > 0) {
              state = {
                ...state,
                serviceErrorStreakByServiceId: {
                  ...state.serviceErrorStreakByServiceId,
                  [service.serviceId]: { count: 0, updatedAtMs: nowMs },
                },
                updatedAtMs: nowMs,
              };
            }
            continue;
          }

          for (const detected of incidents) {
            const { fingerprint, incidentId } = computeIncidentFingerprint({
              serviceId: service.serviceId,
              incidentType: detected.incidentType,
              deployId: snapshot.latestDeploy?.id ?? null,
              healthState: snapshot.healthCheckState ?? null,
              extra: detected.details ?? {},
            });

            const existing = state.incidentsById[incidentId] ?? null;
            const dedupeIncident = {
              incidentId,
              fingerprint,
              createdAtMs: existing?.createdAtMs ?? detected.createdAtMs,
            };

            const shouldDedupe = shouldDedupeIncident({
              state,
              incident: dedupeIncident,
              nowMs,
              dedupeTtlMinutes: cfgResolved.dedupeTtlMinutes,
            });

            if (shouldDedupe) {
              continue;
            }

            const incidentRecord: StoredRenderIncident = {
              id: incidentId,
              fingerprint,
              serviceId: service.serviceId,
              incidentType: detected.incidentType,
              createdAtMs: existing?.createdAtMs ?? detected.createdAtMs,
              lastDetectedAtMs: nowMs,
              acknowledgedAtMs: existing?.acknowledgedAtMs ?? null,
              lastAlertedAtMs: existing?.lastAlertedAtMs ?? null,
              lastInvestigation: existing?.lastInvestigation ?? null,
              summary: detected.summary,
              details: detected.details,
            };

            state = upsertIncident({ state, incident: incidentRecord });

            // Update streak for crash repetition heuristic.
            if (detected.incidentType === "service_error") {
              const nextCount =
                (state.serviceErrorStreakByServiceId[service.serviceId]?.count ?? 0) + 1;
              state = {
                ...state,
                serviceErrorStreakByServiceId: {
                  ...state.serviceErrorStreakByServiceId,
                  [service.serviceId]: {
                    count: nextCount,
                    lastIncidentFingerprint: fingerprint,
                    updatedAtMs: nowMs,
                  },
                },
                updatedAtMs: nowMs,
              };
            }

            const refreshed = resolveIncidentById(state, incidentId);
            if (refreshed && refreshed.acknowledgedAtMs == null) {
              const links = resolveRenderDashboardLinks(service.serviceId);
              const text = buildIncidentAlertText({
                incident: { ...detected, fingerprint, incidentId },
                incidentId,
                service,
              });
              const extra =
                detected.incidentType === "deploy_failed" ? `\n\nRender deploy link: ${links.service}` : "";
              await sendTelegramAlert({
                api,
                chatId: cfgResolved.telegram.chatId,
                text: `${text}\n\nUseful links:\n- ${links.service}\n- ${links.logs}${extra}`,
              });
              state = markIncidentAlerted({ state, incidentId, alertedAtMs: nowMs });
            }
          }
        }

        // Persist between ticks.
        await saveRenderMonitorState(ctx.stateDir, state);
      };

      await tick().catch((err) => {
        api.logger.error?.(
          `render-monitor: initial tick failed: ${String((err as Error)?.message ?? err)}`,
        );
      });

      interval = setInterval(() => {
        tick().catch((err) => {
          api.logger.error?.(`render-monitor: tick failed: ${String((err as Error)?.message ?? err)}`);
        });
      }, pollMs);
      interval.unref?.();

      api.logger.info?.(
        `render-monitor: started (pollIntervalMinutes=${cfgResolved.pollIntervalMinutes}, services=${cfgResolved.services.length}).`,
      );
    },
    async stop(ctx) {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      // Best-effort persistence.
      if (state) {
        await saveRenderMonitorState(ctx.stateDir, state).catch(() => undefined);
      }
      state = null;
      client = null;
      cfgResolved = null;
    },
  };
}

