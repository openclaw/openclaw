import { t as formatDocsLink } from "./links-Dz4PCYCN.js";
import { t as adaptScopedAccountAccessor } from "./channel-config-helpers-Dzal6cfS.js";
import { A as promptLegacyChannelAllowFromForAccount, I as resolveEntriesWithOptionalToken, S as parseMentionOrPrefixedId, b as noteChannelLookupFailure, x as noteChannelLookupSummary } from "./setup-wizard-helpers-Cm8y4liy.js";
import "./setup-runtime-hbbN9wHP.js";
import "./setup-tools-WOmaR-iv.js";
import { a as resolveSlackAccount, i as resolveDefaultSlackAccountId, o as resolveSlackAccountAllowFrom } from "./accounts-Ba1LnRZV.js";
import "./shared-C6EpakPw.js";
import { i as SLACK_CHANNEL, t as createSlackSetupWizardBase } from "./setup-core-VYPiralZ.js";
import { t as resolveSlackChannelAllowlist } from "./resolve-channels-CFu2DI7Q.js";
import { t as resolveSlackUserAllowlist } from "./resolve-users-s6WKqdm9.js";
//#region extensions/slack/src/setup-surface.ts
async function resolveSlackAllowFromEntries(params) {
	return await resolveEntriesWithOptionalToken({
		token: params.token,
		entries: params.entries,
		buildWithoutToken: (input) => ({
			input,
			resolved: false,
			id: null
		}),
		resolveEntries: async ({ token, entries }) => (await resolveSlackUserAllowlist({
			token,
			entries
		})).map((entry) => ({
			input: entry.input,
			resolved: entry.resolved,
			id: entry.id ?? null
		}))
	});
}
async function promptSlackAllowFrom(params) {
	const parseId = (value) => parseMentionOrPrefixedId({
		value,
		mentionPattern: /^<@([A-Z0-9]+)>$/i,
		prefixPattern: /^(slack:|user:)/i,
		idPattern: /^[A-Z][A-Z0-9]+$/i,
		normalizeId: (id) => id.toUpperCase()
	});
	return await promptLegacyChannelAllowFromForAccount({
		cfg: params.cfg,
		channel: SLACK_CHANNEL,
		prompter: params.prompter,
		accountId: params.accountId,
		defaultAccountId: resolveDefaultSlackAccountId(params.cfg),
		resolveAccount: adaptScopedAccountAccessor(resolveSlackAccount),
		resolveExisting: (account, cfg) => resolveSlackAccountAllowFrom({
			cfg,
			accountId: account.accountId
		}) ?? [],
		resolveToken: (account) => account.userToken ?? account.botToken ?? "",
		noteTitle: "Slack allowlist",
		noteLines: [
			"Allowlist Slack DMs by username (we resolve to user ids).",
			"Examples:",
			"- U12345678",
			"- @alice",
			"Multiple entries: comma-separated.",
			`Docs: ${formatDocsLink("/slack", "slack")}`
		],
		message: "Slack allowFrom (usernames or ids)",
		placeholder: "@alice, U12345678",
		parseId,
		invalidWithoutTokenNote: "Slack token missing; use user ids (or mention form) only.",
		resolveEntries: async ({ token, entries }) => (await resolveSlackUserAllowlist({
			token,
			entries
		})).map((entry) => ({
			input: entry.input,
			resolved: entry.resolved,
			id: entry.id ?? null
		}))
	});
}
async function resolveSlackGroupAllowlist(params) {
	let keys = params.entries;
	const activeBotToken = resolveSlackAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).botToken || params.credentialValues.botToken || "";
	if (params.entries.length > 0) try {
		const resolved = await resolveEntriesWithOptionalToken({
			token: activeBotToken,
			entries: params.entries,
			buildWithoutToken: (input) => ({
				input,
				resolved: false,
				id: void 0
			}),
			resolveEntries: async ({ token, entries }) => await resolveSlackChannelAllowlist({
				token,
				entries
			})
		});
		const resolvedKeys = resolved.filter((entry) => entry.resolved && entry.id).map((entry) => entry.id);
		const unresolved = resolved.filter((entry) => !entry.resolved).map((entry) => entry.input);
		keys = [...resolvedKeys, ...unresolved.map((entry) => entry.trim()).filter(Boolean)];
		await noteChannelLookupSummary({
			prompter: params.prompter,
			label: "Slack channels",
			resolvedSections: [{
				title: "Resolved",
				values: resolvedKeys
			}],
			unresolved
		});
	} catch (error) {
		await noteChannelLookupFailure({
			prompter: params.prompter,
			label: "Slack channels",
			error
		});
	}
	return keys;
}
const slackSetupWizard = createSlackSetupWizardBase({
	promptAllowFrom: promptSlackAllowFrom,
	resolveAllowFromEntries: async ({ credentialValues, entries }) => await resolveSlackAllowFromEntries({
		token: credentialValues.botToken,
		entries
	}),
	resolveGroupAllowlist: async ({ cfg, accountId, credentialValues, entries, prompter }) => await resolveSlackGroupAllowlist({
		cfg,
		accountId,
		credentialValues,
		entries,
		prompter
	})
});
//#endregion
export { slackSetupWizard };
