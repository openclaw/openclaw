/**
 * OpenAI-powered email agent.
 *
 * Handles conversation management and tool execution loop.
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { loadCredentials } from '../security/credentials.js';
import { loadConfig } from '../config/index.js';
import { EMAIL_TOOLS, executeTool } from './tools.js';

/**
 * Conversation history
 */
let conversationHistory: ChatCompletionMessageParam[] = [];

/**
 * Create OpenAI client
 */
function createOpenAIClient(): OpenAI {
  const creds = loadCredentials();

  if (!creds.openaiApiKey) {
    throw new Error('OpenAI API key not configured. Run: moltbot-mini config set-openai-key');
  }

  return new OpenAI({
    apiKey: creds.openaiApiKey,
  });
}

/**
 * Get system prompt
 */
function getSystemPrompt(): string {
  const config = loadConfig();
  return config.openai.systemPrompt;
}

/**
 * Reset conversation history
 */
export function resetConversation(): void {
  conversationHistory = [];
}

/**
 * Get conversation history length
 */
export function getConversationLength(): number {
  return conversationHistory.length;
}

/**
 * Process a user message and get AI response
 */
export async function chat(userMessage: string): Promise<string> {
  const client = createOpenAIClient();
  const config = loadConfig();

  // Add user message to history
  conversationHistory.push({
    role: 'user',
    content: userMessage,
  });

  // Trim history if too long
  const maxHistory = config.agent.maxHistoryLength * 2; // user + assistant pairs
  if (conversationHistory.length > maxHistory) {
    conversationHistory = conversationHistory.slice(-maxHistory);
  }

  // Build messages array with system prompt
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: getSystemPrompt() },
    ...conversationHistory,
  ];

  // Call OpenAI with tools
  let response = await client.chat.completions.create({
    model: config.openai.model,
    max_tokens: config.openai.maxTokens,
    temperature: config.openai.temperature,
    messages,
    tools: EMAIL_TOOLS,
    tool_choice: 'auto',
  });

  let assistantMessage = response.choices[0]?.message;

  // Handle tool calls in a loop
  while (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
    // Add assistant message with tool calls to history
    conversationHistory.push({
      role: 'assistant',
      content: assistantMessage.content,
      tool_calls: assistantMessage.tool_calls,
    });

    // Execute each tool call
    const toolResults: ChatCompletionMessageParam[] = [];

    for (const toolCall of assistantMessage.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments || '{}');

      console.log(`\n  [Tool: ${toolCall.function.name}]`);

      const result = await executeTool(toolCall.function.name, args);

      toolResults.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
    }

    // Add tool results to history
    conversationHistory.push(...toolResults);

    // Get next response
    const nextMessages: ChatCompletionMessageParam[] = [
      { role: 'system', content: getSystemPrompt() },
      ...conversationHistory,
    ];

    response = await client.chat.completions.create({
      model: config.openai.model,
      max_tokens: config.openai.maxTokens,
      temperature: config.openai.temperature,
      messages: nextMessages,
      tools: EMAIL_TOOLS,
      tool_choice: 'auto',
    });

    assistantMessage = response.choices[0]?.message;
  }

  // Extract final text response
  const finalResponse = assistantMessage?.content || 'I apologize, but I was unable to generate a response.';

  // Add assistant response to history
  conversationHistory.push({
    role: 'assistant',
    content: finalResponse,
  });

  return finalResponse;
}

/**
 * Single-turn query (no history)
 */
export async function query(userMessage: string): Promise<string> {
  resetConversation();
  return chat(userMessage);
}
