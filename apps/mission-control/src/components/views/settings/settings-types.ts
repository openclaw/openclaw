// ============================================================================
// Settings Types & Constants (shared across all settings sections)
// ============================================================================

export interface GatewayModel {
    id: string;
    name?: string;
    provider?: string;
    description?: string;
}

export interface ModelsResponse {
    models: GatewayModel[];
    byProvider: Record<string, GatewayModel[]>;
    providers: string[];
    defaultModel?: string;
    defaultProvider?: string;
}

export interface GatewayNode {
    id?: string;
    nodeId?: string;
    status?: string;
    health?: string;
    description?: string;
}

export interface ApiKeyResponse {
    id: string;
    provider: string;
    label: string;
    key_preview: string;
    base_url: string | null;
    is_active: boolean;
    last_tested_at: string | null;
    last_test_status: string | null;
    created_at: string;
}

export interface LocalModelResponse {
    id: string;
    name: string;
    model_id: string;
    base_url: string;
    is_active: boolean;
    status: string;
    created_at: string;
}

export interface OllamaModel {
    name: string;
    size: string;
    modified_at: string;
}

export interface LocalModelsData {
    models: LocalModelResponse[];
    ollamaAvailable: boolean;
    ollamaModels: OllamaModel[];
}

export type ThemeMode = "light" | "dark" | "system";

export interface AppSettings {
    theme: ThemeMode;
    gatewayUrl: string;
    gatewayToken: string;
    defaultSessionKey: string;
    autoConnect: boolean;
    notifications: {
        enabled: boolean;
        sound: boolean;
        taskComplete: boolean;
        taskError: boolean;
        mentions: boolean;
    };
    session: {
        autoSave: boolean;
        autoSaveInterval: number;
        maxHistoryItems: number;
        compactMode: boolean;
    };
    // Model preference (canonical source — also persisted via MODEL_PREF_KEY)
    modelPreference: {
        provider: string;
        model: string;
    } | null;
}

export interface RiskLevelConfig {
    authRequired: boolean;
    csrfEnabled: boolean;
    rateLimitMultiplier: number;
    autoDispatch: boolean;
    approvalMode: "all" | "dangerous" | "none";
    activityLogging: boolean;
    agentTimeoutMs: number;
}

export type RiskLevel = "low" | "medium" | "high" | "insane" | "freedom";

export interface RiskLevelResponse {
    level: RiskLevel;
    config: RiskLevelConfig;
    availableLevels: RiskLevel[];
}

export interface ModelPreference {
    provider: string;
    model: string;
}

export type ProviderStatus = "active" | "error" | "untested" | "missing" | "expired";

export interface ProviderCreditInfo {
    provider: string;
    balance: number | null;
    currency: string;
    limit_total: number | null;
    usage_total: number | null;
    last_checked_at: string | null;
}

// --- Constants ---

export const MODEL_PREF_KEY = "openclaw_model_pref";

export const DEFAULT_SETTINGS: AppSettings = {
    theme: "system",
    gatewayUrl: "",
    gatewayToken: "",
    defaultSessionKey: "main",
    autoConnect: true,
    notifications: {
        enabled: true,
        sound: true,
        taskComplete: true,
        taskError: true,
        mentions: true,
    },
    session: {
        autoSave: true,
        autoSaveInterval: 5,
        maxHistoryItems: 100,
        compactMode: false,
    },
    modelPreference: null,
};

export const PROVIDER_LABELS: Record<string, string> = {
    anthropic: "Anthropic",
    "google-antigravity": "Antigravity OAuth",
    google: "Google AI (Gemini)",
    openai: "OpenAI",
    "openai-codex": "OpenAI Codex",
    xai: "xAI (Grok)",
    openrouter: "OpenRouter",
    groq: "Groq",
    mistral: "Mistral",
    deepseek: "DeepSeek",
    fireworks: "Fireworks",
    together: "Together",
    cohere: "Cohere",
    perplexity: "Perplexity",
    cerebras: "Cerebras",
    "amazon-bedrock": "Amazon Bedrock",
    "azure-openai": "Azure OpenAI",
    lmstudio: "LM Studio",
    ollama: "Ollama",
    "github-copilot": "GitHub Copilot",
    huggingface: "Hugging Face",
    "kimi-coding": "Kimi Coding",
    minimax: "MiniMax",
    "minimax-cn": "MiniMax (CN)",
    opencode: "OpenCode",
    "vercel-ai-gateway": "Vercel AI Gateway",
    zai: "Z.AI",
};

