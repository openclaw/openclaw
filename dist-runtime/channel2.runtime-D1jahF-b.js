import "./redact-CPjO5IzK.js";
import "./errors-CHvVoeNX.js";
import "./unhandled-rejections-BUxLQs1F.js";
import "./globals-I5DlBD2D.js";
import "./paths-1qR_mW4i.js";
import "./theme-UkqnBJaj.js";
import "./subsystem-EnljYYs1.js";
import "./ansi-YpD2Ho3J.js";
import "./boolean-B938tROv.js";
import "./env-Bdj-riuG.js";
import "./warning-filter-xAwZkSAQ.js";
import "./utils-Do8MzKyM.js";
import "./links-Cx-Xmp-Y.js";
import { nl as resolveOutboundSendDep } from "./auth-profiles-DqxBs6Au.js";
import "./plugins-allowlist-CTOQWcBK.js";
import "./registry-DrRO3PZ7.js";
import "./fetch-DM2X1MUS.js";
import "./config-state-Dtu4rsXl.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-CA0yK887.js";
import "./method-scopes-DDb5C1xl.js";
import "./plugins-CygWjihb.js";
import "./brew-BBTHZkpM.js";
import "./agent-scope-tkfLX5MZ.js";
import "./logger-BwHrL168.js";
import "./exec-Fh3CK0qE.js";
import "./env-overrides-ArVaLl04.js";
import "./safe-text-ByhWP-8W.js";
import "./version-Dubp0iGu.js";
import "./config-VO8zzMSR.js";
import "./workspace-dirs-D1oDbsnN.js";
import "./search-manager-DIDe1qlM.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-CcKf_qr0.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-eb8njEg8.js";
import "./commands-BRfqrztE.js";
import "./ports-DeHp-MTZ.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-Cu8erp19.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-CfAp_q6e.js";
import "./paths-YN5WLIkL.js";
import "./session-cost-usage-DeAwWk6A.js";
import "./fetch-CzYOE42F.js";
import "./identity-file-Dh-pAEVE.js";
import "./dm-policy-shared-qfNerugD.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-BI0f8wZY.js";
import "./prompt-style-DqOsOwLH.js";
import "./secret-file-Bd-d3WTG.js";
import "./token-C5m9DX_R.js";
import "./restart-stale-pids-DzpGvXwg.js";
import "./accounts-B1y-wv7m.js";
import "./audit-CmcUcZU1.js";
import "./cli-utils-DRykF2zj.js";
import "./compat-Dz_94m24.js";
import "./inbound-envelope-CloZXXEC.js";
import "./device-pairing-BKsmUBWC.js";
import "./resolve-utils-Bz_rfQcP.js";
import { S as resolveMatrixTargets, m as listMatrixDirectoryPeersLive, n as sendMessageMatrix, p as listMatrixDirectoryGroupsLive, r as sendPollMatrix, v as resolveMatrixAuth } from "./send-CkNZlz10.js";
import { s as getMatrixRuntime } from "./credentials-CbR3GxLe.js";
import { t as probeMatrix } from "./probe-i66CY3tb.js";
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
