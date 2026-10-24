export function resolveColdLoadLatency(input: {
  profile?: string;
  latencyMs?: string;
  frameGapMs?: string;
  connectNotBeforeMs?: string;
  methodLatencyMs: string[];
  sidebarQueryLatencyMs: string[];
}) {
  // These are browser delivery floors, not isolated server or network timings.
  const profiles = {
    default: { latencyMs: 35, frameGapMs: 4, connectNotBeforeMs: 0, methodLatencyMs: {} },
    "legacy-handshake": {
      latencyMs: 20,
      frameGapMs: 0,
      connectNotBeforeMs: 340,
      methodLatencyMs: { connect: 220, "sessions.resolve": 195, "sessions.describe": 195 },
    },
    "live-fast": {
      latencyMs: 20,
      frameGapMs: 0,
      connectNotBeforeMs: 439,
      methodLatencyMs: {
        connect: 41,
        "chat.startup": 220,
        "sessions.resolve": 216,
        "sessions.describe": 149,
        "sessions.list": 195,
        "sessions.subscribe": 117,
        "sessions.messages.subscribe": 183,
        "board.get": 189,
        "users.list": 144,
        "agents.list": 149,
        "agent.identity.get": 150,
        "plugins.controlUi.list": 125,
        "cron.list": 165,
        "workboard.boards.list": 141,
      },
    },
  };
  const profile = input.profile ?? "default";
  const selected = Object.entries(profiles).find(([name]) => name === profile)?.[1];
  if (!selected) {
    throw new Error("Expected latency-profile default, legacy-handshake or live-fast");
  }
  const methodLatencyMs: Record<string, number> = { ...selected.methodLatencyMs };
  const sidebarQueryLatencyMs: Record<string, number> = {};
  for (const [entries, target] of [
    [input.methodLatencyMs, methodLatencyMs],
    [input.sidebarQueryLatencyMs, sidebarQueryLatencyMs],
  ] as const) {
    for (const value of entries) {
      const [method, delay, ...extra] = value.split("=");
      const milliseconds = Number(delay);
      if (
        !method ||
        delay === undefined ||
        extra.length ||
        !Number.isFinite(milliseconds) ||
        milliseconds < 0
      ) {
        throw new Error("Expected method-latency-ms method=nonnegative-milliseconds");
      }
      target[method] = milliseconds;
    }
  }
  return {
    latencyProfile: profile,
    latencyMs: Number(input.latencyMs ?? selected.latencyMs),
    frameGapMs: Number(input.frameGapMs ?? selected.frameGapMs),
    connectNotBeforeMs: Number(input.connectNotBeforeMs ?? selected.connectNotBeforeMs),
    methodLatencyMs,
    sidebarQueryLatencyMs,
  };
}
