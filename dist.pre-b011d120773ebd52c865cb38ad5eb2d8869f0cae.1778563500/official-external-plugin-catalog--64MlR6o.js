import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { c as isRecord } from "./utils-D5swhEXt.js";
import { n as MANIFEST_KEY } from "./legacy-names-b8PgFyB2.js";
//#endregion
//#region src/plugins/official-external-plugin-catalog.ts
const OFFICIAL_CATALOG_SOURCES = [
	{ entries: [
		{
			"name": "@wecom/wecom-openclaw-plugin",
			"description": "OpenClaw WeCom channel plugin by the Tencent WeCom team.",
			"source": "external",
			"kind": "channel",
			"openclaw": {
				"plugin": {
					"id": "wecom-openclaw-plugin",
					"label": "WeCom"
				},
				"contracts": { "tools": ["wecom_mcp"] },
				"channel": {
					"id": "wecom",
					"label": "WeCom",
					"selectionLabel": "WeCom（企业微信）",
					"detailLabel": "WeCom",
					"docsPath": "/plugins/community#wecom",
					"docsLabel": "wecom",
					"blurb": "Enterprise messaging and documents, scheduling, task tools.",
					"aliases": [
						"qywx",
						"wework",
						"enterprise-wechat"
					],
					"order": 45
				},
				"channelConfigs": { "wecom": {
					"label": "WeCom",
					"description": "Enterprise WeChat conversation channel.",
					"schema": {
						"type": "object",
						"additionalProperties": true
					}
				} },
				"install": {
					"npmSpec": "@wecom/wecom-openclaw-plugin@2026.4.23",
					"defaultChoice": "npm",
					"expectedIntegrity": "sha512-bnzfdIEEu1/LFvcdyjaTkyxt27w6c7dqhkPezU62OWaqmcdFsUGR3T55USK/O9pIKsNcnL1Tnu1pqKYCWHFgWQ=="
				}
			}
		},
		{
			"name": "openclaw-plugin-yuanbao",
			"description": "OpenClaw Yuanbao channel plugin by the Tencent Yuanbao team.",
			"source": "external",
			"kind": "channel",
			"openclaw": {
				"plugin": {
					"id": "openclaw-plugin-yuanbao",
					"label": "Yuanbao"
				},
				"contracts": { "tools": [
					"query_group_info",
					"query_session_members",
					"yuanbao_remind"
				] },
				"channel": {
					"id": "yuanbao",
					"label": "Yuanbao",
					"selectionLabel": "Yuanbao (元宝)",
					"detailLabel": "Yuanbao",
					"docsPath": "/plugins/community#yuanbao",
					"docsLabel": "yuanbao",
					"blurb": "Tencent Yuanbao AI assistant conversation channel.",
					"aliases": [
						"yuanbao",
						"yb",
						"tencent-yuanbao",
						"元宝"
					],
					"order": 85
				},
				"channelConfigs": { "yuanbao": {
					"label": "Yuanbao",
					"description": "Tencent Yuanbao AI assistant channel.",
					"schema": {
						"type": "object",
						"additionalProperties": true
					}
				} },
				"install": {
					"npmSpec": "openclaw-plugin-yuanbao@2.11.0",
					"defaultChoice": "npm",
					"expectedIntegrity": "sha512-lYmBrU71ox3v7dzRqaltvzTXPcMjjgYrNqpBj5HIBkXgEFkXRRG8wplXg9Fub41/FjsSPn3WAbYpdTc+k+jsHg=="
				}
			}
		},
		{
			"name": "@openclaw/bluebubbles",
			"description": "OpenClaw BlueBubbles channel plugin",
			"source": "official",
			"kind": "channel",
			"openclaw": {
				"channel": {
					"id": "bluebubbles",
					"label": "BlueBubbles",
					"selectionLabel": "BlueBubbles (macOS app)",
					"detailLabel": "BlueBubbles",
					"docsPath": "/channels/bluebubbles",
					"docsLabel": "bluebubbles",
					"blurb": "iMessage via the BlueBubbles mac app + REST API.",
					"aliases": ["bb"],
					"preferOver": ["imessage"],
					"systemImage": "bubble.left.and.text.bubble.right",
					"order": 75
				},
				"install": {
					"npmSpec": "@openclaw/bluebubbles",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.10"
				}
			}
		},
		{
			"name": "@openclaw/discord",
			"description": "OpenClaw Discord channel plugin",
			"source": "official",
			"kind": "channel",
			"openclaw": {
				"channel": {
					"id": "discord",
					"label": "Discord",
					"selectionLabel": "Discord (Bot API)",
					"detailLabel": "Discord Bot",
					"docsPath": "/channels/discord",
					"docsLabel": "discord",
					"blurb": "very well supported right now.",
					"systemImage": "bubble.left.and.bubble.right",
					"markdownCapable": true,
					"preferSessionLookupForAnnounceTarget": true
				},
				"install": {
					"npmSpec": "@openclaw/discord",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.10",
					"allowInvalidConfigRecovery": true
				}
			}
		},
		{
			"name": "@openclaw/feishu",
			"description": "OpenClaw Feishu/Lark channel plugin",
			"source": "official",
			"kind": "channel",
			"openclaw": {
				"channel": {
					"id": "feishu",
					"label": "Feishu",
					"selectionLabel": "Feishu/Lark (飞书)",
					"docsPath": "/channels/feishu",
					"docsLabel": "feishu",
					"blurb": "飞书/Lark enterprise messaging with doc/wiki/drive tools.",
					"aliases": ["lark"],
					"order": 35,
					"quickstartAllowFrom": true
				},
				"install": {
					"npmSpec": "@openclaw/feishu",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.25"
				}
			}
		},
		{
			"name": "@openclaw/googlechat",
			"description": "OpenClaw Google Chat channel plugin",
			"source": "official",
			"kind": "channel",
			"openclaw": {
				"channel": {
					"id": "googlechat",
					"label": "Google Chat",
					"selectionLabel": "Google Chat (Chat API)",
					"detailLabel": "Google Chat",
					"docsPath": "/channels/googlechat",
					"docsLabel": "googlechat",
					"blurb": "Google Workspace Chat app with HTTP webhook.",
					"aliases": ["gchat", "google-chat"],
					"order": 55,
					"systemImage": "message.badge",
					"markdownCapable": true,
					"doctorCapabilities": {
						"dmAllowFromMode": "nestedOnly",
						"groupModel": "route",
						"groupAllowFromFallbackToAllowFrom": false,
						"warnOnEmptyGroupSenderAllowlist": false
					},
					"cliAddOptions": [
						{
							"flags": "--webhook-path <path>",
							"description": "Google Chat webhook path"
						},
						{
							"flags": "--webhook-url <url>",
							"description": "Google Chat webhook URL"
						},
						{
							"flags": "--audience-type <type>",
							"description": "Google Chat audience type (app-url|project-number)"
						},
						{
							"flags": "--audience <value>",
							"description": "Google Chat audience value (app URL or project number)"
						}
					]
				},
				"install": {
					"npmSpec": "@openclaw/googlechat",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.10"
				}
			}
		},
		{
			"name": "@openclaw/line",
			"description": "OpenClaw LINE channel plugin",
			"source": "official",
			"kind": "channel",
			"openclaw": {
				"channel": {
					"id": "line",
					"label": "LINE",
					"selectionLabel": "LINE (Messaging API)",
					"detailLabel": "LINE Bot",
					"docsPath": "/channels/line",
					"docsLabel": "line",
					"blurb": "LINE Messaging API webhook bot.",
					"systemImage": "message",
					"order": 75,
					"quickstartAllowFrom": true
				},
				"install": {
					"npmSpec": "@openclaw/line",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.10"
				}
			}
		},
		{
			"name": "@openclaw/msteams",
			"description": "OpenClaw Microsoft Teams channel plugin",
			"source": "official",
			"kind": "channel",
			"openclaw": {
				"channel": {
					"id": "msteams",
					"label": "Microsoft Teams",
					"selectionLabel": "Microsoft Teams (Teams SDK)",
					"docsPath": "/channels/msteams",
					"docsLabel": "msteams",
					"blurb": "Teams SDK; enterprise support.",
					"aliases": ["teams"],
					"order": 60
				},
				"install": {
					"npmSpec": "@openclaw/msteams",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.10"
				}
			}
		},
		{
			"name": "@openclaw/nextcloud-talk",
			"description": "OpenClaw Nextcloud Talk channel plugin",
			"source": "official",
			"kind": "channel",
			"openclaw": {
				"channel": {
					"id": "nextcloud-talk",
					"label": "Nextcloud Talk",
					"selectionLabel": "Nextcloud Talk (self-hosted)",
					"docsPath": "/channels/nextcloud-talk",
					"docsLabel": "nextcloud-talk",
					"blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
					"aliases": ["nc-talk", "nc"],
					"order": 65,
					"quickstartAllowFrom": true
				},
				"install": {
					"npmSpec": "@openclaw/nextcloud-talk",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.10"
				}
			}
		},
		{
			"name": "@openclaw/nostr",
			"description": "OpenClaw Nostr channel plugin for NIP-04 encrypted DMs",
			"source": "official",
			"kind": "channel",
			"openclaw": {
				"channel": {
					"id": "nostr",
					"label": "Nostr",
					"selectionLabel": "Nostr (NIP-04 DMs)",
					"docsPath": "/channels/nostr",
					"docsLabel": "nostr",
					"blurb": "Decentralized protocol; encrypted DMs via NIP-04.",
					"order": 55,
					"quickstartAllowFrom": true
				},
				"install": {
					"npmSpec": "@openclaw/nostr",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.10"
				}
			}
		},
		{
			"name": "@openclaw/qqbot",
			"description": "OpenClaw QQ Bot channel plugin",
			"source": "official",
			"kind": "channel",
			"openclaw": {
				"channel": {
					"id": "qqbot",
					"label": "QQ Bot",
					"selectionLabel": "QQ Bot (Official API)",
					"detailLabel": "QQ Bot",
					"docsPath": "/channels/qqbot",
					"docsLabel": "qqbot",
					"blurb": "connect to QQ via official QQ Bot API with group chat and direct message support.",
					"systemImage": "bubble.left.and.bubble.right"
				},
				"install": {
					"npmSpec": "@openclaw/qqbot",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.10"
				}
			}
		},
		{
			"name": "@openclaw/synology-chat",
			"description": "Synology Chat channel plugin for OpenClaw",
			"source": "official",
			"kind": "channel",
			"openclaw": {
				"channel": {
					"id": "synology-chat",
					"label": "Synology Chat",
					"selectionLabel": "Synology Chat (Webhook)",
					"docsPath": "/channels/synology-chat",
					"docsLabel": "synology-chat",
					"blurb": "Connect your Synology NAS Chat to OpenClaw with full agent capabilities.",
					"order": 90
				},
				"install": {
					"npmSpec": "@openclaw/synology-chat",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.10"
				}
			}
		},
		{
			"name": "@openclaw/tlon",
			"description": "OpenClaw Tlon/Urbit channel plugin",
			"source": "official",
			"kind": "channel",
			"openclaw": {
				"channel": {
					"id": "tlon",
					"label": "Tlon",
					"selectionLabel": "Tlon (Urbit)",
					"docsPath": "/channels/tlon",
					"docsLabel": "tlon",
					"blurb": "decentralized messaging on Urbit; install the plugin to enable.",
					"order": 90,
					"quickstartAllowFrom": true
				},
				"install": {
					"npmSpec": "@openclaw/tlon",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.10"
				}
			}
		},
		{
			"name": "@openclaw/twitch",
			"description": "OpenClaw Twitch channel plugin",
			"source": "official",
			"kind": "channel",
			"openclaw": {
				"channel": {
					"id": "twitch",
					"label": "Twitch",
					"selectionLabel": "Twitch (Chat)",
					"docsPath": "/channels/twitch",
					"blurb": "Twitch chat integration",
					"aliases": ["twitch-chat"]
				},
				"install": {
					"npmSpec": "@openclaw/twitch",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.10"
				}
			}
		},
		{
			"name": "@openclaw/whatsapp",
			"description": "OpenClaw WhatsApp channel plugin",
			"source": "official",
			"kind": "channel",
			"openclaw": {
				"channel": {
					"id": "whatsapp",
					"label": "WhatsApp",
					"selectionLabel": "WhatsApp (QR link)",
					"detailLabel": "WhatsApp Web",
					"docsPath": "/channels/whatsapp",
					"docsLabel": "whatsapp",
					"blurb": "works with your own number; recommend a separate phone + eSIM.",
					"systemImage": "message"
				},
				"install": {
					"npmSpec": "@openclaw/whatsapp",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.25"
				}
			}
		},
		{
			"name": "@openclaw/zalo",
			"description": "OpenClaw Zalo channel plugin",
			"source": "official",
			"kind": "channel",
			"openclaw": {
				"channel": {
					"id": "zalo",
					"label": "Zalo",
					"selectionLabel": "Zalo (Bot API)",
					"docsPath": "/channels/zalo",
					"docsLabel": "zalo",
					"blurb": "Vietnam-focused messaging platform with Bot API.",
					"aliases": ["zl"],
					"order": 80,
					"quickstartAllowFrom": true
				},
				"install": {
					"npmSpec": "@openclaw/zalo",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.10"
				}
			}
		},
		{
			"name": "@openclaw/zalouser",
			"description": "OpenClaw Zalo Personal Account plugin via native zca-js integration",
			"source": "official",
			"kind": "channel",
			"openclaw": {
				"channel": {
					"id": "zalouser",
					"label": "Zalo Personal",
					"selectionLabel": "Zalo (Personal Account)",
					"docsPath": "/channels/zalouser",
					"docsLabel": "zalouser",
					"blurb": "Zalo personal account via QR code login.",
					"aliases": ["zlu"],
					"order": 85,
					"quickstartAllowFrom": false
				},
				"install": {
					"npmSpec": "@openclaw/zalouser",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.10"
				}
			}
		}
	] },
	{ entries: [{
		"name": "@openclaw/codex",
		"description": "OpenClaw Codex harness and model provider plugin",
		"source": "official",
		"kind": "provider",
		"openclaw": {
			"plugin": {
				"id": "codex",
				"label": "Codex"
			},
			"providers": [{
				"id": "codex",
				"name": "Codex",
				"docs": "/providers/models",
				"categories": ["cloud", "llm"],
				"authChoices": [{
					"method": "app-server",
					"choiceId": "codex",
					"choiceLabel": "Codex app-server",
					"choiceHint": "Use the Codex app-server runtime and managed model catalog.",
					"assistantPriority": -40,
					"groupId": "codex",
					"groupLabel": "Codex",
					"groupHint": "Codex app-server model provider",
					"onboardingScopes": ["text-inference"]
				}]
			}],
			"install": {
				"npmSpec": "@openclaw/codex",
				"defaultChoice": "npm",
				"minHostVersion": ">=2026.5.1-beta.1"
			}
		}
	}] },
	{ entries: [
		{
			"name": "@openclaw/acpx",
			"description": "OpenClaw ACP runtime backend",
			"source": "official",
			"kind": "plugin",
			"openclaw": {
				"plugin": {
					"id": "acpx",
					"label": "ACPX Runtime"
				},
				"install": {
					"npmSpec": "@openclaw/acpx",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.25"
				}
			}
		},
		{
			"name": "@openclaw/brave-plugin",
			"description": "OpenClaw Brave plugin",
			"source": "official",
			"kind": "plugin",
			"openclaw": {
				"plugin": {
					"id": "brave",
					"label": "Brave"
				},
				"webSearchProviders": [{
					"id": "brave",
					"label": "Brave Search",
					"hint": "Brave Search web results.",
					"onboardingScopes": ["text-inference"],
					"credentialLabel": "Brave Search API key",
					"envVars": ["BRAVE_API_KEY"],
					"placeholder": "BSA...",
					"signupUrl": "https://api-dashboard.search.brave.com/app/keys",
					"docsUrl": "https://docs.openclaw.ai/tools/brave-search",
					"credentialPath": "plugins.entries.brave.config.webSearch.apiKey",
					"autoDetectOrder": 10
				}],
				"install": {
					"npmSpec": "@openclaw/brave-plugin",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.10"
				}
			}
		},
		{
			"name": "@openclaw/diagnostics-otel",
			"description": "OpenClaw diagnostics OpenTelemetry exporter",
			"source": "official",
			"kind": "plugin",
			"openclaw": {
				"plugin": {
					"id": "diagnostics-otel",
					"label": "Diagnostics OpenTelemetry"
				},
				"install": {
					"clawhubSpec": "clawhub:@openclaw/diagnostics-otel",
					"npmSpec": "@openclaw/diagnostics-otel",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.25"
				}
			}
		},
		{
			"name": "@openclaw/diagnostics-prometheus",
			"description": "OpenClaw diagnostics Prometheus exporter",
			"source": "official",
			"kind": "plugin",
			"openclaw": {
				"plugin": {
					"id": "diagnostics-prometheus",
					"label": "Diagnostics Prometheus"
				},
				"install": {
					"clawhubSpec": "clawhub:@openclaw/diagnostics-prometheus",
					"npmSpec": "@openclaw/diagnostics-prometheus",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.25"
				}
			}
		},
		{
			"name": "@openclaw/diffs",
			"description": "OpenClaw diff viewer plugin",
			"source": "official",
			"kind": "plugin",
			"openclaw": {
				"plugin": {
					"id": "diffs",
					"label": "Diffs"
				},
				"install": {
					"npmSpec": "@openclaw/diffs",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.30"
				}
			}
		},
		{
			"name": "@openclaw/google-meet",
			"description": "OpenClaw Google Meet participant plugin",
			"source": "official",
			"kind": "plugin",
			"openclaw": {
				"plugin": {
					"id": "google-meet",
					"label": "Google Meet"
				},
				"install": {
					"npmSpec": "@openclaw/google-meet",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.20"
				}
			}
		},
		{
			"name": "@openclaw/lobster",
			"description": "Lobster workflow tool plugin (typed pipelines + resumable approvals)",
			"source": "official",
			"kind": "plugin",
			"openclaw": {
				"plugin": {
					"id": "lobster",
					"label": "Lobster"
				},
				"install": {
					"npmSpec": "@openclaw/lobster",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.25"
				}
			}
		},
		{
			"name": "@openclaw/memory-lancedb",
			"description": "OpenClaw LanceDB-backed long-term memory plugin with auto-recall/capture",
			"source": "official",
			"kind": "plugin",
			"openclaw": {
				"plugin": {
					"id": "memory-lancedb",
					"label": "Memory LanceDB"
				},
				"install": {
					"npmSpec": "@openclaw/memory-lancedb",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.10"
				}
			}
		},
		{
			"name": "@openclaw/voice-call",
			"description": "OpenClaw voice-call plugin",
			"source": "official",
			"kind": "plugin",
			"openclaw": {
				"plugin": {
					"id": "voice-call",
					"label": "Voice Call"
				},
				"install": {
					"npmSpec": "@openclaw/voice-call",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.4.10"
				}
			}
		}
	] }
];
function parseCatalogEntries(raw) {
	if (Array.isArray(raw)) return raw.filter((entry) => isRecord(entry));
	if (!isRecord(raw)) return [];
	const list = raw.entries ?? raw.packages ?? raw.plugins;
	if (!Array.isArray(list)) return [];
	return list.filter((entry) => isRecord(entry));
}
function normalizeDefaultChoice(value) {
	return value === "clawhub" || value === "npm" || value === "local" ? value : void 0;
}
function getOfficialExternalPluginCatalogManifest(entry) {
	const manifest = entry[MANIFEST_KEY];
	return isRecord(manifest) ? manifest : void 0;
}
function resolveOfficialExternalPluginId(entry) {
	const manifest = getOfficialExternalPluginCatalogManifest(entry);
	return normalizeOptionalString(manifest?.plugin?.id) ?? normalizeOptionalString(manifest?.channel?.id) ?? normalizeOptionalString(manifest?.providers?.[0]?.id);
}
function resolveOfficialExternalPluginLookupIds(entry) {
	const manifest = getOfficialExternalPluginCatalogManifest(entry);
	return [
		normalizeOptionalString(manifest?.plugin?.id),
		normalizeOptionalString(manifest?.channel?.id),
		normalizeOptionalString(manifest?.providers?.[0]?.id)
	].filter((value, index, all) => Boolean(value) && all.indexOf(value) === index);
}
function resolveOfficialExternalPluginLabel(entry) {
	const manifest = getOfficialExternalPluginCatalogManifest(entry);
	return normalizeOptionalString(manifest?.plugin?.label) ?? normalizeOptionalString(manifest?.channel?.label) ?? normalizeOptionalString(manifest?.providers?.[0]?.name) ?? normalizeOptionalString(entry.name) ?? resolveOfficialExternalPluginId(entry) ?? "plugin";
}
function resolveOfficialExternalPluginInstall(entry) {
	const install = getOfficialExternalPluginCatalogManifest(entry)?.install;
	const clawhubSpec = normalizeOptionalString(install?.clawhubSpec);
	const npmSpec = normalizeOptionalString(install?.npmSpec) ?? normalizeOptionalString(entry.name);
	const localPath = normalizeOptionalString(install?.localPath);
	if (!clawhubSpec && !npmSpec && !localPath) return null;
	const defaultChoice = normalizeDefaultChoice(install?.defaultChoice) ?? (npmSpec ? "npm" : clawhubSpec ? "clawhub" : localPath ? "local" : void 0);
	return {
		...clawhubSpec ? { clawhubSpec } : {},
		...npmSpec ? { npmSpec } : {},
		...localPath ? { localPath } : {},
		...defaultChoice ? { defaultChoice } : {},
		...install?.minHostVersion ? { minHostVersion: install.minHostVersion } : {},
		...install?.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {},
		...install?.allowInvalidConfigRecovery === true ? { allowInvalidConfigRecovery: true } : {}
	};
}
function listOfficialExternalPluginCatalogEntries() {
	const entries = OFFICIAL_CATALOG_SOURCES.flatMap((source) => parseCatalogEntries(source));
	const resolved = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		const pluginId = resolveOfficialExternalPluginId(entry);
		const key = pluginId ? `${entry.kind ?? "plugin"}:${pluginId}` : entry.name ?? "";
		if (key && !resolved.has(key)) resolved.set(key, entry);
	}
	return [...resolved.values()];
}
function listOfficialExternalChannelCatalogEntries() {
	return listOfficialExternalPluginCatalogEntries().filter((entry) => Boolean(getOfficialExternalPluginCatalogManifest(entry)?.channel));
}
function listOfficialExternalProviderCatalogEntries() {
	return listOfficialExternalPluginCatalogEntries().filter((entry) => (getOfficialExternalPluginCatalogManifest(entry)?.providers?.length ?? 0) > 0);
}
function getOfficialExternalPluginCatalogEntry(pluginId) {
	const normalized = pluginId.trim();
	if (!normalized) return;
	return listOfficialExternalPluginCatalogEntries().find((entry) => resolveOfficialExternalPluginLookupIds(entry).includes(normalized));
}
function getOfficialExternalPluginCatalogEntryForPackage(packageName) {
	const normalized = packageName?.trim();
	if (!normalized) return;
	return listOfficialExternalPluginCatalogEntries().find((entry) => normalizeOptionalString(entry.name) === normalized);
}
//#endregion
export { listOfficialExternalPluginCatalogEntries as a, resolveOfficialExternalPluginInstall as c, listOfficialExternalChannelCatalogEntries as i, resolveOfficialExternalPluginLabel as l, getOfficialExternalPluginCatalogEntryForPackage as n, listOfficialExternalProviderCatalogEntries as o, getOfficialExternalPluginCatalogManifest as r, resolveOfficialExternalPluginId as s, getOfficialExternalPluginCatalogEntry as t };
