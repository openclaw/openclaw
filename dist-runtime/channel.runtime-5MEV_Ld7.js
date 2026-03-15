import "./provider-env-vars-BfZUtZAn.js";
import "./resolve-route-BZ4hHpx2.js";
import "./logger-CRwcgB9y.js";
import "./tmp-openclaw-dir-Bz3ouN_i.js";
import "./paths-Byjx7_T6.js";
import "./subsystem-CsP80x3t.js";
import "./utils-o1tyfnZ_.js";
import "./fetch-Dx857jUp.js";
import "./retry-BY_ggjbn.js";
import "./agent-scope-DV_aCIyi.js";
import "./exec-BLi45_38.js";
import "./logger-Bsnck4bK.js";
import "./paths-OqPpu-UR.js";
import { oi as resolveOutboundSendDep } from "./auth-profiles-CuJtivJK.js";
import "./profiles-CV7WLKIX.js";
import "./fetch-D2ZOzaXt.js";
import "./external-content-vZzOHxnd.js";
import "./kilocode-shared-Ci8SRxXc.js";
import "./models-config.providers.static-DRBnLpDj.js";
import "./models-config.providers.discovery-l-LpSxGW.js";
import "./pairing-token-DKpN4qO0.js";
import "./query-expansion-txqQdNIf.js";
import "./redact-BefI-5cC.js";
import "./mime-33LCeGh-.js";
import "./resolve-utils-BpDGEQsl.js";
import "./typebox-BmZP6XXv.js";
import "./web-search-plugin-factory-DStYVW2B.js";
import "./compat-DDXNEdAm.js";
import "./inbound-envelope-DsNRW6ln.js";
import "./run-command-Psw08BkS.js";
import "./device-pairing-DYWF-CWB.js";
import "./line-iO245OTq.js";
import "./upsert-with-lock-CLs2bE4R.js";
import "./self-hosted-provider-setup-C4OZCxyb.js";
import "./ollama-setup-BM-G12b6.js";
import { T as resolveMatrixAuth, b as listMatrixDirectoryGroupsLive, h as resolveMatrixTargets, n as sendMessageMatrix, r as sendPollMatrix, x as listMatrixDirectoryPeersLive } from "./send-BZy5aOBD.js";
import { i as getMatrixRuntime } from "./credentials-_LkDOqEi.js";
import { t as probeMatrix } from "./probe-DHjFbVtd.js";
//#region extensions/matrix/src/outbound.ts
const matrixOutbound = {
	deliveryMode: "direct",
	chunker: (text, limit) => getMatrixRuntime().channel.text.chunkMarkdownText(text, limit),
	chunkerMode: "markdown",
	textChunkLimit: 4e3,
	sendText: async ({ cfg, to, text, deps, replyToId, threadId, accountId }) => {
		const send = resolveOutboundSendDep(deps, "matrix") ?? sendMessageMatrix;
		const resolvedThreadId = threadId !== void 0 && threadId !== null ? String(threadId) : void 0;
		const result = await send(to, text, {
			cfg,
			replyToId: replyToId ?? void 0,
			threadId: resolvedThreadId,
			accountId: accountId ?? void 0
		});
		return {
			channel: "matrix",
			messageId: result.messageId,
			roomId: result.roomId
		};
	},
	sendMedia: async ({ cfg, to, text, mediaUrl, deps, replyToId, threadId, accountId }) => {
		const send = resolveOutboundSendDep(deps, "matrix") ?? sendMessageMatrix;
		const resolvedThreadId = threadId !== void 0 && threadId !== null ? String(threadId) : void 0;
		const result = await send(to, text, {
			cfg,
			mediaUrl,
			replyToId: replyToId ?? void 0,
			threadId: resolvedThreadId,
			accountId: accountId ?? void 0
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
			threadId: threadId !== void 0 && threadId !== null ? String(threadId) : void 0,
			accountId: accountId ?? void 0
		});
		return {
			channel: "matrix",
			messageId: result.eventId,
			roomId: result.roomId,
			pollId: result.eventId
		};
	}
};
//#endregion
export { listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive, matrixOutbound, probeMatrix, resolveMatrixAuth, resolveMatrixTargets, sendMessageMatrix };
