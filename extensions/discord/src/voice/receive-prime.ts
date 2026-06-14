// Discord voice receive "priming".
//
// Root cause (see specs/discord-voice-receive-debug-2026-05-31.md): a voice
// connection that only ever *receives* never transmits, so @discordjs/voice
// never calls `setSpeaking(true)` (it is only sent from `prepareAudioPacket`
// when the bot actually plays an audio packet). Discord's voice SFU does not
// begin forwarding inbound media (RTP audio) or op-5 `Speaking` opcodes to a
// connection until that connection has announced itself as an active media
// participant via op-5. A pure receive-only bot therefore sits Ready with the
// UDP socket up but only sees keepalive-class datagrams: `ssrcMap` stays empty
// and `speaking.start` never fires.
//
// The fix is to transmit one short burst of Opus silence through the existing
// player right after join. That triggers `setSpeaking(true)` -> op-5 Speaking,
// which registers the bot with the SFU and unblocks inbound audio + Speaking
// opcodes for the other participants. The burst is intentionally tiny so the
// player returns to Idle long before a human starts speaking and so it never
// blocks the realtime/STT capture gate (`player.state.status === Playing`).

import { Readable } from "node:stream";

// 20ms Opus silence frame. Same constant @discordjs/voice plays internally when
// padding a stream; pushing it in object mode (StreamType.Opus) needs no codec.
const OPUS_SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

// ~240ms of silence (12 * 20ms). Enough for the gateway to register op-5
// Speaking(true) and latch the participant as active, short enough to clear
// before a human utterance.
const DEFAULT_PRIME_FRAME_COUNT = 12;

// Structural shapes kept loose: the caller passes the real @discordjs/voice
// AudioPlayer / SDK via a `Parameters<...>` cast at the call site (same pattern
// as receive-diagnostics), so these only need to express the calls we make.
type PrimeAudioResource = ReturnType<PrimeVoiceSdk["createAudioResource"]>;

type PrimeAudioPlayer = {
  play: (resource: PrimeAudioResource) => void;
};

type PrimeVoiceSdk = {
  createAudioResource: (input: Readable, options: { inputType: unknown }) => unknown;
  StreamType: { Opus: unknown };
};

/**
 * Builds an object-mode Opus stream that pushes `frameCount` silence frames and
 * then ends. Object mode means each `push` is one ready-to-send Opus packet, so
 * no transcoding/ffmpeg is involved.
 */
export function createOpusSilenceStream(frameCount: number): Readable {
  let remaining = Math.max(0, frameCount);
  return new Readable({
    objectMode: true,
    read() {
      if (remaining <= 0) {
        this.push(null);
        return;
      }
      remaining -= 1;
      this.push(OPUS_SILENCE_FRAME);
    },
  });
}

export type PrimeVoiceReceiveParams = {
  player: PrimeAudioPlayer;
  voiceSdk: PrimeVoiceSdk;
  guildId: string;
  channelId: string;
  log: (message: string) => void;
  onWarn: (message: string) => void;
  frameCount?: number;
};

/**
 * Transmits a short Opus-silence burst through the connection's player so the
 * bot sends an op-5 Speaking opcode and the SFU starts forwarding inbound
 * audio. Returns true if the priming resource was dispatched to the player.
 *
 * Failures are non-fatal: priming is best-effort and the session is still
 * usable (transmit will also occur on the first played response).
 */
export function primeVoiceReceive(params: PrimeVoiceReceiveParams): boolean {
  const { player, voiceSdk, guildId, channelId, log, onWarn } = params;
  const frameCount = params.frameCount ?? DEFAULT_PRIME_FRAME_COUNT;
  try {
    const silence = createOpusSilenceStream(frameCount);
    const resource = voiceSdk.createAudioResource(silence, {
      inputType: voiceSdk.StreamType.Opus,
    });
    player.play(resource);
    log(
      `receive-prime: sent op-5 Speaking via ${frameCount}-frame Opus silence burst: guild ${guildId} channel ${channelId}`,
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onWarn(`discord voice: receive-prime failed guild=${guildId} channel=${channelId}: ${message}`);
    return false;
  }
}
