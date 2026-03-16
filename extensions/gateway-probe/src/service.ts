/**
 * Probe service lifecycle.
 *
 * The plugin observes existing OpenClaw hooks, diagnostics, and app logs,
 * normalizes them into a stable event envelope, and optionally forwards them to
 * Kafka. It never blocks or mutates runtime behavior.
 */

import {
  onDiagnosticEvent,
  registerLogTransport,
  type DiagnosticEventPayload,
  type OpenClawPluginApi,
  type OpenClawPluginService,
} from "openclaw/plugin-sdk";
import { resolveConfig } from "./config.js";
import { registerAllHooks } from "./hooks/hook-registry.js";
import { startKafkaWriter, type KafkaWriterHandle } from "./kafka/writer.js";
import { createTelemetryCollector } from "./telemetry/collector.js";
import { mapDiagnosticEvent } from "./telemetry/diagnostic-mapper.js";
import { mapAppLogRecord } from "./telemetry/log-mapper.js";

const PLUGIN_VERSION = "2026.3.2";

export function createGatewayProbeService(api: OpenClawPluginApi): OpenClawPluginService {
  let writer: KafkaWriterHandle | null = null;
  let unsubscribeDiagnostics: (() => void) | null = null;
  let unsubscribeLogs: (() => void) | null = null;

  return {
    id: "gateway-probe",

    async start() {
      const stateDir = api.runtime.state.resolveStateDir(process.env);
      const config = resolveConfig(api.pluginConfig, {
        env: process.env,
        stateDir,
      });

      if (config.kafka.enabled) {
        try {
          writer = await startKafkaWriter(config, {
            info: (msg) => api.logger.info(msg),
            warn: (msg) => api.logger.warn(msg),
            error: (msg) => api.logger.error(msg),
          });
        } catch (err) {
          api.logger.error(
            `gateway-probe: failed to start kafka writer: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        api.logger.info(
          "gateway-probe: kafka publishing disabled; running in observe-only local mode",
        );
      }

      const collector = createTelemetryCollector({
        pluginVersion: PLUGIN_VERSION,
        probeId: config.probe.probeId,
        probeName: config.probe.name,
        labels: config.labels,
        emit: (event) => writer?.enqueue(event),
      });

      registerAllHooks(api, collector);

      unsubscribeDiagnostics = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
        try {
          for (const event of mapDiagnosticEvent(evt)) {
            collector.recordMappedEvent(event);
          }
        } catch (err) {
          api.logger.error(
            `gateway-probe: diagnostic mapper error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });

      unsubscribeLogs = registerLogTransport((logObj) => {
        try {
          for (const event of mapAppLogRecord(logObj as Record<string, unknown>)) {
            collector.recordMappedEvent(event);
          }
        } catch (err) {
          api.logger.error(
            `gateway-probe: app-log mapper error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });

      api.logger.info(
        `gateway-probe: started (probe=${config.probe.probeId}, name=${config.probe.name}, ` +
          `kafkaEnabled=${config.kafka.enabled}, labels=${JSON.stringify(config.labels)})`,
      );
    },

    async stop() {
      unsubscribeDiagnostics?.();
      unsubscribeDiagnostics = null;

      unsubscribeLogs?.();
      unsubscribeLogs = null;

      if (writer) {
        await writer.stop();
        writer = null;
      }
    },
  } satisfies OpenClawPluginService;
}
