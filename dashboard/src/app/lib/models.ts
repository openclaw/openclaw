// AI Provider and Model Configuration
// Models are fetched from a remote config that gets updated

export interface AIModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutput?: number;
}

export interface AIProvider {
  id: string;
  name: string;
  models: AIModel[];
  apiKeyPlaceholder: string;
}

// Default fallback models (used if fetch fails)
const DEFAULT_PROVIDERS: AIProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    apiKeyPlaceholder: "sk-ant-...",
    models: [
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", contextWindow: 200000 },
      { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", contextWindow: 200000 },
      { id: "claude-3-opus-20240229", name: "Claude 3 Opus", contextWindow: 200000 },
      { id: "claude-3-haiku-20240307", name: "Claude 3 Haiku", contextWindow: 200000 },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    apiKeyPlaceholder: "sk-...",
    models: [
      { id: "gpt-4o", name: "GPT-4o", contextWindow: 128000 },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128000 },
      { id: "gpt-4-turbo", name: "GPT-4 Turbo", contextWindow: 128000 },
      { id: "o1", name: "o1", contextWindow: 200000 },
      { id: "o1-mini", name: "o1 Mini", contextWindow: 128000 },
    ],
  },
  {
    id: "google",
    name: "Google",
    apiKeyPlaceholder: "AIza...",
    models: [
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", contextWindow: 1000000 },
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", contextWindow: 2000000 },
      { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", contextWindow: 1000000 },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    apiKeyPlaceholder: "gsk_...",
    models: [
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", contextWindow: 128000 },
      { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B", contextWindow: 128000 },
      { id: "mixtral-8x7b-32768", name: "Mixtral 8x7B", contextWindow: 32768 },
    ],
  },
];

// Config URL - can be changed to point to a remote JSON file
const CONFIG_URL = "https://raw.githubusercontent.com/KBS-Dev1/EasyHub/main/dashboard/models.json";

let cachedProviders: AIProvider[] | null = null;
let lastFetch: number = 0;
const CACHE_DURATION = 1000 * 60 * 60; // 1 hour

export async function fetchProviders(): Promise<AIProvider[]> {
  const now = Date.now();
  
  // Return cached if fresh
  if (cachedProviders && (now - lastFetch) < CACHE_DURATION) {
    return cachedProviders;
  }

  try {
    const response = await fetch(CONFIG_URL, { 
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });
    
    if (response.ok) {
      const data = await response.json();
      cachedProviders = data.providers || DEFAULT_PROVIDERS;
      lastFetch = now;
      
      // Cache in localStorage too
      localStorage.setItem("easyhub_models_cache", JSON.stringify({
        providers: cachedProviders,
        timestamp: now
      }));
      
      return cachedProviders;
    }
  } catch (error) {
    console.warn("Failed to fetch models config, using defaults:", error);
  }

  // Try localStorage cache
  try {
    const cached = localStorage.getItem("easyhub_models_cache");
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.providers) {
        cachedProviders = parsed.providers;
        return cachedProviders;
      }
    }
  } catch (e) {
    // Ignore
  }

  return DEFAULT_PROVIDERS;
}

export function getDefaultProviders(): AIProvider[] {
  return DEFAULT_PROVIDERS;
}

// Fetch models for a specific provider using their API
export async function fetchModelsFromAPI(
  providerId: string, 
  apiKey: string
): Promise<AIModel[] | null> {
  try {
    if (providerId === "openai" && apiKey) {
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: { "Authorization": `Bearer ${apiKey}` }
      });
      if (response.ok) {
        const data = await response.json();
        const chatModels = data.data
          .filter((m: any) => m.id.includes("gpt") || m.id.includes("o1"))
          .map((m: any) => ({ id: m.id, name: m.id }))
          .sort((a: AIModel, b: AIModel) => a.name.localeCompare(b.name));
        return chatModels;
      }
    }
    
    // Anthropic and Google don't have public model listing APIs
    // We rely on the config file for these
    
  } catch (error) {
    console.warn("Failed to fetch models from API:", error);
  }
  
  return null;
}
