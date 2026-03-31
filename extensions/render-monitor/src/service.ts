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
  isServiceMuted,
  loadRenderMonitorState,
  pruneExpiredMutes,
  saveRenderMonitorState,
  markIncidentAlerted,
  resolveIncidentById,
  shouldDedupeIncident,
  upsertIncident,
} from "./state-store.js";
import { buildIncidentAlertText, resolveRenderDashboardLinks, truncateForTelegram } from "./alerting.js";

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
  const maxAgeMs = params.dedupeTtlMinutes * 60_000;
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
        state = pruneExpiredMutes({ state, nowMs });

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
            const muted = isServiceMuted({
              state,
              serviceId: service.serviceId,
              incidentType: detected.incidentType,
              nowMs,
            });
            if (refreshed && refreshed.acknowledgedAtMs == null && !muted) {
              const links = resolveRenderDashboardLinks(service.serviceId);
              const text = buildIncidentAlertText({
                incident: { ...detected, fingerprint, incidentId },
                incidentId,
                service,
              });
              const fullText = truncateForTelegram(
                `${text}\n\nUseful links:\n- ${links.service}\n- ${links.logs}`,
              );
              await sendTelegramAlert({
                api,
                chatId: cfgResolved.telegram.chatId,
                text: fullText,
              });
              state = markIncidentAlerted({ state, incidentId, alertedAtMs: nowMs });
            }
          }

          // Log error probe: check Render application logs for ERROR-level entries.
          const ownerId = snapshot.ownerId;
          if (ownerId && client) {
            const sinceIso = new Date(nowMs - cfgResolved.pollIntervalMinutes * 60_000).toISOString();
            try {
              const errorLogs = await client.getErrorLogs({
                serviceId: service.serviceId,
                ownerId,
                sinceIso,
                limit: 5,
              });
              for (const logEntry of errorLogs) {
                const { fingerprint: logFp, incidentId: logIncidentId } = computeIncidentFingerprint({
                  serviceId: service.serviceId,
                  incidentType: "log_error",
                  extra: { message: logEntry.message, timestamp: logEntry.timestamp },
                });

                const existingLog = state.incidentsById[logIncidentId] ?? null;
                const shouldDedupeLog = shouldDedupeIncident({
                  state,
                  incident: {
                    incidentId: logIncidentId,
                    fingerprint: logFp,
                    createdAtMs: existingLog?.createdAtMs ?? nowMs,
                  },
                  nowMs,
                  dedupeTtlMinutes: cfgResolved.dedupeTtlMinutes,
                });
                if (shouldDedupeLog) continue;

                const logIncident: StoredRenderIncident = {
                  id: logIncidentId,
                  fingerprint: logFp,
                  serviceId: service.serviceId,
                  incidentType: "log_error",
                  createdAtMs: existingLog?.createdAtMs ?? nowMs,
                  lastDetectedAtMs: nowMs,
                  acknowledgedAtMs: existingLog?.acknowledgedAtMs ?? null,
                  lastAlertedAtMs: existingLog?.lastAlertedAtMs ?? null,
                  lastInvestigation: existingLog?.lastInvestigation ?? null,
                  summary: logEntry.message.slice(0, 500),
                  details: { logTimestamp: logEntry.timestamp, level: logEntry.level },
                };
                state = upsertIncident({ state, incident: logIncident });

                const logMuted = isServiceMuted({
                  state,
                  serviceId: service.serviceId,
                  incidentType: "log_error",
                  nowMs,
                });
                if (!logMuted && logIncident.acknowledgedAtMs == null) {
                  const links = resolveRenderDashboardLinks(service.serviceId);
                  const svcName = service.name ? ` · ${service.name}` : "";
                  const alertText = truncateForTelegram([
                    `⚠️ Application error detected in logs`,
                    `Service: *${service.serviceId}*${svcName}`,
                    `Incident ID: \`${logIncidentId}\``,
                    `When: ${logEntry.timestamp}`,
                    ``,
                    logEntry.message.slice(0, 800),
                    ``,
                    `Logs: ${links.logs}`,
                  ].join("\n"));
                  await sendTelegramAlert({ api, chatId: cfgResolved.telegram.chatId, text: alertText });
                  state = markIncidentAlerted({ state, incidentId: logIncidentId, alertedAtMs: nowMs });
                }
              }
            } catch (err) {
              api.logger.warn?.(
                `render-monitor: log probe failed for service=${service.serviceId}: ${String((err as Error)?.message ?? err)}`,
              );
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

