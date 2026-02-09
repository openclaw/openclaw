import crypto from "node:crypto";
import type { VoiceCallConfig } from "../config.js";
import type { CoreConfig } from "../core-bridge.js";
import type { CallManager } from "../manager.js";
import type { TelephonyTtsProvider } from "../telephony-tts.js";
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
} from "../types.js";
import type { VoiceCallProvider } from "./base.js";
import { loadCoreAgentDeps } from "../core-bridge.js";
import { chunkAudio } from "../telephony-audio.js";
import { AriClient, type AriEvent } from "./asterisk-ari/ari-client.js";
import { AriMedia, type MediaGraph } from "./asterisk-ari/ari-media.js";

type AriConfig = NonNullable<VoiceCallConfig["asteriskAri"]>;

function nowMs(): number {
  return Date.now();
}

export function buildEndpoint(to: string, trunk?: string): string {
  if (to.includes("/")) {
    return to;
  }
  const t = trunk?.trim();
  return t ? `PJSIP/${t}/${to}` : `PJSIP/${to}`;
}

function makeEvent(partial: Omit<NormalizedEvent, "id" | "timestamp">): NormalizedEvent {
  return {
    id: crypto.randomUUID(),
    timestamp: nowMs(),
    ...partial,
  } as NormalizedEvent;
}

type CoreSttSession = {
  onAudio: (mulaw: Buffer) => void;
  close: () => void;
};

