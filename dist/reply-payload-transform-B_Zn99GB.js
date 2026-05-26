import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { At as boolean, Et as array, Nn as record, Rn as string, Tn as object, Xn as union, wn as number, yt as _enum } from "./schemas-Del5uzR8.js";
import { R as requireOpenAllowFrom } from "./zod-schema.core-D7Y_eqdd.js";
import { r as buildChannelConfigSchema } from "./config-schema-ChfiQrSg.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./channel-config-schema-BBVXL5oD.js";
import { f as requireChannelOpenAllowFrom } from "./extension-shared-DSIp8QS_.js";
import { n as createEventCard, t as createAgendaCard } from "./schedule-cards-Bq74H30B.js";
//#region extensions/line/src/config-schema.ts
const DmPolicySchema = _enum([
	"open",
	"allowlist",
	"pairing",
	"disabled"
]);
const GroupPolicySchema = _enum([
	"open",
	"allowlist",
	"disabled"
]);
const ThreadBindingsSchema = object({
	enabled: boolean().optional(),
	idleHours: number().optional(),
	maxAgeHours: number().optional(),
	spawnSessions: boolean().optional(),
	defaultSpawnContext: _enum(["isolated", "fork"]).optional(),
	spawnSubagentSessions: boolean().optional(),
	spawnAcpSessions: boolean().optional()
}).strict();
const LineCommonConfigSchemaBase = object({
	enabled: boolean().optional(),
	channelAccessToken: string().optional(),
	channelSecret: string().optional(),
	tokenFile: string().optional(),
	secretFile: string().optional(),
	name: string().optional(),
	allowFrom: array(union([string(), number()])).optional(),
	groupAllowFrom: array(union([string(), number()])).optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	responsePrefix: string().optional(),
	mediaMaxMb: number().optional(),
	webhookPath: string().optional(),
	threadBindings: ThreadBindingsSchema.optional()
});
const LineGroupConfigSchema = object({
	enabled: boolean().optional(),
	allowFrom: array(union([string(), number()])).optional(),
	requireMention: boolean().optional(),
	systemPrompt: string().optional(),
	skills: array(string()).optional()
}).strict();
const LineAccountConfigSchema = LineCommonConfigSchemaBase.extend({ groups: record(string(), LineGroupConfigSchema.optional()).optional() }).strict().superRefine((value, ctx) => {
	requireChannelOpenAllowFrom({
		channel: "line",
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		requireOpenAllowFrom
	});
});
const LineConfigSchema = LineCommonConfigSchemaBase.extend({
	accounts: record(string(), LineAccountConfigSchema.optional()).optional(),
	defaultAccount: string().optional(),
	groups: record(string(), LineGroupConfigSchema.optional()).optional()
}).strict().superRefine((value, ctx) => {
	requireChannelOpenAllowFrom({
		channel: "line",
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		requireOpenAllowFrom
	});
});
const LineChannelConfigSchema = buildChannelConfigSchema(LineConfigSchema);
//#endregion
//#region extensions/line/src/flex-templates/media-control-cards.ts
/**
* Create a media player card for Sonos, Spotify, Apple Music, etc.
*
* Editorial design: Album art hero with gradient overlay for text,
* prominent now-playing indicator, refined playback controls.
*/
function createMediaPlayerCard(params) {
	const { title, subtitle, source, imageUrl, isPlaying, progress, controls, extraActions } = params;
	const trackInfo = [{
		type: "text",
		text: title,
		weight: "bold",
		size: "xl",
		color: "#111111",
		wrap: true
	}];
	if (subtitle) trackInfo.push({
		type: "text",
		text: subtitle,
		size: "md",
		color: "#666666",
		wrap: true,
		margin: "sm"
	});
	const statusItems = [];
	if (isPlaying !== void 0) statusItems.push({
		type: "box",
		layout: "horizontal",
		contents: [{
			type: "box",
			layout: "vertical",
			contents: [],
			width: "8px",
			height: "8px",
			backgroundColor: isPlaying ? "#06C755" : "#CCCCCC",
			cornerRadius: "4px"
		}, {
			type: "text",
			text: isPlaying ? "Now Playing" : "Paused",
			size: "xs",
			color: isPlaying ? "#06C755" : "#888888",
			weight: "bold",
			margin: "sm"
		}],
		alignItems: "center"
	});
	if (source) statusItems.push({
		type: "text",
		text: source,
		size: "xs",
		color: "#AAAAAA",
		margin: statusItems.length > 0 ? "lg" : void 0
	});
	if (progress) statusItems.push({
		type: "text",
		text: progress,
		size: "xs",
		color: "#888888",
		align: "end",
		flex: 1
	});
	const bodyContents = [{
		type: "box",
		layout: "vertical",
		contents: trackInfo
	}];
	if (statusItems.length > 0) bodyContents.push({
		type: "box",
		layout: "horizontal",
		contents: statusItems,
		margin: "lg",
		alignItems: "center"
	});
	const bubble = {
		type: "bubble",
		size: "mega",
		body: {
			type: "box",
			layout: "vertical",
			contents: bodyContents,
			paddingAll: "xl",
			backgroundColor: "#FFFFFF"
		}
	};
	if (imageUrl) bubble.hero = {
		type: "image",
		url: imageUrl,
		size: "full",
		aspectRatio: "1:1",
		aspectMode: "cover"
	};
	if (controls || extraActions?.length) {
		const footerContents = [];
		if (controls) {
			const controlButtons = [];
			if (controls.previous) controlButtons.push({
				type: "button",
				action: {
					type: "postback",
					label: "⏮",
					data: controls.previous.data
				},
				style: "secondary",
				flex: 1,
				height: "sm"
			});
			if (controls.play) controlButtons.push({
				type: "button",
				action: {
					type: "postback",
					label: "▶",
					data: controls.play.data
				},
				style: isPlaying ? "secondary" : "primary",
				flex: 1,
				height: "sm",
				margin: controls.previous ? "md" : void 0
			});
			if (controls.pause) controlButtons.push({
				type: "button",
				action: {
					type: "postback",
					label: "⏸",
					data: controls.pause.data
				},
				style: isPlaying ? "primary" : "secondary",
				flex: 1,
				height: "sm",
				margin: controlButtons.length > 0 ? "md" : void 0
			});
			if (controls.next) controlButtons.push({
				type: "button",
				action: {
					type: "postback",
					label: "⏭",
					data: controls.next.data
				},
				style: "secondary",
				flex: 1,
				height: "sm",
				margin: controlButtons.length > 0 ? "md" : void 0
			});
			if (controlButtons.length > 0) footerContents.push({
				type: "box",
				layout: "horizontal",
				contents: controlButtons
			});
		}
		if (extraActions?.length) footerContents.push({
			type: "box",
			layout: "horizontal",
			contents: extraActions.slice(0, 2).map((action, index) => ({
				type: "button",
				action: {
					type: "postback",
					label: action.label.slice(0, 15),
					data: action.data
				},
				style: "secondary",
				flex: 1,
				height: "sm",
				margin: index > 0 ? "md" : void 0
			})),
			margin: "md"
		});
		if (footerContents.length > 0) bubble.footer = {
			type: "box",
			layout: "vertical",
			contents: footerContents,
			paddingAll: "lg",
			backgroundColor: "#FAFAFA"
		};
	}
	return bubble;
}
/**
* Create an Apple TV remote card with a D-pad and control rows.
*/
function createAppleTvRemoteCard(params) {
	const { deviceName, status, actionData } = params;
	const headerContents = [{
		type: "text",
		text: deviceName,
		weight: "bold",
		size: "xl",
		color: "#111111",
		wrap: true
	}];
	if (status) headerContents.push({
		type: "text",
		text: status,
		size: "sm",
		color: "#666666",
		wrap: true,
		margin: "sm"
	});
	const makeButton = (label, data, style = "secondary") => ({
		type: "button",
		action: {
			type: "postback",
			label,
			data
		},
		style,
		height: "sm",
		flex: 1
	});
	const dpadRows = [
		{
			type: "box",
			layout: "horizontal",
			contents: [
				{ type: "filler" },
				makeButton("↑", actionData.up),
				{ type: "filler" }
			]
		},
		{
			type: "box",
			layout: "horizontal",
			contents: [
				makeButton("←", actionData.left),
				makeButton("OK", actionData.select, "primary"),
				makeButton("→", actionData.right)
			],
			margin: "md"
		},
		{
			type: "box",
			layout: "horizontal",
			contents: [
				{ type: "filler" },
				makeButton("↓", actionData.down),
				{ type: "filler" }
			],
			margin: "md"
		}
	];
	const menuRow = {
		type: "box",
		layout: "horizontal",
		contents: [makeButton("Menu", actionData.menu), makeButton("Home", actionData.home)],
		margin: "lg"
	};
	const playbackRow = {
		type: "box",
		layout: "horizontal",
		contents: [makeButton("Play", actionData.play), makeButton("Pause", actionData.pause)],
		margin: "md"
	};
	const volumeRow = {
		type: "box",
		layout: "horizontal",
		contents: [
			makeButton("Vol +", actionData.volumeUp),
			makeButton("Mute", actionData.mute),
			makeButton("Vol -", actionData.volumeDown)
		],
		margin: "md"
	};
	return {
		type: "bubble",
		size: "mega",
		body: {
			type: "box",
			layout: "vertical",
			contents: [
				{
					type: "box",
					layout: "vertical",
					contents: headerContents
				},
				{
					type: "separator",
					margin: "lg",
					color: "#EEEEEE"
				},
				...dpadRows,
				menuRow,
				playbackRow,
				volumeRow
			],
			paddingAll: "xl",
			backgroundColor: "#FFFFFF"
		}
	};
}
/**
* Create a device control card for Apple TV, smart home devices, etc.
*
* Editorial design: Device-focused header with status indicator,
* clean control grid with clear visual hierarchy.
*/
function createDeviceControlCard(params) {
	const { deviceName, deviceType, status, isOnline, imageUrl, controls } = params;
	const headerContents = [{
		type: "box",
		layout: "horizontal",
		contents: [{
			type: "box",
			layout: "vertical",
			contents: [],
			width: "10px",
			height: "10px",
			backgroundColor: isOnline !== false ? "#06C755" : "#FF5555",
			cornerRadius: "5px"
		}, {
			type: "text",
			text: deviceName,
			weight: "bold",
			size: "xl",
			color: "#111111",
			wrap: true,
			flex: 1,
			margin: "md"
		}],
		alignItems: "center"
	}];
	if (deviceType) headerContents.push({
		type: "text",
		text: deviceType,
		size: "sm",
		color: "#888888",
		margin: "sm"
	});
	if (status) headerContents.push({
		type: "box",
		layout: "vertical",
		contents: [{
			type: "text",
			text: status,
			size: "sm",
			color: "#444444",
			wrap: true
		}],
		margin: "lg",
		paddingAll: "md",
		backgroundColor: "#F8F9FA",
		cornerRadius: "md"
	});
	const bubble = {
		type: "bubble",
		size: "mega",
		body: {
			type: "box",
			layout: "vertical",
			contents: headerContents,
			paddingAll: "xl",
			backgroundColor: "#FFFFFF"
		}
	};
	if (imageUrl) bubble.hero = {
		type: "image",
		url: imageUrl,
		size: "full",
		aspectRatio: "16:9",
		aspectMode: "cover"
	};
	if (controls.length > 0) {
		const rows = [];
		const limitedControls = controls.slice(0, 6);
		for (let i = 0; i < limitedControls.length; i += 2) {
			const rowButtons = [];
			for (let j = i; j < Math.min(i + 2, limitedControls.length); j++) {
				const ctrl = limitedControls[j];
				const buttonLabel = ctrl.icon ? `${ctrl.icon} ${ctrl.label}` : ctrl.label;
				rowButtons.push({
					type: "button",
					action: {
						type: "postback",
						label: buttonLabel.slice(0, 18),
						data: ctrl.data
					},
					style: ctrl.style ?? "secondary",
					flex: 1,
					height: "sm",
					margin: j > i ? "md" : void 0
				});
			}
			if (rowButtons.length === 1) rowButtons.push({ type: "filler" });
			rows.push({
				type: "box",
				layout: "horizontal",
				contents: rowButtons,
				margin: i > 0 ? "md" : void 0
			});
		}
		bubble.footer = {
			type: "box",
			layout: "vertical",
			contents: rows,
			paddingAll: "lg",
			backgroundColor: "#FAFAFA"
		};
	}
	return bubble;
}
//#endregion
//#region extensions/line/src/reply-payload-transform.ts
/**
* Parse LINE-specific directives from text and extract them into ReplyPayload fields.
*
* Supported directives:
* - [[quick_replies: option1, option2, option3]]
* - [[location: title | address | latitude | longitude]]
* - [[confirm: question | yes_label | no_label]]
* - [[buttons: title | text | btn1:data1, btn2:data2]]
* - [[media_player: title | artist | source | imageUrl | playing/paused]]
* - [[event: title | date | time | location | description]]
* - [[agenda: title | event1_title:event1_time, event2_title:event2_time, ...]]
* - [[device: name | type | status | ctrl1:data1, ctrl2:data2]]
* - [[appletv_remote: name | status]]
*/
function parseLineDirectives(payload) {
	let text = payload.text;
	if (!text) return payload;
	const result = { ...payload };
	const lineData = { ...result.channelData?.line };
	const toSlug = (value) => normalizeLowercaseStringOrEmpty(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "device";
	const lineActionData = (action, extras) => {
		const base = [`line.action=${encodeURIComponent(action)}`];
		if (extras) for (const [key, value] of Object.entries(extras)) base.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
		return base.join("&");
	};
	const quickRepliesMatch = text.match(/\[\[quick_replies:\s*([^\]]+)\]\]/i);
	if (quickRepliesMatch) {
		const options = quickRepliesMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
		if (options.length > 0) lineData.quickReplies = [...lineData.quickReplies || [], ...options];
		text = text.replace(quickRepliesMatch[0], "").trim();
	}
	const locationMatch = text.match(/\[\[location:\s*([^\]]+)\]\]/i);
	if (locationMatch && !lineData.location) {
		const parts = locationMatch[1].split("|").map((s) => s.trim());
		if (parts.length >= 4) {
			const [title, address, latStr, lonStr] = parts;
			const latitude = Number.parseFloat(latStr);
			const longitude = Number.parseFloat(lonStr);
			if (!Number.isNaN(latitude) && !Number.isNaN(longitude)) lineData.location = {
				title: title || "Location",
				address: address || "",
				latitude,
				longitude
			};
		}
		text = text.replace(locationMatch[0], "").trim();
	}
	const confirmMatch = text.match(/\[\[confirm:\s*([^\]]+)\]\]/i);
	if (confirmMatch && !lineData.templateMessage) {
		const parts = confirmMatch[1].split("|").map((s) => s.trim());
		if (parts.length >= 3) {
			const [question, yesPart, noPart] = parts;
			const [yesLabel, yesData] = yesPart.includes(":") ? yesPart.split(":").map((s) => s.trim()) : [yesPart, normalizeLowercaseStringOrEmpty(yesPart)];
			const [noLabel, noData] = noPart.includes(":") ? noPart.split(":").map((s) => s.trim()) : [noPart, normalizeLowercaseStringOrEmpty(noPart)];
			lineData.templateMessage = {
				type: "confirm",
				text: question,
				confirmLabel: yesLabel,
				confirmData: yesData,
				cancelLabel: noLabel,
				cancelData: noData,
				altText: question
			};
		}
		text = text.replace(confirmMatch[0], "").trim();
	}
	const buttonsMatch = text.match(/\[\[buttons:\s*([^\]]+)\]\]/i);
	if (buttonsMatch && !lineData.templateMessage) {
		const parts = buttonsMatch[1].split("|").map((s) => s.trim());
		if (parts.length >= 3) {
			const [title, bodyText, actionsStr] = parts;
			const actions = actionsStr.split(",").map((actionStr) => {
				const trimmed = actionStr.trim();
				const colonIndex = (() => {
					const index = trimmed.indexOf(":");
					if (index === -1) return -1;
					const lower = normalizeLowercaseStringOrEmpty(trimmed);
					if (lower.startsWith("http://") || lower.startsWith("https://")) return -1;
					return index;
				})();
				let label;
				let data;
				if (colonIndex === -1) {
					label = trimmed;
					data = trimmed;
				} else {
					label = trimmed.slice(0, colonIndex).trim();
					data = trimmed.slice(colonIndex + 1).trim();
				}
				if (data.startsWith("http://") || data.startsWith("https://")) return {
					type: "uri",
					label,
					uri: data
				};
				if (data.includes("=")) return {
					type: "postback",
					label,
					data
				};
				return {
					type: "message",
					label,
					data: data || label
				};
			});
			if (actions.length > 0) lineData.templateMessage = {
				type: "buttons",
				title,
				text: bodyText,
				actions: actions.slice(0, 4),
				altText: `${title}: ${bodyText}`
			};
		}
		text = text.replace(buttonsMatch[0], "").trim();
	}
	const mediaPlayerMatch = text.match(/\[\[media_player:\s*([^\]]+)\]\]/i);
	if (mediaPlayerMatch && !lineData.flexMessage) {
		const parts = mediaPlayerMatch[1].split("|").map((s) => s.trim());
		if (parts.length >= 1) {
			const [title, artist, source, imageUrl, statusStr] = parts;
			const isPlaying = normalizeLowercaseStringOrEmpty(statusStr) === "playing";
			const validImageUrl = imageUrl?.startsWith("https://") ? imageUrl : void 0;
			const deviceKey = toSlug(source || title || "media");
			const card = createMediaPlayerCard({
				title: title || "Unknown Track",
				subtitle: artist || void 0,
				source: source || void 0,
				imageUrl: validImageUrl,
				isPlaying: statusStr ? isPlaying : void 0,
				controls: {
					previous: { data: lineActionData("previous", { "line.device": deviceKey }) },
					play: { data: lineActionData("play", { "line.device": deviceKey }) },
					pause: { data: lineActionData("pause", { "line.device": deviceKey }) },
					next: { data: lineActionData("next", { "line.device": deviceKey }) }
				}
			});
			lineData.flexMessage = {
				altText: `🎵 ${title}${artist ? ` - ${artist}` : ""}`,
				contents: card
			};
		}
		text = text.replace(mediaPlayerMatch[0], "").trim();
	}
	const eventMatch = text.match(/\[\[event:\s*([^\]]+)\]\]/i);
	if (eventMatch && !lineData.flexMessage) {
		const parts = eventMatch[1].split("|").map((s) => s.trim());
		if (parts.length >= 2) {
			const [title, date, time, location, description] = parts;
			const card = createEventCard({
				title: title || "Event",
				date: date || "TBD",
				time: time || void 0,
				location: location || void 0,
				description: description || void 0
			});
			lineData.flexMessage = {
				altText: `📅 ${title} - ${date}${time ? ` ${time}` : ""}`,
				contents: card
			};
		}
		text = text.replace(eventMatch[0], "").trim();
	}
	const appleTvMatch = text.match(/\[\[appletv_remote:\s*([^\]]+)\]\]/i);
	if (appleTvMatch && !lineData.flexMessage) {
		const parts = appleTvMatch[1].split("|").map((s) => s.trim());
		if (parts.length >= 1) {
			const [deviceName, status] = parts;
			const deviceKey = toSlug(deviceName || "apple_tv");
			const card = createAppleTvRemoteCard({
				deviceName: deviceName || "Apple TV",
				status: status || void 0,
				actionData: {
					up: lineActionData("up", { "line.device": deviceKey }),
					down: lineActionData("down", { "line.device": deviceKey }),
					left: lineActionData("left", { "line.device": deviceKey }),
					right: lineActionData("right", { "line.device": deviceKey }),
					select: lineActionData("select", { "line.device": deviceKey }),
					menu: lineActionData("menu", { "line.device": deviceKey }),
					home: lineActionData("home", { "line.device": deviceKey }),
					play: lineActionData("play", { "line.device": deviceKey }),
					pause: lineActionData("pause", { "line.device": deviceKey }),
					volumeUp: lineActionData("volume_up", { "line.device": deviceKey }),
					volumeDown: lineActionData("volume_down", { "line.device": deviceKey }),
					mute: lineActionData("mute", { "line.device": deviceKey })
				}
			});
			lineData.flexMessage = {
				altText: `📺 ${deviceName || "Apple TV"} Remote`,
				contents: card
			};
		}
		text = text.replace(appleTvMatch[0], "").trim();
	}
	const agendaMatch = text.match(/\[\[agenda:\s*([^\]]+)\]\]/i);
	if (agendaMatch && !lineData.flexMessage) {
		const parts = agendaMatch[1].split("|").map((s) => s.trim());
		if (parts.length >= 2) {
			const [title, eventsStr] = parts;
			const events = eventsStr.split(",").map((eventStr) => {
				const trimmed = eventStr.trim();
				const colonIdx = trimmed.lastIndexOf(":");
				if (colonIdx > 0) return {
					title: trimmed.slice(0, colonIdx).trim(),
					time: trimmed.slice(colonIdx + 1).trim()
				};
				return { title: trimmed };
			});
			const card = createAgendaCard({
				title: title || "Agenda",
				events
			});
			lineData.flexMessage = {
				altText: `📋 ${title} (${events.length} events)`,
				contents: card
			};
		}
		text = text.replace(agendaMatch[0], "").trim();
	}
	const deviceMatch = text.match(/\[\[device:\s*([^\]]+)\]\]/i);
	if (deviceMatch && !lineData.flexMessage) {
		const parts = deviceMatch[1].split("|").map((s) => s.trim());
		if (parts.length >= 1) {
			const [deviceName, deviceType, status, controlsStr] = parts;
			const deviceKey = toSlug(deviceName || "device");
			const controls = controlsStr ? controlsStr.split(",").map((ctrlStr) => {
				const [label, data] = ctrlStr.split(":").map((s) => s.trim());
				return {
					label,
					data: lineActionData(data || normalizeLowercaseStringOrEmpty(label).replace(/\s+/g, "_"), { "line.device": deviceKey })
				};
			}) : [];
			const card = createDeviceControlCard({
				deviceName: deviceName || "Device",
				deviceType: deviceType || void 0,
				status: status || void 0,
				controls
			});
			lineData.flexMessage = {
				altText: `📱 ${deviceName}${status ? `: ${status}` : ""}`,
				contents: card
			};
		}
		text = text.replace(deviceMatch[0], "").trim();
	}
	text = text.replace(/\n{3,}/g, "\n\n").trim();
	result.text = text || void 0;
	if (Object.keys(lineData).length > 0) result.channelData = {
		...result.channelData,
		line: lineData
	};
	return result;
}
function hasLineDirectives(text) {
	return /\[\[(quick_replies|location|confirm|buttons|media_player|event|agenda|device|appletv_remote):/i.test(text);
}
//#endregion
export { createMediaPlayerCard as a, createDeviceControlCard as i, parseLineDirectives as n, LineChannelConfigSchema as o, createAppleTvRemoteCard as r, LineConfigSchema as s, hasLineDirectives as t };
