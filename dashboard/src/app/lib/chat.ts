// Chat service - handles API calls to different AI providers

import type { ChatSettings, StreamCallbacks, Message } from "./types";

// Provider API endpoints
const ENDPOINTS = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
  google: "https://generativelanguage.googleapis.com/v1beta/models",
  groq: "https://api.groq.com/openai/v1/chat/completions",
};

// Convert messages to provider-specific format
function formatMessages(
  messages: Message[],
  provider: string,
  systemPrompt?: string
): { messages: any[]; system?: string } {
  const formatted = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role,
      content: m.content,
    }));

  if (provider === "anthropic") {
    // Anthropic uses separate system parameter
    return {
      messages: formatted,
      system: systemPrompt || undefined,
    };
  }

  // OpenAI/Groq/Google use system message in array
  if (systemPrompt) {
    return {
      messages: [{ role: "system", content: systemPrompt }, ...formatted],
    };
  }

  return { messages: formatted };
}

// Main chat function - sends message and returns response
export async function sendMessage(
  messages: Message[],
  settings: ChatSettings
): Promise<string> {
  const { provider, model, apiKey, temperature, maxTokens, systemPrompt } = settings;

  if (!apiKey) {
    throw new Error(`No API key configured for ${provider}. Please add it in Settings.`);
  }

  const { messages: formattedMessages, system } = formatMessages(
    messages,
    provider,
    systemPrompt
  );

  try {
    if (provider === "anthropic") {
      return await callAnthropic(formattedMessages, model, apiKey, temperature, maxTokens, system);
    } else if (provider === "openai") {
      return await callOpenAI(formattedMessages, model, apiKey, temperature, maxTokens);
    } else if (provider === "google") {
      return await callGoogle(formattedMessages, model, apiKey, temperature, maxTokens);
    } else if (provider === "groq") {
      return await callGroq(formattedMessages, model, apiKey, temperature, maxTokens);
    } else {
      throw new Error(`Unknown provider: ${provider}`);
    }
  } catch (error: any) {
    // Enhance error messages
    if (error.message?.includes("401") || error.message?.includes("Unauthorized")) {
      throw new Error(`Invalid API key for ${provider}. Please check your key in Settings.`);
    }
    if (error.message?.includes("429")) {
      throw new Error(`Rate limit exceeded for ${provider}. Please wait and try again.`);
    }
    throw error;
  }
}

// Streaming chat function
export async function sendMessageStream(
  messages: Message[],
  settings: ChatSettings,
  callbacks: StreamCallbacks
): Promise<void> {
  const { provider, model, apiKey, temperature, maxTokens, systemPrompt } = settings;

  if (!apiKey) {
    callbacks.onError(new Error(`No API key configured for ${provider}. Please add it in Settings.`));
    return;
  }

  const { messages: formattedMessages, system } = formatMessages(
    messages,
    provider,
    systemPrompt
  );

  try {
    if (provider === "anthropic") {
      await streamAnthropic(formattedMessages, model, apiKey, temperature, maxTokens, system, callbacks);
    } else if (provider === "openai") {
      await streamOpenAI(formattedMessages, model, apiKey, temperature, maxTokens, callbacks);
    } else if (provider === "groq") {
      await streamGroq(formattedMessages, model, apiKey, temperature, maxTokens, callbacks);
    } else if (provider === "google") {
      // Google streaming is more complex, fall back to non-streaming
      const response = await callGoogle(formattedMessages, model, apiKey, temperature, maxTokens);
      callbacks.onToken(response);
      callbacks.onComplete(response);
    } else {
      callbacks.onError(new Error(`Unknown provider: ${provider}`));
    }
  } catch (error: any) {
    callbacks.onError(error);
  }
}

// Anthropic API
async function callAnthropic(
  messages: any[],
  model: string,
  apiKey: string,
  temperature: number,
  maxTokens: number,
  system?: string
): Promise<string> {
  const body: any = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
  };
  if (system) body.system = system;

  const response = await fetch(ENDPOINTS.anthropic, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Anthropic API error: ${response.status}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || "";
}

async function streamAnthropic(
  messages: any[],
  model: string,
  apiKey: string,
  temperature: number,
  maxTokens: number,
  system: string | undefined,
  callbacks: StreamCallbacks
): Promise<void> {
  const body: any = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: true,
  };
  if (system) body.system = system;

  const response = await fetch(ENDPOINTS.anthropic, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Anthropic API error: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let fullResponse = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split("\n");

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            fullResponse += parsed.delta.text;
            callbacks.onToken(parsed.delta.text);
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
    }
  }

  callbacks.onComplete(fullResponse);
}

// OpenAI API
async function callOpenAI(
  messages: any[],
  model: string,
  apiKey: string,
  temperature: number,
  maxTokens: number
): Promise<string> {
  const response = await fetch(ENDPOINTS.openai, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

async function streamOpenAI(
  messages: any[],
  model: string,
  apiKey: string,
  temperature: number,
  maxTokens: number,
  callbacks: StreamCallbacks
): Promise<void> {
  const response = await fetch(ENDPOINTS.openai, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `OpenAI API error: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let fullResponse = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split("\n");

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            fullResponse += content;
            callbacks.onToken(content);
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
    }
  }

  callbacks.onComplete(fullResponse);
}

// Groq API (OpenAI compatible)
async function callGroq(
  messages: any[],
  model: string,
  apiKey: string,
  temperature: number,
  maxTokens: number
): Promise<string> {
  const response = await fetch(ENDPOINTS.groq, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Groq API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

async function streamGroq(
  messages: any[],
  model: string,
  apiKey: string,
  temperature: number,
  maxTokens: number,
  callbacks: StreamCallbacks
): Promise<void> {
  const response = await fetch(ENDPOINTS.groq, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Groq API error: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let fullResponse = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split("\n");

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            fullResponse += content;
            callbacks.onToken(content);
          }
        } catch (e) {
          // Skip
        }
      }
    }
  }

  callbacks.onComplete(fullResponse);
}

// Google Gemini API
async function callGoogle(
  messages: any[],
  model: string,
  apiKey: string,
  temperature: number,
  maxTokens: number
): Promise<string> {
  // Convert OpenAI format to Gemini format
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const url = `${ENDPOINTS.google}/${model}:generateContent?key=${apiKey}`;
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Google API error: ${response.status}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// Conversation storage
const CONVERSATIONS_KEY = "easyhub_conversations";

export function loadConversations(): Record<string, any> {
  try {
    const stored = localStorage.getItem(CONVERSATIONS_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

export function saveConversation(conversation: any): void {
  const conversations = loadConversations();
  conversations[conversation.id] = conversation;
  localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
}

export function deleteConversation(id: string): void {
  const conversations = loadConversations();
  delete conversations[id];
  localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
}

export function getConversation(id: string): any | null {
  const conversations = loadConversations();
  return conversations[id] || null;
}