export const PROVIDER_ICONS: Record<string, string> = {
    anthropic: "🤖",
    "google-antigravity": "🚀",
    google: "🔵",
    openai: "🟢",
    "openai-codex": "💻",
    xai: "⚡",
    openrouter: "🔀",
    groq: "⚡",
    mistral: "🌬️",
    deepseek: "🔍",
    fireworks: "🎆",
    together: "🤝",
    cohere: "🧊",
    perplexity: "🔮",
    cerebras: "🧠",
    "amazon-bedrock": "☁️",
    "azure-openai": "🔷",
    lmstudio: "🖥️",
    ollama: "🦙",
    "github-copilot": "🐙",
    huggingface: "🤗",
    "kimi-coding": "🌙",
    minimax: "🔶",
    "minimax-cn": "🔶",
    opencode: "📝",
    "vercel-ai-gateway": "▲",
    zai: "💎",
};

export const PROVIDER_CREDIT_URLS: Record<string, string> = {
    openai: "https://platform.openai.com/account/billing",
    anthropic: "https://console.anthropic.com/settings/billing",
    google: "https://aistudio.google.com/billing",
    "google-antigravity": "https://console.cloud.google.com/billing",
    xai: "https://console.x.ai/billing",
    openrouter: "https://openrouter.ai/credits",
    groq: "https://console.groq.com/settings/billing",
    mistral: "https://console.mistral.ai/billing",
    deepseek: "https://platform.deepseek.com/billing",
    fireworks: "https://fireworks.ai/account/billing",
    together: "https://api.together.xyz/settings/billing",
    cohere: "https://dashboard.cohere.com/billing",
    perplexity: "https://www.perplexity.ai/settings/api",
    cerebras: "https://cloud.cerebras.ai/billing",
    huggingface: "https://huggingface.co/settings/billing",
};

export const PROVIDER_KEY_URLS: Record<string, string> = {
    openai: "https://platform.openai.com/api-keys",
    anthropic: "https://console.anthropic.com/settings/keys",
    google: "https://aistudio.google.com/app/apikey",
    "google-antigravity": "https://aistudio.google.com/app/apikey",
    xai: "https://console.x.ai/team/default/api-keys",
    groq: "https://console.groq.com/keys",
    mistral: "https://console.mistral.ai/api-keys",
    deepseek: "https://platform.deepseek.com/api_keys",
    openrouter: "https://openrouter.ai/settings/keys",
    fireworks: "https://fireworks.ai/api-keys",
    together: "https://api.together.xyz/settings/api-keys",
    cohere: "https://dashboard.cohere.com/api-keys",
    perplexity: "https://www.perplexity.ai/settings/api",
    cerebras: "https://cloud.cerebras.ai/platform/api-keys",
    huggingface: "https://huggingface.co/settings/tokens",
};

export const API_KEY_PROVIDERS = [
    { id: "openai", name: "OpenAI", icon: "🟢", placeholder: "sk-..." },
    { id: "anthropic", name: "Anthropic (Claude)", icon: "🤖", placeholder: "sk-ant-..." },
    { id: "google", name: "Google AI (Gemini)", icon: "🔵", placeholder: "AIza..." },
    { id: "google-antigravity", name: "Antigravity OAuth", icon: "🚀", placeholder: "ag-..." },
    { id: "xai", name: "xAI (Grok)", icon: "⚡", placeholder: "xai-..." },
    { id: "openrouter", name: "OpenRouter", icon: "🔀", placeholder: "sk-or-..." },
    { id: "groq", name: "Groq", icon: "⚡", placeholder: "gsk_..." },
    { id: "mistral", name: "Mistral", icon: "🌬️", placeholder: "..." },
    { id: "deepseek", name: "DeepSeek", icon: "🔍", placeholder: "sk-..." },
    { id: "fireworks", name: "Fireworks", icon: "🎆", placeholder: "fw_..." },
    { id: "together", name: "Together", icon: "🤝", placeholder: "..." },
    { id: "cohere", name: "Cohere", icon: "🧊", placeholder: "..." },
    { id: "perplexity", name: "Perplexity", icon: "🔮", placeholder: "pplx-..." },
    { id: "cerebras", name: "Cerebras", icon: "🧠", placeholder: "csk-..." },
    { id: "amazon-bedrock", name: "Amazon Bedrock", icon: "☁️", placeholder: "..." },
    { id: "azure-openai", name: "Azure OpenAI", icon: "🔷", placeholder: "..." },
    { id: "github-copilot", name: "GitHub Copilot", icon: "🐙", placeholder: "ghu_..." },
    { id: "huggingface", name: "Hugging Face", icon: "🤗", placeholder: "hf_..." },
    { id: "lmstudio", name: "LM Studio", icon: "🖥️", placeholder: "(local)" },
    { id: "ollama", name: "Ollama", icon: "🦙", placeholder: "(local)" },
];

