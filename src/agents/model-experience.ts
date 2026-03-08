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
    "moonshot/kimi-k2.5-thinking": {
      id: "moonshot/kimi-k2.5-thinking",
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
    "anthropic/claude-4.5-sonnet": {
      id: "anthropic/claude-4.5-sonnet",
      tags: ["expert", "coding", "reasoning"],
      totalUses: 0,
      scores: { frontend: 98, backend: 98, architecture: 98, debugging: 99, creative: 95, coding: 99, general: 95 },
    },
    "anthropic/claude-4.5-opus": {
      id: "anthropic/claude-4.5-opus",
      tags: ["expert", "complex", "research"],
      totalUses: 0,
      scores: { frontend: 95, backend: 99, architecture: 100, debugging: 98, creative: 98, coding: 98, general: 96 },
    },
    "openai/gpt-5.2": {
      id: "openai/gpt-5.2",
      tags: ["vision", "reasoning", "all-rounder"],
      totalUses: 0,
      scores: { frontend: 90, backend: 90, architecture: 92, debugging: 90, creative: 85, coding: 88, general: 95 },
    },
    "minimax/abab-7": {
      id: "minimax/abab-7",
      tags: ["creative", "chinese-optimized"],
      totalUses: 0,
      scores: { frontend: 75, backend: 70, architecture: 65, debugging: 60, creative: 92, coding: 60, general: 80 },
    },
    "deepseek/deepseek-chat": {
      id: "deepseek/deepseek-chat",
      tags: ["fast", "cheap", "logic"],
      totalUses: 0,
      scores: { frontend: 85, backend: 85, architecture: 80, debugging: 85, creative: 70, coding: 85, general: 85 },
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
        if (!stats) {
            return; // Should we auto-add unknown models? Maybe later.
        }

        stats.totalUses++;

        // Simple learning algorithm
        const category = this.detectCategory(taskType);
        const scoreChange = success ? (1 / (1 + retries)) : -2; // +1 if perfect, +0.5 if 1 retry, -2 if failed

        stats.scores[category] = Math.min(100, Math.max(0, (stats.scores[category] || 50) + scoreChange));

        this.save();
    }

    public detectCategory(taskType: string): string {
        const lower = taskType.toLowerCase();

        // Helper to check for whole words or strong indicators (English)
        const has = (word: string) => {
            const regex = new RegExp(`\\b${word}\\b`, 'i');
            return regex.test(lower);
        };

        // Helper for Chinese keywords (no word boundary check needed)
        const hasCN = (word: string) => lower.includes(word);

        // Frontend
        if (has("css") || has("html") || has("react") || has("vue") || has("ui") || has("frontend") || has("dom") ||
            hasCN("前端") || hasCN("界面") || hasCN("样式") || hasCN("网页")) {
            return "frontend";
        }

        // Backend
        if (has("python") || has("node") || has("express") || has("api") || has("sql") || has("db") || has("backend") || has("server") || has("database") ||
            hasCN("后端") || hasCN("服务端") || hasCN("数据库") || hasCN("接口")) {
            return "backend";
        }

        // Architecture / Complex
        if (has("architecture") || has("design") || has("system") || has("complex") || has("plan") || lower.includes("structure") ||
            hasCN("架构") || hasCN("设计") || hasCN("方案") || hasCN("系统")) {
            return "architecture";
        }

        // Debugging
        if (has("debug") || has("fix") || has("bug") || has("issue") || has("crash") || has("exception") || has("error") || has("trace") || has("stack") ||
            hasCN("调试") || hasCN("报错") || hasCN("错误") || hasCN("修复") || hasCN("异常") || hasCN("崩溃") || hasCN("排查")) {
            return "debugging";
        }

        // Creative / Writing
        if (has("write") || has("story") || has("creative") || has("generate") || has("draft") || has("novel") ||
            hasCN("写作") || hasCN("故事") || hasCN("小说") || hasCN("文案") || hasCN("扩写") || hasCN("创作")) {
            return "creative";
        }

        // General Coding (fallback)
        if (has("code") || has("function") || has("ts") || has("js") || has("script") ||
            hasCN("代码") || hasCN("脚本") || hasCN("编程") || hasCN("写一段") || hasCN("实现")) {
            return "coding";
        }

        return "general";
    }
}

export const modelExperience = new ModelExperienceEngine();
