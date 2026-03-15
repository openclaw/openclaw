import { randomBytes } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/health-tracker";
import type { WhoopClient } from "../whoop-api.js";

const WHOOP_ACTIONS = ["status", "setup", "sleep", "recovery", "cycles"] as const;

const WhoopSchema = Type.Object({
  action: Type.Unsafe<(typeof WHOOP_ACTIONS)[number]>({
    type: "string",
    enum: [...WHOOP_ACTIONS],
    description:
      "Action to perform. " +
      "'status' checks connection status. " +
      "'setup' configures Whoop OAuth (requires client_id and client_secret). " +
      "'sleep' fetches recent sleep data. " +
      "'recovery' fetches recent recovery scores. " +
      "'cycles' fetches recent strain/cycle data.",
  }),
  client_id: Type.Optional(
    Type.String({ description: "Whoop OAuth client ID (only for 'setup' action)" }),
  ),
  client_secret: Type.Optional(
    Type.String({ description: "Whoop OAuth client secret (only for 'setup' action)" }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Number of records to fetch (default 5, max 25)" }),
  ),
  start_date: Type.Optional(Type.String({ description: "Start date filter YYYY-MM-DD" })),
  end_date: Type.Optional(Type.String({ description: "End date filter YYYY-MM-DD" })),
});

export function createWhoopTool(whoop: WhoopClient, gatewayBaseUrl?: string): AnyAgentTool {
  return {
    name: "health_whoop",
    label: "Whoop",
    description:
      "Interact with Whoop wearable data: check connection status, set up OAuth, " +
      "and fetch sleep, recovery, and strain/cycle data.",
    parameters: WhoopSchema,
    async execute(_toolCallId, params) {
      const action = params.action;
      const limit = Math.min(params.limit ?? 5, 25);

      if (action === "status") {
        const connected = await whoop.isConnected();
        const config = await whoop.getConfig();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  connected,
                  hasConfig: config != null,
                  hint: connected
                    ? "Whoop is connected. Use action 'sleep', 'recovery', or 'cycles' to fetch data."
                    : "Whoop is not connected. Use action 'setup' with your client_id and client_secret to begin OAuth setup.",
                },
                null,
                2,
              ),
            },
          ],
          details: { connected },
        };
      }

      if (action === "setup") {
        if (!params.client_id || !params.client_secret) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: "client_id and client_secret are required for setup.",
                    instructions: [
                      "1. Go to https://developer.whoop.com and create an app.",
                      "2. Set the redirect URI to: " +
                        (gatewayBaseUrl
                          ? `${gatewayBaseUrl}/plugins/health-tracker/whoop/callback`
                          : "your gateway URL + /plugins/health-tracker/whoop/callback"),
                      "3. Copy the Client ID and Client Secret.",
                      "4. Run this tool again with action='setup', client_id, and client_secret.",
                    ],
                  },
                  null,
                  2,
                ),
              },
            ],
            details: null,
          };
        }

        const redirectUri = gatewayBaseUrl
          ? `${gatewayBaseUrl}/plugins/health-tracker/whoop/callback`
          : "http://localhost:18789/plugins/health-tracker/whoop/callback";

        await whoop.saveConfig({
          clientId: params.client_id,
          clientSecret: params.client_secret,
          redirectUri,
        });

        const state = randomBytes(4).toString("hex");
        const authUrl = await whoop.buildAuthUrl(state);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "config_saved",
                  nextStep: "Open this URL in your browser to authorize Whoop access:",
                  authUrl,
                  redirectUri,
                  note: "After authorizing, Whoop will redirect to the callback URL and the tokens will be saved automatically.",
                },
                null,
                2,
              ),
            },
          ],
          details: { authUrl },
        };
      }

      // Data fetching actions
      const connected = await whoop.isConnected();
      if (!connected) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "Whoop is not connected. Use action 'setup' first.",
                },
                null,
                2,
              ),
            },
          ],
          details: null,
        };
      }

      if (action === "sleep") {
        const sleeps = await whoop.getSleepCollection(limit, params.start_date, params.end_date);
        if (!sleeps) {
          return {
            content: [
              {
                type: "text" as const,
                text: '{"error": "Failed to fetch sleep data. Token may need refresh."}',
              },
            ],
            details: null,
          };
        }

        const formatted = sleeps.map((s) => ({
          date: s.start.slice(0, 10),
          start: s.start,
          end: s.end,
          isNap: s.nap,
          scoreState: s.score_state,
          performance: s.score?.sleepPerformancePercentage,
          efficiency: s.score?.sleepEfficiencyPercentage,
          consistency: s.score?.sleepConsistencyPercentage,
          respiratoryRate: s.score?.respiratoryRate,
          stages: s.score?.stageSummary
            ? {
                totalInBedHrs: (
                  (s.score.stageSummary.totalInBedTimeMilli ?? 0) / 3_600_000
                ).toFixed(1),
                awakeMin: ((s.score.stageSummary.totalAwakeTimeMilli ?? 0) / 60_000).toFixed(0),
                lightMin: ((s.score.stageSummary.totalLightSleepTimeMilli ?? 0) / 60_000).toFixed(
                  0,
                ),
                swsMin: ((s.score.stageSummary.totalSlowWaveSleepTimeMilli ?? 0) / 60_000).toFixed(
                  0,
                ),
                remMin: ((s.score.stageSummary.totalRemSleepTimeMilli ?? 0) / 60_000).toFixed(0),
                cycles: s.score.stageSummary.sleepCycleCount,
                disturbances: s.score.stageSummary.disturbanceCount,
              }
            : undefined,
          sleepNeeded: s.score?.sleepNeeded,
        }));

        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ sleeps: formatted }, null, 2) },
          ],
          details: formatted,
        };
      }

      if (action === "recovery") {
        const recoveries = await whoop.getRecoveryCollection(
          limit,
          params.start_date,
          params.end_date,
        );
        if (!recoveries) {
          return {
            content: [
              { type: "text" as const, text: '{"error": "Failed to fetch recovery data."}' },
            ],
            details: null,
          };
        }

        const formatted = recoveries.map((r) => ({
          date: r.created_at.slice(0, 10),
          scoreState: r.score_state,
          recoveryScore: r.score?.recovery_score,
          restingHR: r.score?.resting_heart_rate,
          hrvMs: r.score?.hrv_rmssd_milli,
          spo2: r.score?.spo2_percentage,
          skinTempC: r.score?.skin_temp_celsius,
          calibrating: r.score?.user_calibrating,
        }));

        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ recoveries: formatted }, null, 2) },
          ],
          details: formatted,
        };
      }

      if (action === "cycles") {
        const cycles = await whoop.getCycleCollection(limit, params.start_date, params.end_date);
        if (!cycles) {
          return {
            content: [{ type: "text" as const, text: '{"error": "Failed to fetch cycle data."}' }],
            details: null,
          };
        }

        const formatted = cycles.map((c) => ({
          date: c.start.slice(0, 10),
          start: c.start,
          end: c.end,
          strain: c.score?.strain,
          kilojoules: c.score?.kilojoule,
          avgHR: c.score?.average_heart_rate,
          maxHR: c.score?.max_heart_rate,
        }));

        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ cycles: formatted }, null, 2) },
          ],
          details: formatted,
        };
      }

      return {
        content: [{ type: "text" as const, text: `{"error": "Unknown action: ${action}"}` }],
        details: null,
      };
    },
  } as AnyAgentTool;
}
