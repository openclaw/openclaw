/**
 * Auto-detect Local LLM Configuration
 */
export async function detectLocalLLMs(config = {}) {
    const cfg = {
        ollamaBaseUrl: "http://127.0.0.1:11434",
        minContextWindow: 4096,
        preferredModels: ["kimi-k2.5", "deepseek-r1", "llama3.1", "phi4", "qwen2.5"],
        ...config,
    };
    const detected = [];
    try {
        const ollamaModels = await detectOllamaModels(cfg);
        detected.push(...ollamaModels);
    }
    catch {
        // Ollama not available
    }
    return sortByRecommendation(detected, cfg.preferredModels);
}
async function detectOllamaModels(config) {
    const response = await fetch(`${config.ollamaBaseUrl}/api/tags`);
    if (!response.ok) {
        throw new Error("Ollama not available");
    }
    const data = await response.json();
    const models = [];
    for (const model of data.models || []) {
        const details = analyzeModel(model.name, model.size);
        if (details.contextWindow >= config.minContextWindow) {
            models.push({
                provider: "ollama",
                model: model.name,
                size: Math.round((model.size / 1e9) * 10) / 10,
                contextWindow: details.contextWindow,
                recommended: details.recommended,
                reason: details.reason,
            });
        }
    }
    return models;
}
function analyzeModel(name, sizeBytes) {
    const sizeGB = sizeBytes / 1e9;
    if (name.includes("kimi") || name.includes("k2.5")) {
        return {
            contextWindow: 256000,
            recommended: sizeGB > 8,
            reason: "Excellent reasoning, large context",
        };
    }
    if (name.includes("deepseek") && name.includes("r1")) {
        return {
            contextWindow: name.includes("32b") ? 128000 : 65536,
            recommended: true,
            reason: "Strong reasoning, great for coding",
        };
    }
    if (name.includes("llama3.1")) {
        const size = name.includes("70b") ? 70 : name.includes("8b") ? 8 : 405;
        return {
            contextWindow: 128000,
            recommended: size >= 8,
            reason: "Reliable, well-tested",
        };
    }
    if (name.includes("phi4") || name.includes("phi-4")) {
        return {
            contextWindow: 16000,
            recommended: true,
            reason: "Fast, efficient, high quality",
        };
    }
    if (name.includes("qwen2.5")) {
        return {
            contextWindow: 32768,
            recommended: true,
            reason: "Good multilingual support",
        };
    }
    return {
        contextWindow: estimateContextWindow(sizeGB),
        recommended: sizeGB >= 4,
        reason: `Size: ${sizeGB.toFixed(1)}GB`,
    };
}
function estimateContextWindow(sizeGB) {
    if (sizeGB > 40) {
        return 128000;
    }
    if (sizeGB > 20) {
        return 65536;
    }
    if (sizeGB > 10) {
        return 32768;
    }
    if (sizeGB > 5) {
        return 16000;
    }
    return 8192;
}
function sortByRecommendation(models, preferred) {
    return models.toSorted((a, b) => {
        if (a.recommended !== b.recommended) {
            return a.recommended ? -1 : 1;
        }
        const aPref = preferred.findIndex((p) => a.model.includes(p));
        const bPref = preferred.findIndex((p) => b.model.includes(p));
        if (aPref !== -1 || bPref !== -1) {
            if (aPref === -1) {
                return 1;
            }
            if (bPref === -1) {
                return -1;
            }
            return aPref - bPref;
        }
        return b.contextWindow - a.contextWindow;
    });
}
export async function selectBestLLM(purpose = "compression") {
    const models = await detectLocalLLMs();
    if (models.length === 0) {
        return null;
    }
    if (purpose === "compression") {
        const fastModels = models.filter((m) => m.model.includes("phi") || m.model.includes("llama3.1:8b") || m.size < 15);
        return fastModels[0] || models[0];
    }
    if (purpose === "analysis") {
        return models.toSorted((a, b) => b.contextWindow - a.contextWindow)[0];
    }
    return models.find((m) => m.recommended) || models[0];
}
export async function generateConfig() {
    const detected = await detectLocalLLMs();
    const best = await selectBestLLM("compression");
    if (!best) {
        return {
            enabled: true,
            compression: "rules",
            engines: {
                local: {
                    provider: "rules",
                    model: "none",
                },
            },
            detected: [],
        };
    }
    return {
        enabled: true,
        compression: "auto",
        engines: {
            local: {
                provider: best.provider,
                model: best.model,
                baseUrl: best.provider === "ollama" ? "http://127.0.0.1:11434" : undefined,
            },
        },
        detected,
    };
}
//# sourceMappingURL=auto-detect-llm.js.map