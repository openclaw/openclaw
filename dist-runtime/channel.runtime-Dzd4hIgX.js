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
import { d as searchGraphUsers, f as listChannelsForTeam, h as resolveGraphToken, m as normalizeQuery, p as listTeamsByName, t as getMSTeamsRuntime } from "./runtime-lVaFT2UB.js";
import { i as sendPollMSTeams, n as sendAdaptiveCardMSTeams, r as sendMessageMSTeams, t as probeMSTeams, v as createMSTeamsPollStoreFs } from "./probe-s38GsuRl.js";
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
