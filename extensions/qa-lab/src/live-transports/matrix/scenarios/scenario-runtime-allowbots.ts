import { MATRIX_QA_BOT_DM_ROOM_KEY } from "./scenario-contract.js";
import {
  buildExactMarkerPrompt,
  buildMatrixQaToken,
  buildMentionPrompt,
  createMatrixQaScenarioClient,
  resolveMatrixQaActorSyncParams,
  resolveMatrixQaNoReplyWindowMs,
  runNoReplyExpectedScenario,
  runTopologyScopedTopLevelScenario,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

async function runObserverBotReplyScenario(params: {
  context: MatrixQaScenarioContext;
  roomKey?: string;
  tokenPrefix: string;
  withMention?: boolean;
}) {
  return await runTopologyScopedTopLevelScenario({
    actorId: "observer",
    context: params.context,
    roomKey: params.roomKey ?? params.context.topology.defaultRoomKey,
    tokenPrefix: params.tokenPrefix,
    ...(params.withMention === undefined ? {} : { withMention: params.withMention }),
  });
}

async function runObserverBotNoReplyScenario(params: {
  context: MatrixQaScenarioContext;
  tokenPrefix: string;
  withMention?: boolean;
}) {
  const token = buildMatrixQaToken(params.tokenPrefix);
  const withMention = params.withMention !== false;
  return await runNoReplyExpectedScenario({
    ...resolveMatrixQaActorSyncParams(params.context, "observer"),
    actorUserId: params.context.observerUserId,
    body: withMention
      ? buildMentionPrompt(params.context.sutUserId, token)
      : buildExactMarkerPrompt(token),
    ...(withMention ? { mentionUserIds: [params.context.sutUserId] } : {}),
    roomId: params.context.roomId,
    sutUserId: params.context.sutUserId,
    timeoutMs: resolveMatrixQaNoReplyWindowMs(params.context.timeoutMs),
    token,
  });
}

export async function runAllowBotsDefaultBlockScenario(context: MatrixQaScenarioContext) {
  return await runObserverBotNoReplyScenario({
    context,
    tokenPrefix: "MATRIX_QA_ALLOWBOTS_DEFAULT_BLOCK",
  });
}

export async function runAllowBotsTrueUnmentionedOpenRoomScenario(
  context: MatrixQaScenarioContext,
) {
  return await runObserverBotReplyScenario({
    context,
    tokenPrefix: "MATRIX_QA_ALLOWBOTS_TRUE_OPEN",
    withMention: false,
  });
}

export async function runAllowBotsMentionsMentionedRoomScenario(context: MatrixQaScenarioContext) {
  return await runObserverBotReplyScenario({
    context,
    tokenPrefix: "MATRIX_QA_ALLOWBOTS_MENTIONS_MENTIONED",
  });
}

export async function runAllowBotsMentionsUnmentionedOpenRoomBlockScenario(
  context: MatrixQaScenarioContext,
) {
  return await runObserverBotNoReplyScenario({
    context,
    tokenPrefix: "MATRIX_QA_ALLOWBOTS_MENTIONS_OPEN_BLOCK",
    withMention: false,
  });
}

export async function runAllowBotsMentionsDmUnmentionedScenario(context: MatrixQaScenarioContext) {
  return await runObserverBotReplyScenario({
    context,
    roomKey: MATRIX_QA_BOT_DM_ROOM_KEY,
    tokenPrefix: "MATRIX_QA_ALLOWBOTS_MENTIONS_DM",
    withMention: false,
  });
}

export async function runAllowBotsRoomOverrideBlocksAccountTrueScenario(
  context: MatrixQaScenarioContext,
) {
  return await runObserverBotNoReplyScenario({
    context,
    tokenPrefix: "MATRIX_QA_ALLOWBOTS_ROOM_BLOCK",
    withMention: false,
  });
}

export async function runAllowBotsRoomOverrideEnablesAccountOffScenario(
  context: MatrixQaScenarioContext,
) {
  return await runObserverBotReplyScenario({
    context,
    tokenPrefix: "MATRIX_QA_ALLOWBOTS_ROOM_ENABLE",
  });
}

export async function runAllowBotsSelfSenderIgnoredScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const sutSender = createMatrixQaScenarioClient({
    accessToken: context.sutAccessToken,
    baseUrl: context.baseUrl,
  });
  const token = buildMatrixQaToken("MATRIX_QA_ALLOWBOTS_SELF_IGNORED");
  return await runNoReplyExpectedScenario({
    ...resolveMatrixQaActorSyncParams(context, "observer"),
    actorUserId: context.sutUserId,
    body: buildExactMarkerPrompt(token),
    roomId: context.roomId,
    sendClient: sutSender,
    sutUserId: context.sutUserId,
    timeoutMs: resolveMatrixQaNoReplyWindowMs(context.timeoutMs),
    token,
  });
}
