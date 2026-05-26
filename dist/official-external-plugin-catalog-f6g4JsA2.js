import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import { n as MANIFEST_KEY } from "./legacy-names-CuutNmLC.js";
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
					"npmSpec": "@wecom/wecom-openclaw-plugin@2026.5.7",
					"defaultChoice": "npm",
					"expectedIntegrity": "sha512-TCkP9as00WfEhgFWG8YL/rcmaWGIshAki2HQh83nTRccGfVBCoGjrEboTTqq3yDmK9koWTV11zi8u8A4dNtvug=="
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
					"npmSpec": "openclaw-plugin-yuanbao@2.13.1",
					"defaultChoice": "npm",
					"expectedIntegrity": "sha512-lH2I9/nsmrg7l0YJJSQhOSpWMEFBAa6FwKbZcRLDFHDT2+mOZkHa44XE+8KYN4VmorlUdAxHzpZQmVr7C98IuA=="
				}
			}
		},
		{
			"name": "@tencent-weixin/openclaw-weixin",
			"description": "OpenClaw Weixin channel plugin by the Tencent Weixin team.",
			"source": "external",
			"kind": "channel",
			"openclaw": {
				"plugin": {
					"id": "openclaw-weixin",
					"label": "Weixin"
				},
				"channel": {
					"id": "openclaw-weixin",
					"label": "Weixin",
					"selectionLabel": "Weixin（微信）",
					"detailLabel": "Weixin",
					"docsPath": "/channels/wechat",
					"docsLabel": "weixin",
					"blurb": "Personal WeChat messaging via QR-code login.",
					"aliases": [
						"weixin",
						"wechat",
						"微信"
					],
					"order": 75
				},
				"channelConfigs": { "openclaw-weixin": {
					"label": "Weixin",
					"description": "Personal WeChat conversation channel.",
					"schema": {
						"type": "object",
						"additionalProperties": true
					}
				} },
				"install": {
					"npmSpec": "@tencent-weixin/openclaw-weixin@2.4.3",
					"defaultChoice": "npm",
					"expectedIntegrity": "sha512-dPQbidUNWigC6V10vGW4i+GLH09x+6zUhafZRjuxkJ9GDu8o62WBsnUTojp4KqUH756hz+t2v9khiCRSi0dBDw==",
					"minHostVersion": ">=2026.3.22"
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
			"name": "@openclaw/matrix",
			"description": "OpenClaw Matrix channel plugin",
			"source": "official",
			"kind": "channel",
			"openclaw": {
				"channel": {
					"id": "matrix",
					"label": "Matrix",
					"selectionLabel": "Matrix (plugin)",
					"docsPath": "/channels/matrix",
					"docsLabel": "matrix",
					"blurb": "open protocol; install the plugin to enable.",
					"order": 70,
					"quickstartAllowFrom": true,
					"doctorCapabilities": {
						"dmAllowFromMode": "nestedOnly",
						"groupModel": "sender",
						"groupAllowFromFallbackToAllowFrom": false,
						"warnOnEmptyGroupSenderAllowlist": true
					},
					"cliAddOptions": [
						{
							"flags": "--homeserver <url>",
							"description": "Matrix homeserver URL"
						},
						{
							"flags": "--user-id <id>",
							"description": "Matrix user ID"
						},
						{
							"flags": "--access-token <token>",
							"description": "Matrix access token"
						},
						{
							"flags": "--device-name <name>",
							"description": "Matrix device name"
						},
						{
							"flags": "--initial-sync-limit <n>",
							"description": "Matrix initial sync limit"
						}
					]
				},
				"install": {
					"clawhubSpec": "clawhub:@openclaw/matrix",
					"npmSpec": "@openclaw/matrix",
					"defaultChoice": "clawhub",
					"minHostVersion": ">=2026.4.10",
					"allowInvalidConfigRecovery": true
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
			"name": "@openclaw/slack",
			"description": "OpenClaw Slack channel plugin",
			"source": "official",
			"kind": "channel",
			"openclaw": {
				"channel": {
					"id": "slack",
					"label": "Slack",
					"selectionLabel": "Slack (Socket Mode)",
					"detailLabel": "Slack Bot",
					"docsPath": "/channels/slack",
					"docsLabel": "slack",
					"blurb": "supported (Socket Mode).",
					"systemImage": "number",
					"markdownCapable": true
				},
				"install": {
					"npmSpec": "@openclaw/slack",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.5.12-beta.1",
					"allowInvalidConfigRecovery": true
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
					"clawhubSpec": "clawhub:@openclaw/whatsapp",
					"npmSpec": "@openclaw/whatsapp",
					"defaultChoice": "clawhub",
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
	{ entries: [
		{
			"name": "@openclaw/amazon-bedrock-provider",
			"description": "OpenClaw Amazon Bedrock provider plugin",
			"source": "official",
			"kind": "provider",
			"openclaw": {
				"plugin": {
					"id": "amazon-bedrock",
					"label": "Amazon Bedrock"
				},
				"providers": [{
					"id": "amazon-bedrock",
					"name": "Amazon Bedrock",
					"docs": "/providers/bedrock",
					"categories": ["cloud", "llm"]
				}],
				"install": {
					"npmSpec": "@openclaw/amazon-bedrock-provider",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.5.12-beta.1"
				}
			}
		},
		{
			"name": "@openclaw/amazon-bedrock-mantle-provider",
			"description": "OpenClaw Amazon Bedrock Mantle provider plugin",
			"source": "official",
			"kind": "provider",
			"openclaw": {
				"plugin": {
					"id": "amazon-bedrock-mantle",
					"label": "Amazon Bedrock Mantle"
				},
				"providers": [{
					"id": "amazon-bedrock-mantle",
					"name": "Amazon Bedrock Mantle",
					"docs": "/providers/bedrock-mantle",
					"categories": ["cloud", "llm"]
				}],
				"install": {
					"npmSpec": "@openclaw/amazon-bedrock-mantle-provider",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.5.12-beta.1"
				}
			}
		},
		{
			"name": "@openclaw/anthropic-vertex-provider",
			"description": "OpenClaw Anthropic Vertex provider plugin",
			"source": "official",
			"kind": "provider",
			"openclaw": {
				"plugin": {
					"id": "anthropic-vertex",
					"label": "Anthropic Vertex"
				},
				"providers": [{
					"id": "anthropic-vertex",
					"name": "Anthropic Vertex",
					"docs": "/providers/models",
					"categories": ["cloud", "llm"]
				}],
				"install": {
					"npmSpec": "@openclaw/anthropic-vertex-provider",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.5.12-beta.1"
				}
			}
		},
		{
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
		}
	] },
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
					"minHostVersion": ">=2026.4.10",
					"allowInvalidConfigRecovery": true
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
			"name": "@openclaw/openshell-sandbox",
			"description": "OpenClaw OpenShell sandbox backend",
			"source": "official",
			"kind": "plugin",
			"openclaw": {
				"plugin": {
					"id": "openshell",
					"label": "OpenShell Sandbox"
				},
				"install": {
					"npmSpec": "@openclaw/openshell-sandbox",
					"defaultChoice": "npm",
					"minHostVersion": ">=2026.5.12-beta.1"
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
