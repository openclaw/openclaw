import "./redact-qojvLPM7.js";
import "./errors-nCFRNLA6.js";
import "./unhandled-rejections-DGuis5pC.js";
import "./globals-B6h30oSy.js";
import "./paths-DqbqmTPe.js";
import "./theme-CL08MjAq.js";
import "./subsystem-CZwunM2N.js";
import "./ansi-CeMmGDji.js";
import "./boolean-B938tROv.js";
import "./env--LwFRA3k.js";
import "./warning-filter-xAwZkSAQ.js";
import "./utils-BiUV1eIQ.js";
import "./links-DPi3kBux.js";
import { tl as resolveOutboundSendDep } from "./auth-profiles-DAOR1fRn.js";
import "./plugins-allowlist-E4LSkJ7R.js";
import "./registry-ep1yQ6WN.js";
import "./fetch-COjVSrBr.js";
import "./config-state-CkhXLglq.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-DZywV-kg.js";
import "./method-scopes-CLHNYIU6.js";
import "./plugins-DC9n978g.js";
import "./brew-CAA1PAwX.js";
import "./agent-scope-C0PckUtv.js";
import "./logger-DLmJXd-S.js";
import "./exec-BmPfiSbq.js";
import "./env-overrides-Dbt5eAZJ.js";
import "./safe-text-BN5UJvnR.js";
import "./version-Dubp0iGu.js";
import "./config-DZ3oWznn.js";
import "./workspace-dirs-Ejflbukt.js";
import "./search-manager-CVctuSlw.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-V82ct97U.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-DUmWDILI.js";
import "./commands-BfMCtxuV.js";
import "./ports-D4BnBb9r.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-DMTCLBKm.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-_j5H8TrE.js";
import "./paths-55bRPK_d.js";
import "./session-cost-usage-DqIvfSaZ.js";
import "./fetch-wLdC1F30.js";
import "./identity-file-GRgHESaI.js";
import "./dm-policy-shared-QWD8iFx0.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-ur8rDo4q.js";
import "./prompt-style-CEH2A0QE.js";
import "./secret-file-CGJfrW4K.js";
import "./token-BE5e8NTA.js";
import "./restart-stale-pids-Be6QOzfZ.js";
import "./accounts-C8zoA5z4.js";
import "./audit-BTP1ZwHz.js";
import "./cli-utils-DRykF2zj.js";
import "./compat-aC6dpiEb.js";
import "./inbound-envelope-aY_xfQcC.js";
import "./device-pairing-D3SsXoQX.js";
import "./resolve-utils-P7inlndK.js";
import { a as normalizeQuery, i as listTeamsByName, n as searchGraphUsers, o as resolveGraphToken, r as listChannelsForTeam, t as getMSTeamsRuntime } from "./runtime-DP3qTCtk.js";
import { i as sendPollMSTeams, n as sendAdaptiveCardMSTeams, r as sendMessageMSTeams, t as probeMSTeams, v as createMSTeamsPollStoreFs } from "./probe-B_3iQ9am.js";
//#region extensions/msteams/src/directory-live.ts
async function listMSTeamsDirectoryPeersLive(params) {
	const query = normalizeQuery(params.query);
	if (!query) return [];
	return (await searchGraphUsers({
		token: await resolveGraphToken(params.cfg),
		query,
		top: typeof params.limit === "number" && params.limit > 0 ? params.limit : 20
	})).map((user) => {
		const id = user.id?.trim();
		if (!id) return null;
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
	if (!rawQuery) return [];
	const token = await resolveGraphToken(params.cfg);
	const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 20;
	const [teamQuery, channelQuery] = rawQuery.includes("/") ? rawQuery.split("/", 2).map((part) => part.trim()).filter(Boolean) : [rawQuery, null];
	const teams = await listTeamsByName(token, teamQuery);
	const results = [];
	for (const team of teams) {
		const teamId = team.id?.trim();
		if (!teamId) continue;
		const teamName = team.displayName?.trim() || teamQuery;
		if (!channelQuery) {
			results.push({
				kind: "group",
				id: `team:${teamId}`,
				name: teamName,
				handle: teamName ? `#${teamName}` : void 0,
				raw: team
			});
			if (results.length >= limit) return results;
			continue;
		}
		const channels = await listChannelsForTeam(token, teamId);
		for (const channel of channels) {
			const name = channel.displayName?.trim();
			if (!name) continue;
			if (!name.toLowerCase().includes(channelQuery.toLowerCase())) continue;
			results.push({
				kind: "group",
				id: `conversation:${channel.id}`,
				name: `${teamName}/${name}`,
				handle: `#${name}`,
				raw: channel
			});
			if (results.length >= limit) return results;
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
