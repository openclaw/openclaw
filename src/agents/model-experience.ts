import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../utils.js";

const EXPERIENCE_FILE = "model_experience.json";

export interface ModelScore {
    coding: number;
    general: number;
    [category: string]: number;
}

export interface ModelStats {
    id: string;
    tags: string[];
    totalUses: number;
    scores: ModelScore;
}

export interface TaskRecord {
    id: string;
    timestamp: number;
    taskType: string;
    modelId: string;
    success: boolean;
    retries: number;
}

export interface ExperienceData {
    models: Record<string, ModelStats>;
    recentTasks: TaskRecord[];
}

const DEFAULT_EXPERIENCE: ExperienceData = {
    models: {
        "google/gemini-3-pro-preview": {
            id: "google/gemini-3-pro-preview",
            tags: ["expert", "complex", "creative"],
            totalUses: 0,
            scores: { frontend: 85, backend: 95, architecture: 98, debugging: 90, creative: 95, coding: 92, general: 100 },
        },
        "moonshot/kimi-k2-thinking": {
            id: "moonshot/kimi-k2-thinking",
            tags: ["coding", "logic"],
            totalUses: 0,
            scores: { frontend: 92, backend: 96, architecture: 85, debugging: 98, creative: 80, coding: 95, general: 80 },
        },
        "moonshot/kimi-k2.5": {
            id: "moonshot/kimi-k2.5",
            tags: ["coding", "logic"],
            totalUses: 0,
            scores: { frontend: 90, backend: 92, architecture: 80, debugging: 90, creative: 75, coding: 92, general: 80 },
        },
        "google/gemini-3-flash-preview": {
            id: "google/gemini-3-flash-preview",
            tags: ["fast", "simple", "crud"],
            totalUses: 0,
            scores: { frontend: 88, backend: 75, architecture: 60, debugging: 70, creative: 85, coding: 70, general: 85 },
        },
    },
    recentTasks: [],
};

export class ModelExperienceEngine {
    private data: ExperienceData;
    private filePath: string;

    constructor() {
        this.filePath = path.join(CONFIG_DIR, EXPERIENCE_FILE);
        this.data = this.load();
    }

    private load(): ExperienceData {
        if (!fs.existsSync(this.filePath)) {
            return JSON.parse(JSON.stringify(DEFAULT_EXPERIENCE));
        }
        try {
            const content = fs.readFileSync(this.filePath, "utf-8");
            return { ...DEFAULT_EXPERIENCE, ...JSON.parse(content) }; // Merge with default to ensure new models exist
        } catch (error) {
            console.warn("Failed to load model experience, using defaults:", error);
            return JSON.parse(JSON.stringify(DEFAULT_EXPERIENCE));
        }
    }

    private save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
        } catch (error) {
            console.error("Failed to save model experience:", error);
        }
    }

    public getModelStats(modelId: string): ModelStats | undefined {
        // Normalize IDs locally if needed, but for now exact match
        return this.data.models[modelId];
    }

    public getAllModels(): ModelStats[] {
        return Object.values(this.data.models);
    }

    public recordTask(taskType: string, modelId: string, success: boolean, retries: number = 0) {
        const record: TaskRecord = {
            id: Date.now().toString(),
            timestamp: Date.now(),
            taskType,
            modelId,
            success,
            retries,
        };

        // Keep last 100 tasks
        this.data.recentTasks.unshift(record);
        if (this.data.recentTasks.length > 100) {
            this.data.recentTasks = this.data.recentTasks.slice(0, 100);
        }

        // Update Scores
        const stats = this.data.models[modelId];
        if (!stats) return; // Should we auto-add unknown models? Maybe later.

        stats.totalUses++;

        // Simple learning algorithm
        const category = this.detectCategory(taskType);
        const scoreChange = success ? (1 / (1 + retries)) : -2; // +1 if perfect, +0.5 if 1 retry, -2 if failed

        stats.scores[category] = Math.min(100, Math.max(0, (stats.scores[category] || 50) + scoreChange));

        this.save();
    }

    public detectCategory(taskType: string): string {
        const lower = taskType.toLowerCase();

        // Frontend
        if (lower.includes("css") || lower.includes("html") || lower.includes("react") || lower.includes("vue") || lower.includes("ui") || lower.includes("frontend")) return "frontend";

        // Backend
        if (lower.includes("python") || lower.includes("node") || lower.includes("express") || lower.includes("api") || lower.includes("sql") || lower.includes("db") || lower.includes("backend")) return "backend";

        // Architecture / Complex
        if (lower.includes("architecture") || lower.includes("design") || lower.includes("system") || lower.includes("complex") || lower.includes("plan")) return "architecture";

        // Debugging
        if (lower.includes("debug") || lower.includes("fix") || lower.includes("error") || lower.includes("bug") || lower.includes("log")) return "debugging";

        // Creative / Writing
        if (lower.includes("write") || lower.includes("story") || lower.includes("creative") || lower.includes("generate")) return "creative";

        // General Coding (fallback)
        if (lower.includes("code") || lower.includes("function") || lower.includes("ts") || lower.includes("js")) return "coding";

        return "general";
    }
}

export const modelExperience = new ModelExperienceEngine();
