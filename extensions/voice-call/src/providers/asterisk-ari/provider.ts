import type { RemoteInfo } from "node:dgram";
import crypto from "node:crypto";
import type { CallMode, VoiceCallConfig } from "../../config.js";
import type { CoreConfig } from "../../core-bridge.js";
import type { CallManager } from "../../manager.js";
import type { TelephonyTtsProvider } from "../../telephony-tts.js";
import type {
  EndReason,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
  NormalizedEvent,
} from "../../types.js";
import type { VoiceCallProvider } from "../base.js";
import { loadCoreAgentDeps } from "../../core-bridge.js";
import { chunkAudio } from "../../telephony-audio.js";
import { TerminalStates } from "../../types.js";
import { AriClient, type AriEvent } from "./ari-client.js";
import { AriMedia, type MediaGraph } from "./ari-media.js";
import {
  buildWavFromPcm,
  computeRms,
  g711ToPcm16Buffer,
  mulawToAlawBuffer,
  pcmDurationMsFromBytes,
} from "./audio-utils.js";
import { reconcileLingeringCalls } from "./reconcile.js";
import { requireAriConfig, type AriConfig, type CallState, type CoreSttSession } from "./types.js";
import { buildEndpoint, makeEvent, nowMs } from "./utils.js";

export class AsteriskAriProvider implements VoiceCallProvider {
  readonly name = "asterisk-ari" as const;

  private readonly cfg: AriConfig;
  private readonly voiceConfig: VoiceCallConfig;
  private readonly manager: CallManager;
  private readonly client: AriClient;
  private readonly mediaFactory: AriMedia;
  private readonly coreConfig: CoreConfig | null;
  private ttsProvider: TelephonyTtsProvider | null = null;
  private coreDepsPromise: Promise<Awaited<ReturnType<typeof loadCoreAgentDeps>>> | null = null;

  // providerCallId -> state
  private readonly calls = new Map<string, CallState>();
  private readonly pendingInboundChannels = new Set<string>();
  private readonly autoResponseQueue = new Map<string, Promise<void>>();

  constructor(params: {
    config: VoiceCallConfig;
    manager: CallManager;
    coreConfig?: CoreConfig;
    connectWs?: boolean;
  }) {
    const a = params.config.asteriskAri;
    if (!a) throw new Error("asteriskAri config missing");
    this.voiceConfig = params.config;
    this.cfg = requireAriConfig(a);
    this.manager = params.manager;
    this.coreConfig = params.coreConfig ?? null;
    this.client = new AriClient(this.cfg);
    this.mediaFactory = new AriMedia(this.cfg, this.client);

    if (params.connectWs !== false) {
      this.client.connectWs((evt) => this.onAriEvent(evt));
    }
  }

  setTTSProvider(provider: TelephonyTtsProvider) {
    this.ttsProvider = provider;
  }

