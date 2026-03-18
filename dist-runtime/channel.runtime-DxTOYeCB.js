import "./provider-env-vars-BfZUtZAn.js";
import "./resolve-route-CQsiaDZO.js";
import "./logger-BOdgfoqz.js";
import "./tmp-openclaw-dir-DgEKZnX6.js";
import "./paths-CbmqEZIn.js";
import "./subsystem-CsPxmH8p.js";
import "./utils-CMc9mmF8.js";
import "./fetch-BgkAjqxB.js";
import "./retry-CgLvWye-.js";
import "./agent-scope-CM8plEdu.js";
import "./exec-CWMR162-.js";
import "./logger-C833gw0R.js";
import "./paths-DAoqckDF.js";
import { ui as resolveOutboundSendDep } from "./auth-profiles-B70DPAVa.js";
import "./profiles-BC4VpDll.js";
import "./fetch-BX2RRCzB.js";
import "./external-content-CxoN_TKD.js";
import "./kilocode-shared-Ci8SRxXc.js";
import "./models-config.providers.static-DRBnLpDj.js";
import "./models-config.providers.discovery-gVOHvGnm.js";
import "./pairing-token-Do-E3rL5.js";
import "./query-expansion-Do6vyPvH.js";
import "./redact-BZcL_gJG.js";
import "./mime-33LCeGh-.js";
import "./resolve-utils-D6VN4BvH.js";
import "./typebox-B4kR5eyM.js";
import "./web-search-plugin-factory-CeUlA68v.js";
import "./compat-CwB8x8Tr.js";
import "./inbound-envelope-DsYY1Vpm.js";
import "./run-command-B9zmAfEF.js";
import "./device-pairing-CsJif6Rb.js";
import "./line-DvbTO_h3.js";
import "./upsert-with-lock-BkGBN4WL.js";
import "./self-hosted-provider-setup-Bgv4n1Xv.js";
import "./ollama-setup-CXkNt6CA.js";
import { T as resolveMatrixAuth, b as listMatrixDirectoryGroupsLive, h as resolveMatrixTargets, n as sendMessageMatrix, r as sendPollMatrix, x as listMatrixDirectoryPeersLive } from "./send-DNnFxfme.js";
import { s as getMatrixRuntime } from "./credentials-DVM78uq2.js";
import { t as probeMatrix } from "./probe-DdYpjo7Q.js";
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
