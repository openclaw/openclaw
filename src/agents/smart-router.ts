import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../utils.js";
import { modelExperience, ModelExperienceEngine } from "./model-experience.js";

const USAGE_STATS_FILE = "usage-stats.json";
const ROUTER_CONFIG_FILE = "router_config.json";

interface ModelUsage {
    requests: number;
    inputTokens: number;
    outputTokens: number;
}

interface UsageStats {
    date: string;
    models: Record<string, ModelUsage>;
}

interface RouterConfig {
    strategies: {
        context_waterline: {
            default_limit: number;
            models: Record<string, number>;
        };
        circuit_breaker: {
            enabled: boolean;
            max_retries: number;
            fallback_chain: string[];
        };
    };
    routes: {
        task_type: string;
        priority_chain: string[];
    }[];
}

export class SmartRouter {
    private experience: ModelExperienceEngine;
    private usageFilePath: string;
    private configFilePath: string;
    private config: RouterConfig | null = null;

    constructor() {
        this.experience = modelExperience;
        this.usageFilePath = path.join(CONFIG_DIR, USAGE_STATS_FILE);
        this.configFilePath = path.join(CONFIG_DIR, ROUTER_CONFIG_FILE);
        this.loadConfig();
    }

    private loadConfig(): void {
        // [Hotfix 15:08] Forced update for CI synchronization
        if (fs.existsSync(this.configFilePath)) {
            try {
                const content = fs.readFileSync(this.configFilePath, "utf-8");
                this.config = JSON.parse(content) as RouterConfig;
            } catch (e: unknown) {
                const error = e instanceof Error ? e.message : String(e);
                console.warn(`Failed to load router config: ${error}`);
            }
        }
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
                    // Compatible with old simple number format
                    if (content.models) {
                        for (const key in content.models) {
                            if (typeof content.models[key] === 'number') {
                                content.models[key] = { requests: content.models[key], inputTokens: 0, outputTokens: 0 };
                            }
                        }
                    }
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
            if (!fs.existsSync(CONFIG_DIR)) {
                fs.mkdirSync(CONFIG_DIR, { recursive: true });
            }
            fs.writeFileSync(this.usageFilePath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error("Failed to save usage stats:", e);
        }
    }

    public incrementUsage(modelId: string, inputTokens = 0, outputTokens = 0): void {
        const stats = this.loadUsage();
        if (!stats.models[modelId]) {
            stats.models[modelId] = { requests: 0, inputTokens: 0, outputTokens: 0 };
        }
        stats.models[modelId].requests += 1;
        // [Xiao Ke Fix] Ensure tokens are added even if 0 is reported (fallback calculation later)
        stats.models[modelId].inputTokens += (inputTokens || 0);
        stats.models[modelId].outputTokens += (outputTokens || 0);
        this.saveUsage(stats);
    }

    public getUsage(modelId: string): ModelUsage {
        const stats = this.loadUsage();
        return stats.models[modelId] || { requests: 0, inputTokens: 0, outputTokens: 0 };
    }

    public shouldConservePro(): boolean {
        // Simple heuristic: if requests > 240, start conserving
        const usage = this.getUsage("google/gemini-3-pro-preview");
        return usage.requests >= 240;
    }

    public cleanupPrompt(prompt: string): string {
        const lower = prompt.trim().toLowerCase();
        const prefixes = [
            "!kimi", "kimi:", "kimi：",
            "!flash", "flash:", "flash：",
            "!pro", "pro:", "pro：",
            "!deepseek", "deepseek:", "deepseek：",
            "!gemini", "gemini:", "gemini："
        ];

        for (const prefix of prefixes) {
            if (lower.startsWith(prefix)) {
                let cleaned = prompt.trim().slice(prefix.length);
                cleaned = cleaned.replace(/^[:：\s]+/, "");
                return cleaned.trim();
            }
        }
        return prompt;
    }

    public selectModel(taskDescription: string, contextTokens: number = 0): string {
        // Reload config on every request to allow hot-swapping
        this.loadConfig();

        const lowerTask = taskDescription.toLowerCase();

        // 1. Manual Overrides (Highest Priority)
        if (lowerTask.startsWith("!kimi") || lowerTask.startsWith("kimi:") || lowerTask.startsWith("kimi：")) {
            return "moonshot/kimi-k2.5-thinking";
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

        // 2. Determine Task Category
        const category = this.experience.detectCategory(taskDescription);
        
        // 3. Resolve Priority Chain from Config
        let chain: string[] = ["google/gemini-3-flash-preview"]; // Default fallback
        if (this.config) {
            const route = this.config.routes.find(r => r.task_type === category) || 
                          this.config.routes.find(r => r.task_type === "default");
            if (route) {
                chain = route.priority_chain;
            }
        }

        // 4. Waterline Filtering
        const validModels = chain.filter(modelId => {
            if (!this.config) {
                return true;
            }
            const limit = this.config.strategies.context_waterline.models[modelId] || 
                          this.config.strategies.context_waterline.default_limit;
            return contextTokens < limit;
        });

        // 5. Select Best Available
        return validModels.length > 0 ? validModels[0] : "google/gemini-3-flash-preview";
    }
}

export const smartRouter = new SmartRouter();
