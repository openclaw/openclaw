// Ollama Warm-keep — idle-only keepalive to prevent cold starts
// Phase 4.2: Only send keepalive when idle > 3min, don't steal GPU from real requests

const IDLE_THRESHOLD_MS = 180_000; // 3 minutes
const CHECK_INTERVAL_MS = 240_000; // 4 minutes

class OllamaKeepalive {
  constructor(options = {}) {
    this.ollamaUrl = options.ollamaUrl || "http://localhost:11434";
    this.model = options.model || "qwen2.5-coder:7b";
    this.lastRealRequest = Date.now();
    this._interval = null;
    this.keepaliveCount = 0;
    this.skippedCount = 0;
  }

  /** Call this on every real request to update idle timer */
  touch() {
    this.lastRealRequest = Date.now();
  }

  start() {
    if (this._interval) {
      return;
    }

    this._interval = setInterval(() => {
      const idleMs = Date.now() - this.lastRealRequest;
      if (idleMs > IDLE_THRESHOLD_MS) {
        void this._sendKeepalive();
      } else {
        this.skippedCount++;
      }
    }, CHECK_INTERVAL_MS);

    // Don't prevent process exit
    if (this._interval.unref) {
      this._interval.unref();
    }

    console.log("[keepalive] started: idle-only mode, check every 4min");
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  async _sendKeepalive() {
    try {
      // Minimal generation to keep model loaded in GPU memory
      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt: "hi",
          stream: false,
          options: { num_predict: 1 },
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        this.keepaliveCount++;
        console.log(`[keepalive] warm-keep sent (count=${this.keepaliveCount})`);
      }
    } catch (e) {
      // Keepalive failure is not critical
      console.warn("[keepalive] failed:", e.message);
    }
  }

  getStats() {
    return {
      keepaliveCount: this.keepaliveCount,
      skippedCount: this.skippedCount,
      lastRealRequest: this.lastRealRequest,
      idleMs: Date.now() - this.lastRealRequest,
    };
  }
}

module.exports = { OllamaKeepalive };
