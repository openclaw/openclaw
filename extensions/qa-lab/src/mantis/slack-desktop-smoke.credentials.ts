import {
  isRecord,
  normalizeOptionalString as trimToValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../live-transports/shared/credential-lease.runtime.js";

type SlackGatewayCredentialPayload = {
  channelId: string;
  sutAppToken: string;
  sutBotToken: string;
};

export type SlackGatewayCredentialLease = Awaited<
  ReturnType<typeof acquireQaCredentialLease<SlackGatewayCredentialPayload>>
>;
export type SlackGatewayCredentialHeartbeat = ReturnType<typeof startQaCredentialLeaseHeartbeat>;

export function buildCrabboxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const [target, source] of [
    ["OPENCLAW_LIVE_OPENAI_KEY", "OPENAI_API_KEY"],
    ["OPENCLAW_MANTIS_SLACK_BOT_TOKEN", "SLACK_BOT_TOKEN"],
    ["OPENCLAW_MANTIS_SLACK_BOT_TOKEN", "OPENCLAW_QA_SLACK_SUT_BOT_TOKEN"],
    ["OPENCLAW_MANTIS_SLACK_APP_TOKEN", "SLACK_APP_TOKEN"],
    ["OPENCLAW_MANTIS_SLACK_APP_TOKEN", "OPENCLAW_QA_SLACK_SUT_APP_TOKEN"],
    ["OPENCLAW_MANTIS_SLACK_CHANNEL_ID", "OPENCLAW_QA_SLACK_CHANNEL_ID"],
  ] as const) {
    if (!trimToValue(next[target]) && trimToValue(next[source])) {
      next[target] = next[source];
    }
  }
  return next;
}

function readSlackGatewayCredentialPayload(
  payload: Record<string, unknown>,
  missingFieldsMessage: string,
): SlackGatewayCredentialPayload {
  const channelId = trimToValue(payload.channelId);
  const sutBotToken = trimToValue(payload.sutBotToken);
  const sutAppToken = trimToValue(payload.sutAppToken);
  if (!channelId || !sutBotToken || !sutAppToken) {
    throw new Error(missingFieldsMessage);
  }
  return { channelId, sutAppToken, sutBotToken };
}

function resolveSlackGatewayEnvPayload(env: NodeJS.ProcessEnv): SlackGatewayCredentialPayload {
  return readSlackGatewayCredentialPayload(
    {
      channelId: env.OPENCLAW_QA_SLACK_CHANNEL_ID,
      sutBotToken: env.OPENCLAW_QA_SLACK_SUT_BOT_TOKEN,
      sutAppToken: env.OPENCLAW_QA_SLACK_SUT_APP_TOKEN,
    },
    "Gateway setup requires OPENCLAW_QA_SLACK_CHANNEL_ID, OPENCLAW_QA_SLACK_SUT_BOT_TOKEN, and OPENCLAW_QA_SLACK_SUT_APP_TOKEN when using --credential-source env.",
  );
}

function parseSlackGatewayCredentialPayload(payload: unknown): SlackGatewayCredentialPayload {
  if (!isRecord(payload)) {
    throw new Error("Slack credential payload must be an object.");
  }
  return readSlackGatewayCredentialPayload(
    payload,
    "Slack credential payload must include channelId, sutBotToken, and sutAppToken.",
  );
}

export async function prepareGatewayCredentialEnv(params: {
  credentialRole: string;
  credentialSource: string;
  env: NodeJS.ProcessEnv;
  gatewaySetup: boolean;
}) {
  if (!params.gatewaySetup) {
    return {};
  }
  if (
    trimToValue(params.env.OPENCLAW_MANTIS_SLACK_BOT_TOKEN) &&
    trimToValue(params.env.OPENCLAW_MANTIS_SLACK_APP_TOKEN)
  ) {
    return {};
  }
  const credentialLease = await acquireQaCredentialLease<SlackGatewayCredentialPayload>({
    env: params.env,
    kind: "slack",
    source: params.credentialSource,
    role: params.credentialRole,
    resolveEnvPayload: () => resolveSlackGatewayEnvPayload(params.env),
    parsePayload: parseSlackGatewayCredentialPayload,
  });
  const leaseHeartbeat = startQaCredentialLeaseHeartbeat(credentialLease);
  const payload = credentialLease.payload;
  params.env.OPENCLAW_MANTIS_SLACK_BOT_TOKEN = payload.sutBotToken;
  params.env.OPENCLAW_MANTIS_SLACK_APP_TOKEN = payload.sutAppToken;
  params.env.OPENCLAW_MANTIS_SLACK_CHANNEL_ID =
    trimToValue(params.env.OPENCLAW_MANTIS_SLACK_CHANNEL_ID) ?? payload.channelId;
  params.env.OPENCLAW_QA_SLACK_CHANNEL_ID =
    trimToValue(params.env.OPENCLAW_QA_SLACK_CHANNEL_ID) ?? payload.channelId;
  params.env.OPENCLAW_QA_SLACK_SUT_BOT_TOKEN =
    trimToValue(params.env.OPENCLAW_QA_SLACK_SUT_BOT_TOKEN) ?? payload.sutBotToken;
  params.env.OPENCLAW_QA_SLACK_SUT_APP_TOKEN =
    trimToValue(params.env.OPENCLAW_QA_SLACK_SUT_APP_TOKEN) ?? payload.sutAppToken;
  return {
    credentialLease,
    leaseHeartbeat,
  };
}
