import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { n as resolveOutboundSendDep } from "./send-deps-BvayJH3C.js";
import "./error-runtime-D_Qslcoe.js";
import { t as chunkTextForOutbound } from "./text-chunking-CBGjAx2u.js";
import "./string-coerce-runtime-B-12iPWS.js";
import { a as sendMessageMatrix, l as sendTypingMatrix, o as sendPollMatrix } from "./send-CmCnWSVp.js";
import { t as isBunRuntime } from "./runtime-BW54yUfZ.js";
import { n as resolveMatrixAuth } from "./config-07jpn67U.js";
import "./client-BVMORozN.js";
import { n as listMatrixDirectoryPeersLive, t as listMatrixDirectoryGroupsLive } from "./directory-live-C_ALcshh.js";
import "./runtime-api-B1xwY_j4.js";
import { t as resolveMatrixTargets } from "./resolve-targets-iU_hQJSh.js";
//#region extensions/matrix/src/matrix/probe.ts
let matrixProbeRuntimeDepsPromise;
async function loadMatrixProbeRuntimeDeps() {
	matrixProbeRuntimeDepsPromise ??= import("./probe.runtime-D-XuBeOp.js").then((runtimeModule) => ({ createMatrixClient: runtimeModule.createMatrixClient }));
	return await matrixProbeRuntimeDepsPromise;
}
async function probeMatrix(params) {
	const started = Date.now();
	const result = {
		ok: false,
		status: null,
		error: null,
		elapsedMs: 0
	};
	if (isBunRuntime()) return {
		...result,
		error: "Matrix probe requires Node (bun runtime not supported)",
		elapsedMs: Date.now() - started
	};
	if (!params.homeserver?.trim()) return {
		...result,
		error: "missing homeserver",
		elapsedMs: Date.now() - started
	};
	if (!params.accessToken?.trim()) return {
		...result,
		error: "missing access token",
		elapsedMs: Date.now() - started
	};
	try {
		const { createMatrixClient } = await loadMatrixProbeRuntimeDeps();
		const inputUserId = normalizeOptionalString(params.userId);
		const userId = await (await createMatrixClient({
			homeserver: params.homeserver,
			userId: inputUserId,
			accessToken: params.accessToken,
			deviceId: params.deviceId,
			persistStorage: false,
			localTimeoutMs: params.timeoutMs,
			accountId: params.accountId,
			allowPrivateNetwork: params.allowPrivateNetwork,
			ssrfPolicy: params.ssrfPolicy,
			dispatcherPolicy: params.dispatcherPolicy
		})).getUserId();
		result.ok = true;
		result.userId = userId ?? null;
		result.elapsedMs = Date.now() - started;
		return result;
	} catch (err) {
		return {
			...result,
			status: typeof err === "object" && err && "statusCode" in err ? Number(err.statusCode) : result.status,
			error: formatErrorMessage(err),
			elapsedMs: Date.now() - started
		};
	}
}
//#endregion
//#region extensions/matrix/src/channel.runtime.ts
const matrixChannelRuntime = {
	listMatrixDirectoryGroupsLive,
	listMatrixDirectoryPeersLive,
	matrixOutbound: {
		deliveryMode: "direct",
		chunker: chunkTextForOutbound,
		chunkerMode: "markdown",
		textChunkLimit: 4e3,
		sendText: async ({ cfg, to, text, deps, replyToId, threadId, accountId, audioAsVoice }) => {
			const result = await (resolveOutboundSendDep(deps, "matrix") ?? sendMessageMatrix)(to, text, {
				cfg,
				replyToId: replyToId ?? void 0,
				threadId: threadId !== void 0 && threadId !== null ? String(threadId) : void 0,
				accountId: accountId ?? void 0,
				audioAsVoice
			});
			return {
				channel: "matrix",
				messageId: result.messageId,
				roomId: result.roomId
			};
		},
		sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, mediaReadFile, deps, replyToId, threadId, accountId, audioAsVoice }) => {
			const result = await (resolveOutboundSendDep(deps, "matrix") ?? sendMessageMatrix)(to, text, {
				cfg,
				mediaUrl,
				mediaLocalRoots,
				mediaReadFile,
				replyToId: replyToId ?? void 0,
				threadId: threadId !== void 0 && threadId !== null ? String(threadId) : void 0,
				accountId: accountId ?? void 0,
				audioAsVoice
			});
			return {
				channel: "matrix",
				messageId: result.messageId,
				roomId: result.roomId
			};
		},
		sendPoll: async ({ cfg, to, poll, threadId, accountId }) => {
			const result = await sendPollMatrix(to, poll, {
				cfg,
				threadId: threadId !== void 0 && threadId !== null ? threadId : void 0,
				accountId: accountId ?? void 0
			});
			return {
				channel: "matrix",
				messageId: result.eventId,
				roomId: result.roomId,
				pollId: result.eventId
			};
		}
	},
	probeMatrix,
	resolveMatrixAuth,
	resolveMatrixTargets,
	sendMessageMatrix,
	sendTypingMatrix
};
//#endregion
export { matrixChannelRuntime };
