// Chat types for EasyHub

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  model?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  provider: string;
  model: string;
}

export interface ChatSettings {
  provider: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  systemPrompt?: string;
}

export interface ChatRequest {
  messages: { role: string; content: string }[];
  model: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onComplete: (fullResponse: string) => void;
  onError: (error: Error) => void;
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function generateTitle(firstMessage: string): string {
  const clean = firstMessage.trim().slice(0, 50);
  return clean.length < firstMessage.length ? `${clean}...` : clean;
}
