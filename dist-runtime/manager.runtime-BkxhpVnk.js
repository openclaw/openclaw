import { R as init_tmp_openclaw_dir, g as init_globals, n as init_subsystem, t as createSubsystemLogger, v as logVerbose, x as shouldLogVerbose, z as resolvePreferredOpenClawTmpDir } from "./subsystem-CMvFcqxZ.js";
import { bt as resolveAgentDir } from "./query-expansion-BRXofpTG.js";
import "./workspace-BPUYxH8-.js";
import "./logger-C5Xia9ob.js";
import { Bn as parseTtsDirectives, Ls as formatMention, Qu as formatErrorMessage, Rn as resolveTtsConfig, Zf as init_allow_list, ap as resolveDiscordOwnerAccess, co as createMediaAttachmentCache, do as runCapability, dp as formatDiscordUserTag, eo as resolveAgentRoute, fp as init_format, lo as normalizeMediaAttachments, so as buildProviderRegistry, zn as textToSpeech } from "./model-selection-DTQXVq3-.js";
import "./frontmatter-D0JIibvS.js";
import "./fetch-3gMSdRzB.js";
import "./boolean-Cuaw_-7j.js";
import { n as agentCommandFromIngress } from "./agent-BwzJEJ2b.js";
import { t as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-DCmYInXT.js";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ChannelType, ReadyListener } from "@buape/carbon";
import { AudioPlayerStatus, EndBehaviorType, VoiceConnectionStatus, createAudioPlayer, createAudioResource, entersState, joinVoiceChannel } from "@discordjs/voice";
//#region extensions/discord/src/voice/manager.ts
init_globals();
init_tmp_openclaw_dir();
init_subsystem();
init_allow_list();
init_format();
const require = createRequire(import.meta.url);
const SAMPLE_RATE = 48e3;
const CHANNELS = 2;
const BIT_DEPTH = 16;
const MIN_SEGMENT_SECONDS = .35;
const SILENCE_DURATION_MS = 1e3;
const PLAYBACK_READY_TIMEOUT_MS = 15e3;
const SPEAKING_READY_TIMEOUT_MS = 6e4;
const DECRYPT_FAILURE_WINDOW_MS = 3e4;
const DECRYPT_FAILURE_RECONNECT_THRESHOLD = 3;
const DECRYPT_FAILURE_PATTERN = /DecryptionFailed\(/;
const SPEAKER_CONTEXT_CACHE_TTL_MS = 6e4;
const logger = createSubsystemLogger("discord/voice");
const logVoiceVerbose = (message) => {
	logVerbose(`discord voice: ${message}`);
};
function mergeTtsConfig(base, override) {
	if (!override) return base;
	return {
		...base,
		...override,
		modelOverrides: {
			...base.modelOverrides,
			...override.modelOverrides
		},
		elevenlabs: {
			...base.elevenlabs,
			...override.elevenlabs,
			voiceSettings: {
				...base.elevenlabs?.voiceSettings,
				...override.elevenlabs?.voiceSettings
			}
		},
		openai: {
			...base.openai,
			...override.openai
		},
		edge: {
			...base.edge,
			...override.edge
		}
	};
}
function resolveVoiceTtsConfig(params) {
	if (!params.override) return {
		cfg: params.cfg,
		resolved: resolveTtsConfig(params.cfg)
	};
	const merged = mergeTtsConfig(params.cfg.messages?.tts ?? {}, params.override);
	const messages = params.cfg.messages ?? {};
	const cfg = {
		...params.cfg,
		messages: {
			...messages,
			tts: merged
		}
	};
	return {
		cfg,
		resolved: resolveTtsConfig(cfg)
	};
}
function buildWavBuffer(pcm) {
	const blockAlign = CHANNELS * BIT_DEPTH / 8;
	const byteRate = SAMPLE_RATE * blockAlign;
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(CHANNELS, 22);
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(BIT_DEPTH, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}
let warnedOpusMissing = false;
function createOpusDecoder() {
	try {
		const OpusScript = require("opusscript");
		return {
			decoder: new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO),
			name: "opusscript"
		};
	} catch (err) {
		if (!warnedOpusMissing) {
			warnedOpusMissing = true;
			logger.warn(`discord voice: opusscript unavailable (${formatErrorMessage(err)}); cannot decode voice audio`);
		}
	}
	return null;
}
async function decodeOpusStream(stream) {
	const selected = createOpusDecoder();
	if (!selected) return Buffer.alloc(0);
	logVoiceVerbose(`opus decoder: ${selected.name}`);
	const chunks = [];
	try {
		for await (const chunk of stream) {
			if (!chunk || !(chunk instanceof Buffer) || chunk.length === 0) continue;
			const decoded = selected.decoder.decode(chunk);
			if (decoded && decoded.length > 0) chunks.push(Buffer.from(decoded));
		}
	} catch (err) {
		if (shouldLogVerbose()) logVerbose(`discord voice: opus decode failed: ${formatErrorMessage(err)}`);
	}
	return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
}
function estimateDurationSeconds(pcm) {
	const bytesPerSample = BIT_DEPTH / 8 * CHANNELS;
	if (bytesPerSample <= 0) return 0;
	return pcm.length / (bytesPerSample * SAMPLE_RATE);
}
async function writeWavFile(pcm) {
	const tempDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "discord-voice-"));
	const filePath = path.join(tempDir, `segment-${randomUUID()}.wav`);
	const wav = buildWavBuffer(pcm);
	await fs.writeFile(filePath, wav);
	scheduleTempCleanup(tempDir);
	return {
		path: filePath,
		durationSeconds: estimateDurationSeconds(pcm)
	};
}
function scheduleTempCleanup(tempDir, delayMs = 1800 * 1e3) {
	setTimeout(() => {
		fs.rm(tempDir, {
			recursive: true,
			force: true
		}).catch((err) => {
			if (shouldLogVerbose()) logVerbose(`discord voice: temp cleanup failed for ${tempDir}: ${formatErrorMessage(err)}`);
		});
	}, delayMs).unref();
}
async function transcribeAudio(params) {
	const ctx = {
		MediaPath: params.filePath,
		MediaType: "audio/wav"
	};
	const attachments = normalizeMediaAttachments(ctx);
	if (attachments.length === 0) return;
	const cache = createMediaAttachmentCache(attachments);
	const providerRegistry = buildProviderRegistry();
	try {
		return (await runCapability({
			capability: "audio",
			cfg: params.cfg,
			ctx,
			attachments: cache,
			media: attachments,
			agentDir: resolveAgentDir(params.cfg, params.agentId),
			providerRegistry,
			config: params.cfg.tools?.media?.audio
		})).outputs.find((entry) => entry.kind === "audio.transcription")?.text?.trim() || void 0;
	} finally {
		await cache.cleanup();
	}
}
var DiscordVoiceManager = class {
	constructor(params) {
		this.params = params;
		this.sessions = /* @__PURE__ */ new Map();
		this.autoJoinTask = null;
		this.speakerContextCache = /* @__PURE__ */ new Map();
		this.botUserId = params.botUserId;
		this.voiceEnabled = params.discordConfig.voice?.enabled !== false;
		this.ownerAllowFrom = params.discordConfig.allowFrom ?? params.discordConfig.dm?.allowFrom ?? [];
		this.allowDangerousNameMatching = isDangerousNameMatchingEnabled(params.discordConfig);
	}
	setBotUserId(id) {
		if (id) this.botUserId = id;
	}
	isEnabled() {
		return this.voiceEnabled;
	}
	async autoJoin() {
		if (!this.voiceEnabled) return;
		if (this.autoJoinTask) return this.autoJoinTask;
		this.autoJoinTask = (async () => {
			const entries = this.params.discordConfig.voice?.autoJoin ?? [];
			logVoiceVerbose(`autoJoin: ${entries.length} entries`);
			const seenGuilds = /* @__PURE__ */ new Set();
			for (const entry of entries) {
				const guildId = entry.guildId.trim();
				if (!guildId) continue;
				if (seenGuilds.has(guildId)) {
					logger.warn(`discord voice: autoJoin has multiple entries for guild ${guildId}; skipping`);
					continue;
				}
				seenGuilds.add(guildId);
				logVoiceVerbose(`autoJoin: joining guild ${guildId} channel ${entry.channelId}`);
				await this.join({
					guildId: entry.guildId,
					channelId: entry.channelId
				});
			}
		})().finally(() => {
			this.autoJoinTask = null;
		});
		return this.autoJoinTask;
	}
	status() {
		return Array.from(this.sessions.values()).map((session) => ({
			ok: true,
			message: `connected: guild ${session.guildId} channel ${session.channelId}`,
			guildId: session.guildId,
			channelId: session.channelId
		}));
	}
	async join(params) {
		if (!this.voiceEnabled) return {
			ok: false,
			message: "Discord voice is disabled (channels.discord.voice.enabled)."
		};
		const guildId = params.guildId.trim();
		const channelId = params.channelId.trim();
		if (!guildId || !channelId) return {
			ok: false,
			message: "Missing guildId or channelId."
		};
		logVoiceVerbose(`join requested: guild ${guildId} channel ${channelId}`);
		const existing = this.sessions.get(guildId);
		if (existing && existing.channelId === channelId) {
			logVoiceVerbose(`join: already connected to guild ${guildId} channel ${channelId}`);
			return {
				ok: true,
				message: `Already connected to ${formatMention({ channelId })}.`,
				guildId,
				channelId
			};
		}
		if (existing) {
			logVoiceVerbose(`join: replacing existing session for guild ${guildId}`);
			await this.leave({ guildId });
		}
		const channelInfo = await this.params.client.fetchChannel(channelId).catch(() => null);
		if (!channelInfo || "type" in channelInfo && !isVoiceChannel(channelInfo.type)) return {
			ok: false,
			message: `Channel ${channelId} is not a voice channel.`
		};
		const channelGuildId = "guildId" in channelInfo ? channelInfo.guildId : void 0;
		if (channelGuildId && channelGuildId !== guildId) return {
			ok: false,
			message: "Voice channel is not in this guild."
		};
		const voicePlugin = this.params.client.getPlugin("voice");
		if (!voicePlugin) return {
			ok: false,
			message: "Discord voice plugin is not available."
		};
		const adapterCreator = voicePlugin.getGatewayAdapterCreator(guildId);
		const daveEncryption = this.params.discordConfig.voice?.daveEncryption;
		const decryptionFailureTolerance = this.params.discordConfig.voice?.decryptionFailureTolerance;
		logVoiceVerbose(`join: DAVE settings encryption=${daveEncryption === false ? "off" : "on"} tolerance=${decryptionFailureTolerance ?? "default"}`);
		const connection = joinVoiceChannel({
			channelId,
			guildId,
			adapterCreator,
			selfDeaf: false,
			selfMute: false,
			daveEncryption,
			decryptionFailureTolerance
		});
		try {
			await entersState(connection, VoiceConnectionStatus.Ready, PLAYBACK_READY_TIMEOUT_MS);
			logVoiceVerbose(`join: connected to guild ${guildId} channel ${channelId}`);
		} catch (err) {
			connection.destroy();
			return {
				ok: false,
				message: `Failed to join voice channel: ${formatErrorMessage(err)}`
			};
		}
		const sessionChannelId = channelInfo?.id ?? channelId;
		if (sessionChannelId !== channelId) logVoiceVerbose(`join: using session channel ${sessionChannelId} for voice channel ${channelId}`);
		const route = resolveAgentRoute({
			cfg: this.params.cfg,
			channel: "discord",
			accountId: this.params.accountId,
			guildId,
			peer: {
				kind: "channel",
				id: sessionChannelId
			}
		});
		const player = createAudioPlayer();
		connection.subscribe(player);
		let speakingHandler;
		let disconnectedHandler;
		let destroyedHandler;
		let playerErrorHandler;
		const clearSessionIfCurrent = () => {
			if (this.sessions.get(guildId)?.connection === connection) this.sessions.delete(guildId);
		};
		const entry = {
			guildId,
			channelId,
			sessionChannelId,
			route,
			connection,
			player,
			playbackQueue: Promise.resolve(),
			processingQueue: Promise.resolve(),
			activeSpeakers: /* @__PURE__ */ new Set(),
			decryptFailureCount: 0,
			lastDecryptFailureAt: 0,
			decryptRecoveryInFlight: false,
			stop: () => {
				if (speakingHandler) connection.receiver.speaking.off("start", speakingHandler);
				if (disconnectedHandler) connection.off(VoiceConnectionStatus.Disconnected, disconnectedHandler);
				if (destroyedHandler) connection.off(VoiceConnectionStatus.Destroyed, destroyedHandler);
				if (playerErrorHandler) player.off("error", playerErrorHandler);
				player.stop();
				connection.destroy();
			}
		};
		speakingHandler = (userId) => {
			this.handleSpeakingStart(entry, userId).catch((err) => {
				logger.warn(`discord voice: capture failed: ${formatErrorMessage(err)}`);
			});
		};
		disconnectedHandler = async () => {
			try {
				await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5e3), entersState(connection, VoiceConnectionStatus.Connecting, 5e3)]);
			} catch {
				clearSessionIfCurrent();
				connection.destroy();
			}
		};
		destroyedHandler = () => {
			clearSessionIfCurrent();
		};
		playerErrorHandler = (err) => {
			logger.warn(`discord voice: playback error: ${formatErrorMessage(err)}`);
		};
		connection.receiver.speaking.on("start", speakingHandler);
		connection.on(VoiceConnectionStatus.Disconnected, disconnectedHandler);
		connection.on(VoiceConnectionStatus.Destroyed, destroyedHandler);
		player.on("error", playerErrorHandler);
		this.sessions.set(guildId, entry);
		return {
			ok: true,
			message: `Joined ${formatMention({ channelId })}.`,
			guildId,
			channelId
		};
	}
	async leave(params) {
		const guildId = params.guildId.trim();
		logVoiceVerbose(`leave requested: guild ${guildId} channel ${params.channelId ?? "current"}`);
		const entry = this.sessions.get(guildId);
		if (!entry) return {
			ok: false,
			message: "Not connected to a voice channel."
		};
		if (params.channelId && params.channelId !== entry.channelId) return {
			ok: false,
			message: "Not connected to that voice channel."
		};
		entry.stop();
		this.sessions.delete(guildId);
		logVoiceVerbose(`leave: disconnected from guild ${guildId} channel ${entry.channelId}`);
		return {
			ok: true,
			message: `Left ${formatMention({ channelId: entry.channelId })}.`,
			guildId,
			channelId: entry.channelId
		};
	}
	async destroy() {
		for (const entry of this.sessions.values()) entry.stop();
		this.sessions.clear();
	}
	enqueueProcessing(entry, task) {
		entry.processingQueue = entry.processingQueue.then(task).catch((err) => logger.warn(`discord voice: processing failed: ${formatErrorMessage(err)}`));
	}
	enqueuePlayback(entry, task) {
		entry.playbackQueue = entry.playbackQueue.then(task).catch((err) => logger.warn(`discord voice: playback failed: ${formatErrorMessage(err)}`));
	}
	async handleSpeakingStart(entry, userId) {
		if (!userId || entry.activeSpeakers.has(userId)) return;
		if (this.botUserId && userId === this.botUserId) return;
		entry.activeSpeakers.add(userId);
		logVoiceVerbose(`capture start: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
		if (entry.player.state.status === AudioPlayerStatus.Playing) entry.player.stop(true);
		const stream = entry.connection.receiver.subscribe(userId, { end: {
			behavior: EndBehaviorType.AfterSilence,
			duration: SILENCE_DURATION_MS
		} });
		stream.on("error", (err) => {
			this.handleReceiveError(entry, err);
		});
		try {
			const pcm = await decodeOpusStream(stream);
			if (pcm.length === 0) {
				logVoiceVerbose(`capture empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
				return;
			}
			this.resetDecryptFailureState(entry);
			const { path: wavPath, durationSeconds } = await writeWavFile(pcm);
			if (durationSeconds < MIN_SEGMENT_SECONDS) {
				logVoiceVerbose(`capture too short (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
				return;
			}
			logVoiceVerbose(`capture ready (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
			this.enqueueProcessing(entry, async () => {
				await this.processSegment({
					entry,
					wavPath,
					userId,
					durationSeconds
				});
			});
		} finally {
			entry.activeSpeakers.delete(userId);
		}
	}
	async processSegment(params) {
		const { entry, wavPath, userId, durationSeconds } = params;
		logVoiceVerbose(`segment processing (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId}`);
		const transcript = await transcribeAudio({
			cfg: this.params.cfg,
			agentId: entry.route.agentId,
			filePath: wavPath
		});
		if (!transcript) {
			logVoiceVerbose(`transcription empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
			return;
		}
		logVoiceVerbose(`transcription ok (${transcript.length} chars): guild ${entry.guildId} channel ${entry.channelId}`);
		const speaker = await this.resolveSpeakerContext(entry.guildId, userId);
		const replyText = ((await agentCommandFromIngress({
			message: speaker.label ? `${speaker.label}: ${transcript}` : transcript,
			sessionKey: entry.route.sessionKey,
			agentId: entry.route.agentId,
			messageChannel: "discord",
			senderIsOwner: speaker.senderIsOwner,
			deliver: false
		}, this.params.runtime)).payloads ?? []).map((payload) => payload.text).filter((text) => typeof text === "string" && text.trim()).join("\n").trim();
		if (!replyText) {
			logVoiceVerbose(`reply empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
			return;
		}
		logVoiceVerbose(`reply ok (${replyText.length} chars): guild ${entry.guildId} channel ${entry.channelId}`);
		const { cfg: ttsCfg, resolved: ttsConfig } = resolveVoiceTtsConfig({
			cfg: this.params.cfg,
			override: this.params.discordConfig.voice?.tts
		});
		const directive = parseTtsDirectives(replyText, ttsConfig.modelOverrides, ttsConfig.openai.baseUrl);
		const speakText = directive.overrides.ttsText ?? directive.cleanedText.trim();
		if (!speakText) {
			logVoiceVerbose(`tts skipped (empty): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
			return;
		}
		const ttsResult = await textToSpeech({
			text: speakText,
			cfg: ttsCfg,
			channel: "discord",
			overrides: directive.overrides
		});
		if (!ttsResult.success || !ttsResult.audioPath) {
			logger.warn(`discord voice: TTS failed: ${ttsResult.error ?? "unknown error"}`);
			return;
		}
		const audioPath = ttsResult.audioPath;
		logVoiceVerbose(`tts ok (${speakText.length} chars): guild ${entry.guildId} channel ${entry.channelId}`);
		this.enqueuePlayback(entry, async () => {
			logVoiceVerbose(`playback start: guild ${entry.guildId} channel ${entry.channelId} file ${path.basename(audioPath)}`);
			const resource = createAudioResource(audioPath);
			entry.player.play(resource);
			await entersState(entry.player, AudioPlayerStatus.Playing, PLAYBACK_READY_TIMEOUT_MS).catch(() => void 0);
			await entersState(entry.player, AudioPlayerStatus.Idle, SPEAKING_READY_TIMEOUT_MS).catch(() => void 0);
			logVoiceVerbose(`playback done: guild ${entry.guildId} channel ${entry.channelId}`);
		});
	}
	handleReceiveError(entry, err) {
		const message = formatErrorMessage(err);
		logger.warn(`discord voice: receive error: ${message}`);
		if (!DECRYPT_FAILURE_PATTERN.test(message)) return;
		const now = Date.now();
		if (now - entry.lastDecryptFailureAt > DECRYPT_FAILURE_WINDOW_MS) entry.decryptFailureCount = 0;
		entry.lastDecryptFailureAt = now;
		entry.decryptFailureCount += 1;
		if (entry.decryptFailureCount === 1) logger.warn("discord voice: DAVE decrypt failures detected; voice receive may be unstable (upstream: discordjs/discord.js#11419)");
		if (entry.decryptFailureCount < DECRYPT_FAILURE_RECONNECT_THRESHOLD || entry.decryptRecoveryInFlight) return;
		entry.decryptRecoveryInFlight = true;
		this.resetDecryptFailureState(entry);
		this.recoverFromDecryptFailures(entry).catch((recoverErr) => logger.warn(`discord voice: decrypt recovery failed: ${formatErrorMessage(recoverErr)}`)).finally(() => {
			entry.decryptRecoveryInFlight = false;
		});
	}
	resetDecryptFailureState(entry) {
		entry.decryptFailureCount = 0;
		entry.lastDecryptFailureAt = 0;
	}
	async recoverFromDecryptFailures(entry) {
		const active = this.sessions.get(entry.guildId);
		if (!active || active.connection !== entry.connection) return;
		logger.warn(`discord voice: repeated decrypt failures; attempting rejoin for guild ${entry.guildId} channel ${entry.channelId}`);
		const leaveResult = await this.leave({ guildId: entry.guildId });
		if (!leaveResult.ok) {
			logger.warn(`discord voice: decrypt recovery leave failed: ${leaveResult.message}`);
			return;
		}
		const result = await this.join({
			guildId: entry.guildId,
			channelId: entry.channelId
		});
		if (!result.ok) logger.warn(`discord voice: rejoin after decrypt failures failed: ${result.message}`);
	}
	resolveSpeakerIsOwner(params) {
		return resolveDiscordOwnerAccess({
			allowFrom: this.ownerAllowFrom,
			sender: {
				id: params.id,
				name: params.name,
				tag: params.tag
			},
			allowNameMatching: this.allowDangerousNameMatching
		}).ownerAllowed;
	}
	resolveSpeakerContextCacheKey(guildId, userId) {
		return `${guildId}:${userId}`;
	}
	getCachedSpeakerContext(guildId, userId) {
		const key = this.resolveSpeakerContextCacheKey(guildId, userId);
		const cached = this.speakerContextCache.get(key);
		if (!cached) return;
		if (cached.expiresAt <= Date.now()) {
			this.speakerContextCache.delete(key);
			return;
		}
		return {
			label: cached.label,
			senderIsOwner: cached.senderIsOwner
		};
	}
	setCachedSpeakerContext(guildId, userId, context) {
		const key = this.resolveSpeakerContextCacheKey(guildId, userId);
		this.speakerContextCache.set(key, {
			label: context.label,
			senderIsOwner: context.senderIsOwner,
			expiresAt: Date.now() + SPEAKER_CONTEXT_CACHE_TTL_MS
		});
	}
	async resolveSpeakerContext(guildId, userId) {
		const cached = this.getCachedSpeakerContext(guildId, userId);
		if (cached) return cached;
		const identity = await this.resolveSpeakerIdentity(guildId, userId);
		const context = {
			label: identity.label,
			senderIsOwner: this.resolveSpeakerIsOwner({
				id: identity.id,
				name: identity.name,
				tag: identity.tag
			})
		};
		this.setCachedSpeakerContext(guildId, userId, context);
		return context;
	}
	async resolveSpeakerIdentity(guildId, userId) {
		try {
			const member = await this.params.client.fetchMember(guildId, userId);
			const username = member.user?.username ?? void 0;
			return {
				id: userId,
				label: member.nickname ?? member.user?.globalName ?? username ?? userId,
				name: username,
				tag: member.user ? formatDiscordUserTag(member.user) : void 0
			};
		} catch {
			try {
				const user = await this.params.client.fetchUser(userId);
				const username = user.username ?? void 0;
				return {
					id: userId,
					label: user.globalName ?? username ?? userId,
					name: username,
					tag: formatDiscordUserTag(user)
				};
			} catch {
				return {
					id: userId,
					label: userId
				};
			}
		}
	}
};
var DiscordVoiceReadyListener = class extends ReadyListener {
	constructor(manager) {
		super();
		this.manager = manager;
	}
	async handle() {
		await this.manager.autoJoin();
	}
};
function isVoiceChannel(type) {
	return type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice;
}
//#endregion
export { DiscordVoiceManager, DiscordVoiceReadyListener };
