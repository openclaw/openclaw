const CHECK_INTERVAL_MS = 3e4;
function startStaleCallReaper(params) {
  const maxAgeSeconds = params.staleCallReaperSeconds;
  if (!maxAgeSeconds || maxAgeSeconds <= 0) {
    return null;
  }
  const maxAgeMs = maxAgeSeconds * 1e3;
  const interval = setInterval(() => {
    const now = Date.now();
    for (const call of params.manager.getActiveCalls()) {
      const age = now - call.startedAt;
      if (age > maxAgeMs) {
        console.log(
          `[voice-call] Reaping stale call ${call.callId} (age: ${Math.round(age / 1e3)}s, state: ${call.state})`
        );
        void params.manager.endCall(call.callId).catch((err) => {
          console.warn(`[voice-call] Reaper failed to end call ${call.callId}:`, err);
        });
      }
    }
  }, CHECK_INTERVAL_MS);
  return () => {
    clearInterval(interval);
  };
}
export {
  startStaleCallReaper
};