export const KEYBOARD_SHORTCUTS = [
    { keys: ["⌘", "K"], description: "Open command palette" },
    { keys: ["⌘", "Enter"], description: "Submit task" },
    { keys: ["⌘", "N"], description: "New task" },
    { keys: ["⌘", "S"], description: "Save current" },
    { keys: ["⌘", ","], description: "Open settings" },
    { keys: ["⌘", "/"], description: "Toggle sidebar" },
    { keys: ["Escape"], description: "Close dialog / cancel" },
    { keys: ["⌘", "D"], description: "Duplicate task" },
    { keys: ["⌘", "⇧", "D"], description: "Delete task" },
    { keys: ["Tab"], description: "Autocomplete" },
];

export const RISK_LEVEL_META: Record<RiskLevel, { label: string; color: string; bgColor: string; borderColor: string; icon: string; description: string }> = {
    low: {
        label: "Low Risk",
        color: "text-emerald-400",
        bgColor: "bg-emerald-500/10",
        borderColor: "border-emerald-500/30",
        icon: "🛡️",
        description: "Maximum security. Auth, CSRF, strict rate limits, manual approval for all agent actions.",
    },
    medium: {
        label: "Medium Risk",
        color: "text-blue-400",
        bgColor: "bg-blue-500/10",
        borderColor: "border-blue-500/30",
        icon: "⚖️",
        description: "Balanced. Auth + CSRF enforced, reasonable rate limits, dangerous actions need approval.",
    },
    high: {
        label: "High Risk",
        color: "text-amber-400",
        bgColor: "bg-amber-500/10",
        borderColor: "border-amber-500/30",
        icon: "⚠️",
        description: "Relaxed. No auth required, auto-dispatch enabled, only dangerous actions need approval.",
    },
    insane: {
        label: "Insane",
        color: "text-orange-400",
        bgColor: "bg-orange-500/10",
        borderColor: "border-orange-500/30",
        icon: "🔥",
        description: "Almost no guardrails. No auth, no CSRF, no rate limits, no approval gates.",
    },
    freedom: {
        label: "Freedom",
        color: "text-red-400",
        bgColor: "bg-red-500/10",
        borderColor: "border-red-500/30",
        icon: "💀",
        description: "All protections disabled. No logging, no timeouts. Not recommended.",
    },
};

// --- Utility Functions ---

export function loadSettings(): AppSettings {
    if (typeof window === "undefined") {return DEFAULT_SETTINGS;}
    try {
        const stored = localStorage.getItem("mission_control_settings");
        if (!stored) {return DEFAULT_SETTINGS;}
        return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    } catch {
        return DEFAULT_SETTINGS;
    }
}

export function saveSettings(settings: AppSettings): void {
    if (typeof window === "undefined") {return;}
    try {
        localStorage.setItem("mission_control_settings", JSON.stringify(settings));
        // Dispatch storage event for cross-tab sync
        window.dispatchEvent(
            new StorageEvent("storage", {
                key: "mission_control_settings",
                newValue: JSON.stringify(settings),
            })
        );
    } catch {
        // Silently fail if localStorage is full
    }
}

export function resolveTheme(mode: ThemeMode): "light" | "dark" {
    if (mode === "system") {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return mode;
}

export function applyTheme(theme: "light" | "dark"): void {
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(theme);
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
        "content",
        theme === "dark" ? "#0a0a0f" : "#ffffff"
    );
}

export function getStoredModelPreference(): ModelPreference | null {
    if (typeof window === "undefined") {return null;}
    try {
        const stored = localStorage.getItem(MODEL_PREF_KEY);
        return stored ? JSON.parse(stored) : null;
    } catch {
        return null;
    }
}

export function formatFileSize(sizeStr: string): string {
    const bytes = parseInt(sizeStr, 10);
    if (isNaN(bytes)) {return sizeStr;}
    if (bytes < 1024) {return `${bytes} B`;}
    if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)} KB`;}
    if (bytes < 1024 * 1024 * 1024) {return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;}
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatRelativeTime(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60_000);
    if (diffMins < 1) {return "just now";}
    if (diffMins < 60) {return `${diffMins}m ago`;}
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) {return `${diffHours}h ago`;}
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) {return `${diffDays}d ago`;}
    return date.toLocaleDateString();
}
