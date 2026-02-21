/// Hardcoded ZEKE configuration — zero setup required.
/// This file ships with values that connect directly to ZEKE's gateway.
/// For other OpenClaw deployments, fork and change these values.

class ZekeConfig {
  // ── Gateway ──────────────────────────────────────────────
  // Connects via Tailscale internal IP (phone must have Tailscale)
  static const String gatewayHost = '100.112.227.117';
  static const int gatewayPort = 18789;
  static const String gatewayToken = '493fb5919a16b885fe34bcded2b5e5df4f5c3f2166c361d9';
  // Public URLs for fallback
  static const String gatewayWss = 'wss://zeke.tail5b81a2.ts.net';
  static const String gatewayHttps = 'https://zeke.tail5b81a2.ts.net';

  // ── Identity ─────────────────────────────────────────────
  static const String botName = 'ZEKE';
  static const String botHandle = '@ZEKEaiBot';
  static const String appTitle = 'ZEKE AI';
  static const String appVersion = '1.0.0';

  // ── BLE Device UUIDs ─────────────────────────────────────
  // Limitless Pendant
  static const String limitlessServiceUuid = '632de001-604c-446b-a80f-7963e950f3fb';
  static const String limitlessTxUuid = '632de002-604c-446b-a80f-7963e950f3fb';
  static const String limitlessRxUuid = '632de003-604c-446b-a80f-7963e950f3fb';

  // Omi DevKit2
  static const String omiServiceUuid = '19b10000-e8f2-537e-4f6c-d104768a1214';
  static const String omiRxAudioUuid = '19b10001-e8f2-537e-4f6c-d104768a1214';
  static const String omiTxUuid = '19b10002-e8f2-537e-4f6c-d104768a1214';

  // ── Audio ────────────────────────────────────────────────
  static const int opusSampleRate = 16000;
  static const int opusChannels = 1;
  static const int opusFrameDurationMs = 20;
  static const int minOpusFrameBytes = 10;
  static const int maxOpusFrameBytes = 200;
  static const int bleMtu = 247;

  // ── Reconnection ─────────────────────────────────────────
  static const int wsReconnectBaseMs = 1000;
  static const int wsReconnectMaxMs = 30000;
  static const double wsReconnectMultiplier = 1.5;
  static const int bleReconnectDelayMs = 3000;
  static const int bleReconnectMaxAttempts = 10;

  // ── Notifications ────────────────────────────────────────
  static const String notifChannelId = 'zeke_foreground';
  static const String notifChannelName = 'ZEKE Listening';
  static const String notifTitle = 'ZEKE is listening';
  static const String notifBody = 'Pendant connected • Streaming audio';
}
