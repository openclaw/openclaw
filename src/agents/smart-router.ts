import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../utils.js";
import { modelExperience, ModelExperienceEngine } from "./model-experience.js";

const USAGE_STATS_FILE = "usage-stats.json";
const GEMINI_PRO_LIMIT = 160;

interface UsageStats {
    date: string;
    models: Record<string, number>;
}

export class SmartRouter {
    private experience: ModelExperienceEngine;
    private usageFilePath: string;

    constructor() {
        this.experience = modelExperience;
        this.usageFilePath = path.join(CONFIG_DIR, USAGE_STATS_FILE);
    }

    private getTodayDate(): string {
        return new Date().toISOString().split("T")[0];
    }

    private loadUsage(): UsageStats {
        const today = this.getTodayDate();
        let data: UsageStats = { date: today, models: {} };

        if (fs.existsSync(this.usageFilePath)) {
            try {
                const content = JSON.parse(fs.readFileSync(this.usageFilePath, "utf-8"));
                if (content.date === today) {
                    data = content;
                }
            } catch (e) {
                console.warn("Failed to load usage stats, resetting.");
            }
        }
        return data;
    }

    private saveUsage(data: UsageStats) {
        try {
            fs.writeFileSync(this.usageFilePath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error("Failed to save usage stats:", e);
        }
    }

    public incrementUsage(modelId: string) {
        const stats = this.loadUsage();
        stats.models[modelId] = (stats.models[modelId] || 0) + 1;
        this.saveUsage(stats);
    }

    public getUsage(modelId: string): number {
        return this.loadUsage().models[modelId] || 0;
    }

    public shouldConservePro(): boolean {
        const usage = this.getUsage("google/gemini-3-pro-preview");
        return usage >= GEMINI_PRO_LIMIT;
    }

    public cleanupPrompt(prompt: string): string {
        const lower = prompt.trim().toLowerCase();
        // Standardize prefixes to remove: both !prefix and prefix:
        const prefixes = [
            "!kimi", "kimi:", "kimi：",
            "!flash", "flash:", "flash：",
            "!pro", "pro:", "pro：",
            "!deepseek", "deepseek:", "deepseek：",
            "!gemini", "gemini:", "gemini："
        ];

        for (const prefix of prefixes) {
            if (lower.startsWith(prefix)) {
                // Remove prefix
                let cleaned = prompt.trim().slice(prefix.length);
                // Remove optional following colon (En/Cn) or whitespace if not already consumed by prefix
                cleaned = cleaned.replace(/^[:：\s]+/, "");
                return cleaned.trim();
            }
        }
        return prompt;
    }

    public selectModel(taskDescription: string, defaultModelId?: string): string {
        const lowerTask = taskDescription.toLowerCase();

        // --- 0. Explicit Override (User Force Selection) ---
        // Supports prefixes like !kimi, kimi:, !flash, flash:
        if (lowerTask.startsWith("!kimi") || lowerTask.startsWith("kimi:") || lowerTask.startsWith("kimi：")) {
            return "moonshot/kimi-k2-thinking";
        }
        if (lowerTask.startsWith("!flash") || lowerTask.startsWith("flash:") || lowerTask.startsWith("flash：")) {
            return "google/gemini-3-flash-preview";
        }
        if (lowerTask.startsWith("!pro") || lowerTask.startsWith("pro:") || lowerTask.startsWith("pro：")) {
            return "google/gemini-3-pro-preview";
        }
        if (lowerTask.startsWith("!deepseek") || lowerTask.startsWith("deepseek:") || lowerTask.startsWith("deepseek：")) {
            return "deepseek/deepseek-chat";
        }

        const category = this.experience.detectCategory(taskDescription);
        const conservePro = this.shouldConservePro();

        // --- Hybrid Routing Logic ---

        // 1. Maturity Check: Do we have enough data? (Threshold: 10 uses total across system for now, or per model?)
        // Let's check if we have a "Champion" for this category
        let championId: string | undefined;
        let maxScore = -1;

        const allModels = this.experience.getAllModels();
        for (const model of allModels) {
            // Only consider models with some usage to avoid random noise, unless it's a cold start
            if (model.totalUses > 5) {
                const score = model.scores[category] || 0;
                if (score > maxScore && score >= 80) { // Only high-quality models
                    maxScore = score;
                    championId = model.id;
                }
            }
        }

        // 2. Data-Driven Decision (if not conserving Pro, or if champion is NOT Pro)
        // If we need to conserve Pro, we skip it unless it's the ONLY choice (which it rarely is)
        if (championId) {
            if (championId === "google/gemini-3-pro-preview" && conservePro) {
                // Fallthrough to rules if Pro is champion but limited
            } else {
                // We have a winner based on experience!
                return championId;
            }
        }

        // 3. Rule-Based Fallback (Cold Start / No Clear Winner / Pro Limited)

        // Urgent/Architecture -> Pro (if quota allows)
        if (category === "architecture" || category === "creative") {
            const proUsage = this.getUsage("google/gemini-3-pro-preview");
            // Relaxed limit for Urgent tasks
            if (proUsage < 250) {
                return "google/gemini-3-pro-preview";
            }
        }

        // Coding/Debugging -> Kimi K2 Thinking (High Logic)
        if (category === "backend" || category === "debugging" || category === "coding") {
            return "moonshot/kimi-k2-thinking";
        }

        // Frontend -> Kimi is good, but maybe Flash is enough? Let's stick to Kimi for now for better quality
        if (category === "frontend") {
            return "moonshot/kimi-k2.5"; // Use non-thinking for frontend maybe? Or thinking? User likes quality.
        }

        // Simple/General -> Flash (Daily Driver)
        if (category === "general" || lowerTask.includes("simple") || lowerTask.includes("translate") || lowerTask.includes("weather")) {
            return "google/gemini-3-flash-preview";
        }

        // Default Fallback to Flash (User Preference)
        if (conservePro) {
            return "google/gemini-3-flash-preview";
        }

        // If no specific category matched, default to Flash
        return "google/gemini-3-flash-preview";
    }
}

export const smartRouter = new SmartRouter();
