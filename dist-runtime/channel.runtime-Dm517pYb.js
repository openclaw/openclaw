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
import { a as normalizeQuery, i as listTeamsByName, n as searchGraphUsers, o as resolveGraphToken, r as listChannelsForTeam, t as getMSTeamsRuntime } from "./runtime-DXsbYZ5B.js";
import { i as sendPollMSTeams, n as sendAdaptiveCardMSTeams, r as sendMessageMSTeams, t as probeMSTeams, v as createMSTeamsPollStoreFs } from "./probe-Do4e-uZO.js";
//#region extensions/msteams/src/directory-live.ts
async function listMSTeamsDirectoryPeersLive(params) {
	const query = normalizeQuery(params.query);
	if (!query) {return [];}
	return (await searchGraphUsers({
		token: await resolveGraphToken(params.cfg),
		query,
		top: typeof params.limit === "number" && params.limit > 0 ? params.limit : 20
	})).map((user) => {
		const id = user.id?.trim();
		if (!id) {return null;}
		const name = user.displayName?.trim();
		const handle = user.userPrincipalName?.trim() || user.mail?.trim();
		return {
			kind: "user",
			id: `user:${id}`,
			name: name || void 0,
			handle: handle ? `@${handle}` : void 0,
			raw: user
		};
	}).filter(Boolean);
}
async function listMSTeamsDirectoryGroupsLive(params) {
	const rawQuery = normalizeQuery(params.query);
	if (!rawQuery) {return [];}
	const token = await resolveGraphToken(params.cfg);
	const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 20;
	const [teamQuery, channelQuery] = rawQuery.includes("/") ? rawQuery.split("/", 2).map((part) => part.trim()).filter(Boolean) : [rawQuery, null];
	const teams = await listTeamsByName(token, teamQuery);
	const results = [];
	for (const team of teams) {
		const teamId = team.id?.trim();
		if (!teamId) {continue;}
		const teamName = team.displayName?.trim() || teamQuery;
		if (!channelQuery) {
			results.push({
				kind: "group",
				id: `team:${teamId}`,
				name: teamName,
				handle: teamName ? `#${teamName}` : void 0,
				raw: team
			});
			if (results.length >= limit) {return results;}
			continue;
		}
		const channels = await listChannelsForTeam(token, teamId);
		for (const channel of channels) {
			const name = channel.displayName?.trim();
			if (!name) {continue;}
			if (!name.toLowerCase().includes(channelQuery.toLowerCase())) {continue;}
			results.push({
				kind: "group",
				id: `conversation:${channel.id}`,
				name: `${teamName}/${name}`,
				handle: `#${name}`,
				raw: channel
			});
			if (results.length >= limit) {return results;}
		}
	}
	return results;
}
//#endregion
//#region extensions/msteams/src/outbound.ts
const msteamsOutbound = {
	deliveryMode: "direct",
	chunker: (text, limit) => getMSTeamsRuntime().channel.text.chunkMarkdownText(text, limit),
	chunkerMode: "markdown",
	textChunkLimit: 4e3,
	pollMaxOptions: 12,
	sendText: async ({ cfg, to, text, deps }) => {
		return {
			channel: "msteams",
			...await (resolveOutboundSendDep(deps, "msteams") ?? ((to, text) => sendMessageMSTeams({
				cfg,
				to,
				text
			})))(to, text)
		};
	},
	sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, deps }) => {
		return {
			channel: "msteams",
			...await (resolveOutboundSendDep(deps, "msteams") ?? ((to, text, opts) => sendMessageMSTeams({
				cfg,
				to,
				text,
				mediaUrl: opts?.mediaUrl,
				mediaLocalRoots: opts?.mediaLocalRoots
			})))(to, text, {
				mediaUrl,
				mediaLocalRoots
			})
		};
	},
	sendPoll: async ({ cfg, to, poll }) => {
		const maxSelections = poll.maxSelections ?? 1;
		const result = await sendPollMSTeams({
			cfg,
			to,
			question: poll.question,
			options: poll.options,
			maxSelections
		});
		await createMSTeamsPollStoreFs().createPoll({
			id: result.pollId,
			question: poll.question,
			options: poll.options,
			maxSelections,
			createdAt: (/* @__PURE__ */ new Date()).toISOString(),
			conversationId: result.conversationId,
			messageId: result.messageId,
			votes: {}
		});
		return result;
	}
};
//#endregion
export { listMSTeamsDirectoryGroupsLive, listMSTeamsDirectoryPeersLive, msteamsOutbound, probeMSTeams, sendAdaptiveCardMSTeams, sendMessageMSTeams };