  async reconcileLingeringCalls(): Promise<void> {
    return reconcileLingeringCalls({
      client: this.client,
      cfg: this.cfg,
      manager: this.manager,
      providerName: this.name,
    });
  }

  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return { ok: true };
  }

  parseWebhookEvent(_ctx: WebhookContext): ProviderWebhookParseResult {
    return { events: [], statusCode: 200 };
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const providerCallId = crypto.randomUUID();
    const endpoint = buildEndpoint(input.to, this.cfg.trunk);

    // 1. Check endpoint online (only for direct PJSIP/<resource>, not trunks)
    if (endpoint.toUpperCase().startsWith("PJSIP/")) {
      const parts = endpoint.split("/");
      const resource = parts[1];
      const isDirectEndpoint = parts.length === 2 && resource && !resource.includes("@");
      if (isDirectEndpoint) {
        try {
          const state = await this.client.getEndpointState(resource);
          if (state.state.toLowerCase() !== "online") {
            throw new Error(`Endpoint PJSIP/${resource} is ${state.state}`);
          }
        } catch (err: any) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Endpoint PJSIP/${resource} unavailable (${msg})`);
        }
      }
    }

    // 2. Originate call
    const callerId = input.fromName ? `${input.fromName} <${input.from}>` : input.from;
    const ch = await this.client.createChannel({
      endpoint,
      app: this.cfg.app,
      appArgs: providerCallId,
      callerId,
    });

    const state: CallState = {
      callId: input.callId,
      providerCallId,
      sipChannelId: ch.id,
      speaking: false,
    };
    this.calls.set(providerCallId, state);
    this.manager.updateCallMetadata(input.callId, { sipChannelId: ch.id });

    this.manager.processEvent(
      makeEvent({
        type: "call.initiated",
        callId: input.callId,
        providerCallId,
        direction: "outbound",
        from: input.from,
        to: input.to,
      }),
    );

    this.manager.processEvent(
      makeEvent({
        type: "call.ringing",
        callId: input.callId,
        providerCallId,
      }),
    );

    return { providerCallId, status: "initiated" };
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    const state = this.calls.get(input.providerCallId);
    if (!state) {
      if (this.pendingInboundChannels.has(input.providerCallId)) {
        this.pendingInboundChannels.delete(input.providerCallId);
        await this.client.safeHangupChannel(input.providerCallId).catch(() => {});
        return;
      }
      const call =
        this.manager.getCall(input.callId) ??
        this.manager.getCallByProviderCallId(input.providerCallId);
      const channelId = call?.providerCallId;
      if (!channelId) {
        console.warn("[ari] hangup skipped; missing channel id", {
          callId: input.callId,
          providerCallId: input.providerCallId,
        });
        return;
      }
      await this.client.safeHangupChannel(channelId).catch(() => {});
      return;
    }

    await this.cleanup(input.providerCallId, input.reason);
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    const state = this.calls.get(input.providerCallId);
    if (!state) return;

    if (!this.ttsProvider) {
      console.warn("[ari] Telephony TTS provider not configured; skipping playback");
      return;
    }
    const mulaw = await this.ttsProvider.synthesizeForTelephony(input.text);

    if (!state.media) {
      state.pendingMulaw = mulaw;
      state.pendingSpeakText = input.text ?? "";
      console.warn("[ari] Media not ready; queued TTS until RTP starts flowing");
      return;
    }

    const rtpPeer = this.getRtpPeer(state);
    if (!rtpPeer) {
      // Wait until we receive at least one RTP packet from Asterisk (then we know its port).
      state.pendingMulaw = mulaw;
      state.pendingSpeakText = input.text ?? "";
      console.warn("[ari] No RTP peer learned yet; queued TTS until RTP starts flowing");
      return;
    }

    this.sendMulawRtp(state, mulaw, rtpPeer, input.text ?? "");
  }

  async startListening(_input: StartListeningInput): Promise<void> {
    // STT is always-on in this architecture (via snoop)
  }

  async stopListening(_input: StopListeningInput): Promise<void> {
    // no-op
  }

  private async onAriEvent(evt: AriEvent) {
    if (evt.type === "StasisStart") {
      const args = evt.args || [];
      const providerCallId = args[0];

      // Inbound call: no appArgs provided
      if (!providerCallId) {
        const name = evt.channel?.name || "";
        // Ignore non-SIP channels (ExternalMedia/Snoop) entering Stasis
        if (!name.startsWith("PJSIP/") && !name.startsWith("SIP/")) {
          return;
        }
        await this.handleInboundStart(evt);
        return;
      }

      const state = this.calls.get(providerCallId);
      if (!state) return; // Maybe zombie call

      if (!state.media) {
        try {
          await this.setupMedia(state);
        } catch (err) {
          console.error("[ari] Media setup failed", err);
          this.manager.processEvent(
            makeEvent({
              type: "call.error",
              callId: state.callId,
              providerCallId: state.providerCallId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          await this.hangupCall({
            callId: state.callId,
            providerCallId: state.providerCallId,
            reason: "error",
          });
        }
      }

      if (evt.channel?.state?.toLowerCase() === "up") {
        this.maybeEmitAnswered(state);
      }
    } else if (evt.type === "ChannelStateChange") {
      const chId = evt.channel?.id;
      const chState = evt.channel?.state?.toLowerCase();
      if (!chId || !chState) return;

      const endReason: EndReason | null =
        chState === "busy"
          ? "busy"
          : chState === "congestion" || chState === "failed"
            ? "failed"
            : null;
      if (endReason) {
        for (const [providerCallId, state] of this.calls.entries()) {
          if (state.sipChannelId === chId) {
            await this.cleanup(providerCallId, endReason);
            break;
          }
        }
        return;
      }

      if (chState !== "up") return;

      for (const state of this.calls.values()) {
        if (state.sipChannelId === chId) {
          this.maybeEmitAnswered(state);
          break;
        }
      }
    } else if (evt.type === "ChannelDtmfReceived") {
      const chId = evt.channel?.id;
      const digit = evt.digit;
      if (!chId || !digit) return;

      for (const state of this.calls.values()) {
        if (state.sipChannelId === chId) {
          this.manager.processEvent(
            makeEvent({
              type: "call.dtmf",
              callId: state.callId,
              providerCallId: state.providerCallId,
              digits: digit,
            }),
          );
          break;
        }
      }
    } else if (evt.type === "StasisEnd") {
      const chId = evt.channel?.id;
      let cleaned = false;
      for (const [pId, state] of this.calls.entries()) {
        if (state.sipChannelId === chId) {
          await this.cleanup(pId, "hangup-user");
          cleaned = true;
          break;
        }
      }

      if (!cleaned && chId) {
        this.pendingInboundChannels.delete(chId);
        const call = this.manager.getCallByProviderCallId(chId);
        // cleanup() is the single source of truth for call.ended.
        // This fallback is only for cases where we never tracked the call state in this provider.
        if (call && !TerminalStates.has(call.state)) {
          this.manager.processEvent(
            makeEvent({
              type: "call.ended",
              callId: call.callId,
              providerCallId: call.providerCallId,
              reason: "hangup-user",
            }),
          );
        }
      }
    }
  }

  private async setupMedia(state: CallState): Promise<void> {
    if (state.media) return;

    const media = await this.mediaFactory.createMediaGraph({ sipChannelId: state.sipChannelId });
    state.media = media;

    await this.seedRtpPeer(state);
    this.wireRtp(state);
    await this.setupStt(state);
  }

  private maybeEmitAnswered(state: CallState): void {
    if (state.answeredEmitted) return;
    state.answeredEmitted = true;
    this.manager.processEvent(
      makeEvent({
        type: "call.answered",
        callId: state.callId,
        providerCallId: state.providerCallId,
      }),
    );
    this.manager.processEvent(
      makeEvent({
        type: "call.active",
        callId: state.callId,
        providerCallId: state.providerCallId,
      }),
    );
  }

  private async seedRtpPeer(state: CallState): Promise<void> {
    if (!state.media || state.rtpPeer) return;
    try {
      const portStr = await this.client.getChannelVar(
        state.media.extChannelId,
        "UNICASTRTP_LOCAL_PORT",
      );
      const addrStr = await this.client.getChannelVar(
        state.media.extChannelId,
        "UNICASTRTP_LOCAL_ADDRESS",
      );
      const port = portStr ? Number(portStr) : null;
      const address = addrStr || this.cfg.rtpHost;
      if (port && address) {
        this.setRtpPeer(state, { address, port });
        console.log("[ari] seeded RTP peer", { address, port });
      }
    } catch {}
  }

  private wireRtp(state: CallState): void {
    if (!state.media) return;
    const handler = (msg: Buffer, rinfo: RemoteInfo) => {
      if (!state.rtpSeen) {
        state.rtpSeen = true;
        console.log("[ari] RTP in from Asterisk", { rinfo, bytes: msg.length });
      }
      const prev = this.getRtpPeer(state);
      if (!prev) {
        console.log("[ari] Learned RTP peer from Asterisk:", rinfo);
        this.setRtpPeer(state, rinfo);
      }

      const pending = state.pendingMulaw;
      if (pending && !state.ttsTimer) {
        const pendingText = state.pendingSpeakText ?? "";
        state.pendingMulaw = undefined;
        state.pendingSpeakText = undefined;
        const peer = this.getRtpPeer(state) || rinfo;
        this.sendMulawRtp(state, pending, peer, pendingText);
      }
    };
    state.rtpMessageHandler = handler;
    state.media.udp.on("message", handler);
  }

  private getRtpPeer(state: CallState) {
    return state.rtpPeer;
  }

  private setRtpPeer(state: CallState, rinfo: { address: string; port: number }) {
    state.rtpPeer = rinfo;
  }

  private sendMulawRtp(
    state: CallState,
    mulaw: Buffer,
    peer: { address: string; port: number },
    text?: string,
  ) {
    if (!state.media) return;
    const udp = state.media.udp;

    if (state.ttsTimer) {
      clearInterval(state.ttsTimer);
      state.ttsTimer = undefined;
    }

    state.speaking = true;
    const payload = this.cfg.codec === "alaw" ? mulawToAlawBuffer(mulaw) : mulaw;
    const chunkIter = chunkAudio(payload, 160);
    let i = 0;
    const interval = setInterval(() => {
      if (!this.calls.has(state.providerCallId) || state.ttsTimer !== interval) {
        clearInterval(interval);
        if (state.ttsTimer === interval) {
          state.ttsTimer = undefined;
        }
        state.speaking = false;
        return;
      }

      const next = chunkIter.next();
      if (next.done || !next.value) {
        clearInterval(interval);
        if (state.ttsTimer === interval) {
          state.ttsTimer = undefined;
        }
        state.speaking = false;
        return;
      }

      const pkt = this.makeRtpPacket(state, next.value);
      if (i === 0) {
        if (this.calls.has(state.providerCallId)) {
          this.manager.processEvent(
            makeEvent({
              type: "call.speaking",
              callId: state.callId,
              providerCallId: state.providerCallId,
              text: text ?? "",
            }),
          );
        }
        try {
          console.log("[ari] RTP send", { bytes: pkt.length, to: peer, from: udp.address() });
        } catch {
          console.log("[ari] RTP send", { bytes: pkt.length, to: peer });
        }
      }
      udp.send(pkt, peer.port, peer.address, (err) => {
        if (err) {
          console.warn("[ari] RTP send error", err);
        }
      });
      i++;
    }, 20);

    state.ttsTimer = interval;
  }

  private ensureRtpState(state: CallState): { seq: number; ts: number; ssrc: number } {
    if (!state.rtpState) {
      state.rtpState = {
        seq: Math.floor(Math.random() * 0xffff),
        ts: Math.floor(Math.random() * 0xffffffff),
        ssrc: Math.floor(Math.random() * 0xffffffff),
      };
    }
    return state.rtpState;
  }

  private makeRtpPacket(state: CallState, payload: Buffer): Buffer {
    const r = this.ensureRtpState(state);
    const header = Buffer.alloc(12);
    header[0] = 0x80; // V=2, P=0, X=0, CC=0
    const payloadType = this.cfg.codec === "alaw" ? 8 : 0; // PCMA=8, PCMU=0
    header[1] = payloadType & 0x7f; // M=0
    header.writeUInt16BE(r.seq & 0xffff, 2);
    header.writeUInt32BE(r.ts >>> 0, 4);
    header.writeUInt32BE(r.ssrc >>> 0, 8);

    r.seq = (r.seq + 1) & 0xffff;
    r.ts = (r.ts + 160) >>> 0; // 20ms @ 8kHz

    return Buffer.concat([header, payload]);
  }

  private stripRtpHeader(pkt: Buffer): Buffer {
    if (pkt.length < 12) return Buffer.alloc(0);
    const cc = pkt[0] & 0x0f;
    const hasExt = (pkt[0] & 0x10) !== 0;
    let headerLen = 12 + cc * 4;
    if (hasExt) {
      if (pkt.length < headerLen + 4) return Buffer.alloc(0);
      const extLen = pkt.readUInt16BE(headerLen + 2); // in 32-bit words
      headerLen += 4 + extLen * 4;
    }
    if (pkt.length <= headerLen) return Buffer.alloc(0);
    return pkt.subarray(headerLen);
  }

  private async loadCoreDeps() {
    if (!this.coreConfig) return null;
    if (!this.coreDepsPromise) {
      this.coreDepsPromise = loadCoreAgentDeps();
    }
    try {
      return await this.coreDepsPromise;
    } catch (err) {
      console.warn("[ari] STT disabled: core deps unavailable", err);
      return null;
    }
  }

  private async transcribePcmWithCore(state: CallState, pcm: Buffer): Promise<void> {
    if (!this.coreConfig) return;
    const deps = await this.loadCoreDeps();
    if (!deps) return;

    const wav = buildWavFromPcm(pcm);

    try {
      const result = await deps.transcribeAudioWithCore({
        cfg: this.coreConfig,
        buffer: wav,
        mime: "audio/wav",
      });
      const text = result.text?.trim();
      if (text && this.calls.has(state.providerCallId)) {
        console.log("[ari] core STT -> call.speech", { text });
        this.manager.processEvent(
          makeEvent({
            type: "call.speech",
            callId: state.callId,
            providerCallId: state.providerCallId,
            transcript: text,
            isFinal: true,
          }),
        );
        this.enqueueAutoResponse(state, text);
      }
    } catch (err) {
      console.warn("[ari] core STT failed", err);
    }
  }

  private enqueueAutoResponse(state: CallState, userMessage: string): void {
    const call = this.manager.getCall(state.callId);
    if (!call) return;

    if (this.voiceConfig.autoResponse === false) {
      return;
    }

    const mode = (call.metadata?.mode as CallMode | undefined) ?? "conversation";
    const shouldRespond = call.direction === "inbound" || mode === "conversation";
    if (!shouldRespond) return;

    const coreConfig = this.coreConfig;
    if (!coreConfig) {
      console.warn("[ari] Core config missing; skipping auto-response");
      return;
    }

    const prev = this.autoResponseQueue.get(state.providerCallId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        const current = this.manager.getCall(state.callId);
        if (!current || TerminalStates.has(current.state)) {
          return;
        }

        try {
          const { generateVoiceResponse } = await import("../../response-generator.js");
          const result = await generateVoiceResponse({
            voiceConfig: this.voiceConfig,
            coreConfig,
            callId: state.callId,
            from: current.from,
            transcript: current.transcript,
            userMessage,
          });

          if (result.error) {
            console.warn(`[voice-call] Auto-response error: ${result.error}`);
            return;
          }

          if (result.text) {
            await this.manager.speak(state.callId, result.text);
          }
        } catch (err) {
          console.warn("[voice-call] Auto-response failed", err);
        }
      });

    this.autoResponseQueue.set(state.providerCallId, next);
  }

  private async createCoreSttSession(state: CallState): Promise<CoreSttSession | null> {
    if (!this.coreConfig) {
      console.warn("[ari] STT disabled: core config missing");
      return null;
    }
    const deps = await this.loadCoreDeps();
    if (!deps) return null;

    const silenceMs = Math.max(200, this.voiceConfig.silenceTimeoutMs ?? 800);
    const minSpeechMs = Math.min(1200, Math.max(200, Math.floor(silenceMs * 0.5)));
    const maxSpeechMs = Math.max(4000, Math.min(20000, silenceMs * 20));
    const hangoverMs = Math.max(120, Math.floor(silenceMs * 0.25));
    const bytesPerMs = 16; // 8kHz * 2 bytes
    const maxBufferBytes = maxSpeechMs * bytesPerMs;
    const preRollMs = Math.min(500, Math.max(200, Math.floor(silenceMs * 0.6)));
    const preRollBytesLimit = preRollMs * bytesPerMs;
    const rmsFloorMin = 200;
    const noiseAlpha = 0.05;
    const noiseMultiplier = 2.5;
    const noiseOffset = 120;
    const maxPendingSegments = 2;

    let closed = false;
    let speaking = false;
    let lastVoiceMs = 0;
    let buffers: Buffer[] = [];
    let bufferBytes = 0;
    let preRoll: Buffer[] = [];
    let preRollBytes = 0;
    let noiseFloor = 0;
    let pendingSegments = 0;
    let queue = Promise.resolve();

    const enqueue = (pcm: Buffer) => {
      if (pendingSegments >= maxPendingSegments) {
        console.warn("[ari] STT backpressure: dropping segment", {
          pendingSegments,
          maxPendingSegments,
        });
        return;
      }
      pendingSegments += 1;
      queue = queue
        .catch(() => undefined)
        .then(async () => {
          try {
            await this.transcribePcmWithCore(state, pcm);
          } finally {
            pendingSegments = Math.max(0, pendingSegments - 1);
          }
        });
    };

    const flush = () => {
      if (!buffers.length) {
        speaking = false;
        return;
      }
      const pcm = Buffer.concat(buffers);
      const durationMs = pcmDurationMsFromBytes(bufferBytes);
      buffers = [];
      bufferBytes = 0;
      speaking = false;
      if (durationMs < minSpeechMs) {
        return;
      }
      enqueue(pcm);
    };

    const onAudio = (mulaw: Buffer) => {
      if (closed) return;
      const pcm = g711ToPcm16Buffer(mulaw, this.cfg.codec);
      const rms = computeRms(pcm);
      const now = Date.now();

      if (!speaking) {
        const target = Math.max(rmsFloorMin, rms);
        noiseFloor = noiseFloor ? noiseFloor * (1 - noiseAlpha) + target * noiseAlpha : target;
      }
      const threshold = Math.max(rmsFloorMin, noiseFloor * noiseMultiplier + noiseOffset);
      const isVoice = rms > threshold;

      if (speaking) {
        buffers.push(pcm);
        bufferBytes += pcm.length;
        if (isVoice) {
          lastVoiceMs = now;
        }
        if (!isVoice && now - lastVoiceMs >= silenceMs + hangoverMs) {
          flush();
          return;
        }
        if (bufferBytes >= maxBufferBytes) {
          console.warn("[ari] STT buffer limit reached, flushing", {
            bufferBytes,
            maxBufferBytes,
          });
          flush();
          return;
        }
        return;
      }

      preRoll.push(pcm);
      preRollBytes += pcm.length;
      while (preRollBytes > preRollBytesLimit) {
        const dropped = preRoll.shift();
        if (dropped) preRollBytes -= dropped.length;
      }

      if (isVoice) {
        speaking = true;
        lastVoiceMs = now;
        buffers = preRoll;
        bufferBytes = preRollBytes;
        preRoll = [];
        preRollBytes = 0;
      }
    };

    const close = () => {
      closed = true;
      buffers = [];
      bufferBytes = 0;
      preRoll = [];
      preRollBytes = 0;
    };

    return { onAudio, close };
  }

  private async setupStt(state: CallState): Promise<void> {
    if (!state.media) return;
    const session = await this.createCoreSttSession(state);
    if (!session) return;

    let loggedPayload = false;
    const handler = (msg: Buffer) => {
      const payload = this.stripRtpHeader(msg);
      if (!payload.length) return;
      if (!loggedPayload) {
        loggedPayload = true;
        console.log("[ari] STT payload", {
          bytes: payload.length,
          head: payload.subarray(0, 8).toString("hex"),
        });
      }
      session.onAudio(payload);
    };
    state.sttMessageHandler = handler;
    state.media.sttUdp.on("message", handler);

    state.stt = session;
    console.log("[ari] core STT setup ok");
  }

  private async handleInboundStart(evt: AriEvent): Promise<void> {
    const sipChannelId = evt.channel?.id;
    if (!sipChannelId) return;

    const providerCallId = sipChannelId;
    const from = evt.channel?.caller?.number;
    const to = evt.channel?.name;

    this.pendingInboundChannels.add(providerCallId);

    const call = this.manager.ensureInboundCall({ providerCallId, from, to });
    if (!call) {
      this.pendingInboundChannels.delete(providerCallId);
      return;
    }

    this.manager.processEvent(
      makeEvent({
        type: "call.initiated",
        callId: call.callId,
        providerCallId,
        direction: "inbound",
        from,
        to,
      }),
    );

    this.pendingInboundChannels.delete(providerCallId);

    const state: CallState = {
      callId: call.callId,
      providerCallId,
      sipChannelId,
      speaking: false,
    };
    this.calls.set(providerCallId, state);
    this.manager.updateCallMetadata(call.callId, { sipChannelId });

    try {
      await this.client.answerChannel(sipChannelId);
    } catch {}

    try {
      await this.setupMedia(state);
    } catch (err) {
      console.error("[ari] Inbound media setup failed", err);
      this.manager.processEvent(
        makeEvent({
          type: "call.error",
          callId: state.callId,
          providerCallId: state.providerCallId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      await this.hangupCall({
        callId: state.callId,
        providerCallId: state.providerCallId,
        reason: "error",
      });
      return;
    }

    // Note: do not emit answered from StasisStart; rely on ChannelStateChange → Up.
  }

  private async cleanup(providerCallId: string, reason: EndReason = "completed") {
    const state = this.calls.get(providerCallId);
    if (!state) return;

    this.calls.delete(providerCallId);
    this.autoResponseQueue.delete(providerCallId);

    if (state.sipChannelId) {
      await this.client.safeHangupChannel(state.sipChannelId).catch(() => {});
    }

    if (state.ttsTimer) {
      clearInterval(state.ttsTimer);
      state.ttsTimer = undefined;
    }
    if (state.media && state.rtpMessageHandler) {
      state.media.udp.off("message", state.rtpMessageHandler);
      state.rtpMessageHandler = undefined;
    }
    if (state.media && state.sttMessageHandler) {
      state.media.sttUdp.off("message", state.sttMessageHandler);
      state.sttMessageHandler = undefined;
    }
    if (state.media) {
      await this.mediaFactory.teardown(state.media);
    }
    if (state.stt) {
      try {
        state.stt.close();
      } catch {}
      state.stt = undefined;
    }

    this.manager.processEvent(
      makeEvent({
        type: "call.ended",
        callId: state.callId,
        providerCallId: state.providerCallId,
        reason,
      }),
    );
  }
}
