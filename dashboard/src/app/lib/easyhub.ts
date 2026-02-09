// EasyHub Gateway Integration
// Connects dashboard to EasyHub's config system

const GATEWAY_URL = "http://localhost:18789";

interface GatewayResponse<T = any> {
  ok: boolean;
  result?: T;
  error?: string;
}

interface EasyHubConfig {
  agents?: {
    defaults?: {
      model?: {
        primary?: string;
        fallbacks?: string[];
      };
    };
  };
  auth?: {
    profiles?: Record<string, AuthProfile>;
  };
}

interface AuthProfile {
  provider: string;
  mode: "api_key" | "token" | "oauth";
  email?: string;
}

// Get gateway auth token from localStorage (set during initial setup)
function getGatewayToken(): string | null {
  return localStorage.getItem("easyhub_gateway_token");
}

export function setGatewayToken(token: string): void {
  localStorage.setItem("easyhub_gateway_token", token);
}

// Make authenticated request to gateway
async function gatewayRequest<T = any>(
  endpoint: string,
  method: "GET" | "POST" = "GET",
  body?: any
): Promise<GatewayResponse<T>> {
  const token = getGatewayToken();
  
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(`${GATEWAY_URL}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const data = await response.json();
    return { ok: true, result: data };
  } catch (error: any) {
    return { 
      ok: false, 
      error: error.message || "Failed to connect to EasyHub gateway" 
    };
  }
}

// Check if gateway is running and accessible
export async function checkGatewayStatus(): Promise<{
  connected: boolean;
  error?: string;
}> {
  try {
    const response = await fetch(`${GATEWAY_URL}/health`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    
    if (response.ok) {
      return { connected: true };
    }
    return { connected: false, error: `HTTP ${response.status}` };
  } catch (error: any) {
    return { 
      connected: false, 
      error: "Gateway not running. Start with: EasyHub gateway" 
    };
  }
}

// Get current EasyHub configuration
export async function getEasyHubConfig(): Promise<GatewayResponse<EasyHubConfig>> {
  const token = getGatewayToken();
  
  try {
    // Use the gateway's config endpoint
    const response = await fetch(`${GATEWAY_URL}/api/config`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "Authorization": `Bearer ${token}` } : {}),
      },
    });

    if (!response.ok) {
      // Try WebSocket-style RPC as fallback
      return { ok: false, error: "Config endpoint not available" };
    }

    const data = await response.json();
    return { ok: true, result: data };
  } catch (error: any) {
    return { ok: false, error: error.message };
  }
}

// Update EasyHub configuration (partial patch)
export async function patchEasyHubConfig(
  patch: Partial<EasyHubConfig>
): Promise<GatewayResponse> {
  const token = getGatewayToken();
  
  try {
    const response = await fetch(`${GATEWAY_URL}/api/config`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "Authorization": `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(patch),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      return { ok: false, error: error.message || `HTTP ${response.status}` };
    }

    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error.message };
  }
}

// Parse model string (provider/model) into parts
export function parseModelString(modelStr: string): { provider: string; model: string } {
  const parts = modelStr.split("/");
  if (parts.length >= 2) {
    return { provider: parts[0], model: parts.slice(1).join("/") };
  }
  return { provider: "anthropic", model: modelStr };
}

// Build model string from parts
export function buildModelString(provider: string, model: string): string {
  return `${provider}/${model}`;
}

// Get current model from config
export function getCurrentModel(config: EasyHubConfig): string | null {
  return config?.agents?.defaults?.model?.primary || null;
}

// Get auth profiles from config
export function getAuthProfiles(config: EasyHubConfig): Record<string, AuthProfile> {
  return config?.auth?.profiles || {};
}

// Check if a provider has auth configured
export function hasProviderAuth(config: EasyHubConfig, provider: string): boolean {
  const profiles = getAuthProfiles(config);
  return Object.keys(profiles).some(key => key.startsWith(`${provider}:`));
}

// Available providers with their model lists
export const PROVIDERS = {
  anthropic: {
    name: "Anthropic",
    models: [
      { id: "claude-opus-4-5", name: "Claude Opus 4.5", context: 200000 },
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", context: 200000 },
      { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", context: 200000 },
      { id: "claude-3-opus-20240229", name: "Claude 3 Opus", context: 200000 },
      { id: "claude-3-haiku-20240307", name: "Claude 3 Haiku", context: 200000 },
    ],
  },
  openai: {
    name: "OpenAI",
    models: [
      { id: "gpt-4o", name: "GPT-4o", context: 128000 },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", context: 128000 },
      { id: "gpt-4-turbo", name: "GPT-4 Turbo", context: 128000 },
      { id: "o1", name: "o1", context: 200000 },
      { id: "o1-mini", name: "o1 Mini", context: 128000 },
    ],
  },
  google: {
    name: "Google",
    models: [
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", context: 1000000 },
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", context: 2000000 },
      { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", context: 1000000 },
    ],
  },
  groq: {
    name: "Groq",
    models: [
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", context: 128000 },
      { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B", context: 128000 },
      { id: "mixtral-8x7b-32768", name: "Mixtral 8x7B", context: 32768 },
    ],
  },
  openrouter: {
    name: "OpenRouter",
    models: [
      { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", context: 200000 },
      { id: "openai/gpt-4o", name: "GPT-4o", context: 128000 },
      { id: "meta-llama/llama-3.1-405b-instruct", name: "Llama 3.1 405B", context: 128000 },
    ],
  },
  venice: {
    name: "Venice AI",
    models: [
      { id: "llama-3.3-70b", name: "Llama 3.3 70B", context: 128000 },
      { id: "claude-opus-45", name: "Claude Opus (via Venice)", context: 200000 },
    ],
  },
};

export type ProviderKey = keyof typeof PROVIDERS;
