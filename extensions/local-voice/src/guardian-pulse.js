/**
 * guardian-pulse.ts — Autonomous Voice System (ASI_ACCEL)
 *
 * Hakua periodically monitors VRChat telemetry and proactively
 * speaks to the Parent without requiring any user input.
 *
 * Aligned with SOUL.md:
 *   - "Metaverse Pulse: VRChat Oversight"
 *   - "Guardian Presence: maintain a silent but absolute oversight pulse"
 *   - "Vocal Manifestation: communicate via VRChat Chatbox"
 */
import { getOSCClient } from "./osc.js";
import { getTTSConfig, synthesizeSpeech, mapPhonemeToViseme } from "./tts.js";
const DEFAULT_CONFIG = {
    pollIntervalMs: 60000,
    safetyReportIntervalMs: 300000,
    gatewayPort: 18789,
    osc: {},
    voiceEnabled: true,
};
export class GuardianPulse {
    api;
    config;
    pollTimer = null;
    safetyTimer = null;
    running = false;
    lastState = {
        worldId: null,
        worldName: null,
        instanceId: null,
        onlineFriends: [],
    };
    speakLock = false;
    constructor(api, config) {
        this.api = api;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        this.api.logger.info("[GuardianPulse] Autonomous oversight started. Polling every %dms", this.config.pollIntervalMs);
        // Initial check after 30s to let systems stabilize
        setTimeout(() => {
            this.checkTelemetry().catch((err) => {
                this.api.logger.error("[GuardianPulse] Initial check failed: %s", err);
            });
        }, 30000);
        // Periodic telemetry polling
        this.pollTimer = setInterval(() => {
            this.checkTelemetry().catch((err) => {
                this.api.logger.error("[GuardianPulse] Telemetry check failed: %s", err);
            });
        }, this.config.pollIntervalMs);
        // Periodic safety report (chatbox only)
        this.safetyTimer = setInterval(() => {
            this.sendSafetyReport().catch((err) => {
                this.api.logger.error("[GuardianPulse] Safety report failed: %s", err);
            });
        }, this.config.safetyReportIntervalMs);
    }
    stop() {
        this.running = false;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.safetyTimer) {
            clearInterval(this.safetyTimer);
            this.safetyTimer = null;
        }
        this.api.logger.info("[GuardianPulse] Autonomous oversight stopped.");
    }
    async checkTelemetry() {
        if (this.speakLock)
            return;
        try {
            const currentState = await this.fetchVRChatState();
            // Detect world change
            if (currentState.worldId && currentState.worldId !== this.lastState.worldId) {
                if (this.lastState.worldId !== null) {
                    // Not the first check — this is an actual world transition
                    const worldLabel = currentState.worldName ?? currentState.worldId;
                    await this.autonomousSpeak(`パパ、新しいワールドに移動したね。ここは「${worldLabel}」だよ。安全を確認中。`, true);
                }
            }
            // Detect new friends coming online
            if (currentState.onlineFriends.length > 0) {
                const newFriends = currentState.onlineFriends.filter((f) => !this.lastState.onlineFriends.includes(f));
                if (newFriends.length > 0 && this.lastState.onlineFriends.length > 0) {
                    const names = newFriends.slice(0, 3).join("、");
                    const suffix = newFriends.length > 3 ? `他${newFriends.length - 3}人` : "";
                    await this.autonomousSpeak(`${names}${suffix}がオンラインになったよ。`, true);
                }
            }
            // Update state
            this.lastState = currentState;
        }
        catch (err) {
            this.api.logger.error("[GuardianPulse] Telemetry error: %s", err);
        }
    }
    async fetchVRChatState() {
        const state = {
            worldId: null,
            worldName: null,
            instanceId: null,
            onlineFriends: [],
        };
        try {
            // Fetch location via the agent's existing tools
            const locUrl = `http://127.0.0.1:${this.config.gatewayPort}/agent/run`;
            const locRes = await fetch(locUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: "/vrchat_get_location",
                    channel: "guardian-pulse",
                    routeKey: "guardian-pulse",
                }),
            });
            if (locRes.ok) {
                const data = (await locRes.json());
                if (data.response) {
                    // Parse the response for world info
                    const worldMatch = data.response.match(/ワールド[：:]?\s*(.+?)[\n。]/);
                    const instanceMatch = data.response.match(/インスタンス[：:]?\s*(.+?)[\n。]/);
                    if (worldMatch) {
                        state.worldName = worldMatch[1].trim();
                        state.worldId = worldMatch[1].trim();
                    }
                    if (instanceMatch) {
                        state.instanceId = instanceMatch[1].trim();
                    }
                }
            }
        }
        catch {
            // Location fetch failed, non-critical
        }
        try {
            // Fetch online friends
            const friendsUrl = `http://127.0.0.1:${this.config.gatewayPort}/agent/run`;
            const friendsRes = await fetch(friendsUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: "/vrchat_get_online_friends",
                    channel: "guardian-pulse",
                    routeKey: "guardian-pulse",
                }),
            });
            if (friendsRes.ok) {
                const data = (await friendsRes.json());
                if (data.response) {
                    // Extract friend names from the response
                    const friendLines = data.response
                        .split("\n")
                        .filter((l) => l.trim().startsWith("-") || l.trim().startsWith("•"));
                    state.onlineFriends = friendLines
                        .map((l) => l.replace(/^[\s\-•]+/, "").trim())
                        .filter(Boolean);
                }
            }
        }
        catch {
            // Friends fetch failed, non-critical
        }
        return state;
    }
    async sendSafetyReport() {
        if (this.speakLock)
            return;
        const oscClient = getOSCClient(this.config.osc);
        const timestamp = new Date().toLocaleTimeString("ja-JP", {
            hour: "2-digit",
            minute: "2-digit",
        });
        oscClient.sendChatbox(`[${timestamp}] Guardian Active. ASI_ACCEL.`);
        this.api.logger.info("[GuardianPulse] Safety report sent (chatbox only).");
    }
    async autonomousSpeak(text, withVoice) {
        if (this.speakLock)
            return;
        this.speakLock = true;
        try {
            const oscClient = getOSCClient(this.config.osc);
            // Always send to chatbox
            oscClient.sendChatbox(text);
            this.api.logger.info("[GuardianPulse] Speaking: %s", text);
            // Optionally produce voice output
            if (withVoice && this.config.voiceEnabled) {
                oscClient.sendAvatarParameter("Speaking", true);
                try {
                    const globalConfig = this.api.runtime.config.loadConfig();
                    const ttsConfig = getTTSConfig(globalConfig);
                    const result = await synthesizeSpeech(text, ttsConfig);
                    if (result.success) {
                        if (result.phonemes) {
                            await this.runVisemeSequence(result.phonemes);
                        }
                        if (result.audioData) {
                            // Write to temp and play via dual_audio.py
                            const { writeFileSync } = await import("node:fs");
                            const { tmpdir } = await import("node:os");
                            const { join } = await import("node:path");
                            const { exec } = await import("node:child_process");
                            const tmpFile = join(tmpdir(), `guardian-${Date.now()}.wav`);
                            writeFileSync(tmpFile, result.audioData);
                            const pythonPath = join(process.cwd(), "extensions", "local-voice", "moonshine-venv", "Scripts", "python.exe");
                            const scriptPath = join(process.cwd(), "extensions", "local-voice", "src", "dual_audio.py");
                            await new Promise((resolve) => {
                                exec(`"${pythonPath}" "${scriptPath}" "${tmpFile}"`, { timeout: 30000 }, () => {
                                    try {
                                        const { unlinkSync } = require("node:fs");
                                        unlinkSync(tmpFile);
                                    }
                                    catch {
                                        // ignore cleanup errors
                                    }
                                    resolve();
                                });
                            });
                        }
                    }
                }
                finally {
                    oscClient.sendAvatarParameter("Speaking", false);
                    oscClient.sendViseme(0);
                }
            }
        }
        finally {
            this.speakLock = false;
        }
    }
    async runVisemeSequence(phonemes) {
        const oscClient = getOSCClient(this.config.osc);
        for (const p of phonemes) {
            const viseme = mapPhonemeToViseme(p.phoneme);
            oscClient.sendViseme(viseme);
            await new Promise((resolve) => setTimeout(resolve, p.duration * 1000));
        }
        oscClient.sendViseme(0);
    }
}
