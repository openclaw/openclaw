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
import { d as searchGraphUsers, f as listChannelsForTeam, h as resolveGraphToken, m as normalizeQuery, p as listTeamsByName, t as getMSTeamsRuntime } from "./runtime-D9KaAwmQ.js";
import { i as sendPollMSTeams, n as sendAdaptiveCardMSTeams, r as sendMessageMSTeams, t as probeMSTeams, v as createMSTeamsPollStoreFs } from "./probe-BB1WfT_w.js";
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