type CallState = {
  callId: string;
  providerCallId: string;
  sipChannelId: string;
  media?: MediaGraph;
  speaking: boolean;
  ttsTimer?: NodeJS.Timeout;
  stt?: CoreSttSession;
  pendingMulaw?: Buffer;
  rtpPeer?: { address: string; port: number };
  rtpSeen?: boolean;
  rtpState?: { seq: number; ts: number; ssrc: number };
};

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

  constructor(params: {
    config: VoiceCallConfig;
    manager: CallManager;
    coreConfig?: CoreConfig;
    connectWs?: boolean;
  }) {
    const a = params.config.asteriskAri;
    if (!a) throw new Error("asteriskAri config missing");
    this.voiceConfig = params.config;
    this.cfg = a;
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
      if (parts.length === 2) {
        const resource = parts[1];
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

    await this.client.safeHangupChannel(state.sipChannelId);
    await this.cleanup(input.providerCallId, input.reason);
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    const state = this.calls.get(input.providerCallId);
    if (!state || !state.media) return;

    if (!this.ttsProvider) {
      console.warn("[ari] Telephony TTS provider not configured; skipping playback");
      return;
    }
    const mulaw = await this.ttsProvider.synthesizeForTelephony(input.text);

    state.speaking = true;
    this.manager.processEvent(
      makeEvent({
        type: "call.speaking",
        callId: state.callId,
        providerCallId: state.providerCallId,
        text: input.text,
      }),
    );

    const rtpPeer = this.getRtpPeer(state);
    if (!rtpPeer) {
      // Wait until we receive at least one RTP packet from Asterisk (then we know its port).
      state.pendingMulaw = mulaw;
      console.warn("[ari] No RTP peer learned yet; queued TTS until RTP starts flowing");
      state.speaking = false;
      return;
    }

    this.sendMulawRtp(state, mulaw, rtpPeer);
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
      for (const [pId, state] of this.calls.entries()) {
        if (state.sipChannelId === chId) {
          await this.cleanup(pId, "hangup-user");
          break;
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
    state.media.udp.on("message", (msg, rinfo) => {
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
        state.pendingMulaw = undefined;
        const peer = this.getRtpPeer(state) || rinfo;
        this.sendMulawRtp(state, pending, peer);
      }
    });
  }

  private getRtpPeer(state: CallState) {
    return state.rtpPeer;
  }

  private setRtpPeer(state: CallState, rinfo: { address: string; port: number }) {
    state.rtpPeer = rinfo;
  }

  private sendMulawRtp(state: CallState, mulaw: Buffer, peer: { address: string; port: number }) {
    if (!state.media) return;
    const udp = state.media.udp;

    if (state.ttsTimer) {
      clearInterval(state.ttsTimer);
      state.ttsTimer = undefined;
    }

    state.speaking = true;
    const payload = this.cfg.codec === "alaw" ? this.mulawToAlawBuffer(mulaw) : mulaw;
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

  private mulawToLinear(mulaw: number): number {
    mulaw = ~mulaw & 0xff;
    const sign = mulaw & 0x80;
    const exponent = (mulaw >> 4) & 0x07;
    const mantissa = mulaw & 0x0f;
    let sample = ((mantissa << 3) + 132) << exponent;
    sample -= 132;
    return sign ? -sample : sample;
  }

  private alawToLinear(aLaw: number): number {
    let a = aLaw ^ 0x55;
    let t = (a & 0x0f) << 4;
    const seg = (a & 0x70) >> 4;
    switch (seg) {
      case 0:
        t += 8;
        break;
      case 1:
        t += 0x108;
        break;
      default:
        t += 0x108;
        t <<= seg - 1;
        break;
    }
    return a & 0x80 ? t : -t;
  }

  private linearToAlaw(pcm: number): number {
    const ALAW_MAX = 0x7fff;
    let mask = 0xd5;
    let p = pcm;
    if (p < 0) {
      mask = 0x55;
      p = -p - 1;
    }
    if (p > ALAW_MAX) {
      p = ALAW_MAX;
    }
    let seg = 0;
    if (p >= 256) {
      let tmp = p >> 8;
      while (tmp) {
        seg++;
        tmp >>= 1;
      }
      seg = Math.min(seg, 7);
      const aval = (seg << 4) | ((p >> (seg + 3)) & 0x0f);
      return (aval ^ mask) & 0xff;
    }
    const aval = p >> 4;
    return (aval ^ mask) & 0xff;
  }

  private g711ToPcm16Buffer(payload: Buffer): Buffer {
    const pcm = Buffer.allocUnsafe(payload.length * 2);
    if (this.cfg.codec === "alaw") {
      for (let i = 0; i < payload.length; i++) {
        pcm.writeInt16LE(this.alawToLinear(payload[i] ?? 0), i * 2);
      }
      return pcm;
    }
    for (let i = 0; i < payload.length; i++) {
      pcm.writeInt16LE(this.mulawToLinear(payload[i] ?? 0), i * 2);
    }
    return pcm;
  }

  private mulawToAlawBuffer(mulaw: Buffer): Buffer {
    const out = Buffer.allocUnsafe(mulaw.length);
    for (let i = 0; i < mulaw.length; i++) {
      out[i] = this.linearToAlaw(this.mulawToLinear(mulaw[i] ?? 0));
    }
    return out;
  }

  private computeRms(pcm: Buffer): number {
    if (pcm.length < 2) return 0;
    let sum = 0;
    for (let i = 0; i < pcm.length; i += 2) {
      const sample = pcm.readInt16LE(i);
      sum += sample * sample;
    }
    const count = pcm.length / 2;
    return Math.sqrt(sum / Math.max(1, count));
  }

  private pcmDurationMsFromBytes(bytes: number): number {
    return Math.round((bytes / 2 / 8000) * 1000);
  }

  private buildWavFromPcm(pcm: Buffer, sampleRate = 8000): Buffer {
    const dataSize = pcm.length;
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, 4, "ascii");
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8, 4, "ascii");
    header.write("fmt ", 12, 4, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, 4, "ascii");
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, pcm]);
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

    const wav = this.buildWavFromPcm(pcm);

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
      }
    } catch (err) {
      console.warn("[ari] core STT failed", err);
    }
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
      const durationMs = this.pcmDurationMsFromBytes(bufferBytes);
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
      const pcm = this.g711ToPcm16Buffer(mulaw);
      const rms = this.computeRms(pcm);
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
    state.media.sttUdp.on("message", (msg) => {
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
    });

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

    this.manager.processEvent(
      makeEvent({
        type: "call.initiated",
        callId: providerCallId,
        providerCallId,
        direction: "inbound",
        from,
        to,
      }),
    );

    const call = this.manager.getCallByProviderCallId(providerCallId);
    if (!call) {
      return;
    }

    this.pendingInboundChannels.delete(providerCallId);

    const state: CallState = {
      callId: call.callId,
      providerCallId,
      sipChannelId,
      speaking: false,
    };
    this.calls.set(providerCallId, state);

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
    }
  }

  private async cleanup(providerCallId: string, reason: EndReason = "completed") {
    const state = this.calls.get(providerCallId);
    if (!state) return;

    this.calls.delete(providerCallId);

    if (state.sipChannelId) {
      await this.client.safeHangupChannel(state.sipChannelId).catch(() => {});
    }

    if (state.ttsTimer) {
      clearInterval(state.ttsTimer);
      state.ttsTimer = undefined;
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
