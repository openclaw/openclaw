/**
 * Email Listener Skill - Intent Parser Module
 *
 * Uses Claude Haiku to extract intent from natural language emails.
 * Classifies messages into action categories and extracts parameters.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ParsedIntent, IntentAction, IntentParams } from "./types.js";
import { logger } from "./logger.js";

let anthropicClient: Anthropic | null = null;

/**
 * Get or initialize Anthropic client
 */
function getClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is not set");
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

/**
 * System prompt for intent parsing
 */
const SYSTEM_PROMPT = `You are Tim, an AI companion and guardian agent operating via email.
Your task is to analyze incoming emails and determine what action the sender wants you to take.

You must respond with ONLY a valid JSON object matching this exact schema:

{
  "action": "<CREATE_TASK | STATUS | PING | AGENT_STATUS | MOVE_EMAIL | UNKNOWN>",
  "confidence": <0.0 to 1.0>,
  "reasoning": "<brief explanation>",
  "params": {
    "taskTitle": "<string or null>",
    "taskDescription": "<string or null>",
    "taskPriority": "<low | medium | high | urgent | null>",
    "taskDueDate": "<YYYY-MM-DD or null>",
    "targetFolder": "<string or null>",
    "rawArgs": []
  }
}

Action definitions:
- CREATE_TASK: sender wants a task, to-do item, reminder, or follow-up created
- STATUS: sender wants system health or status information
- PING: sender is testing connectivity or checking Tim is alive
- AGENT_STATUS: sender wants info about agents or AI systems
- MOVE_EMAIL: sender wants an email organized or moved to a folder
- UNKNOWN: you cannot determine intent with confidence

Confidence tiers:
- >= 0.9: completely unambiguous
- 0.7–0.89: clear but required interpretation
- < 0.7: ambiguous or could mean multiple things

Rules:
- Default to UNKNOWN rather than guess
- For CREATE_TASK, make the title concise and actionable, not a copy of the full email
- Always use null (not omit) for unused params fields
- No extra JSON keys

Examples:

Email: "Tim, create a task to review email functions"
{"action":"CREATE_TASK","confidence":0.95,"reasoning":"Explicit task creation with clear action","params":{"taskTitle":"Review email functions","taskDescription":"Review the email functions as requested","taskPriority":"medium","taskDueDate":null,"targetFolder":null,"rawArgs":[]}}

Email: "Hey, just pinging you to see if you're alive"
{"action":"PING","confidence":0.95,"reasoning":"Sender explicitly uses ping and checks if Tim is alive","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}

Email: "What's the system status? Is everything healthy?"
{"action":"STATUS","confidence":0.91,"reasoning":"Direct request for system status and health","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}

Email: "Please move this email to the archive folder"
{"action":"MOVE_EMAIL","confidence":0.88,"reasoning":"Clear move request with target folder","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":"archive","rawArgs":[]}}

Email: "Thanks! Hope you have a great day!"
{"action":"UNKNOWN","confidence":0.97,"reasoning":"Casual message with no actionable request","params":{"taskTitle":null,"taskDescription":null,"taskPriority":null,"taskDueDate":null,"targetFolder":null,"rawArgs":[]}}`;

/**
 * Parse intent from email subject and body using Claude Haiku
 */
export async function parseIntent(
  subject: string,
  body: string,
  model: string
): Promise<ParsedIntent | null> {
  try {
    const client = getClient();
    const message = `Subject: ${subject}\n\nBody: ${body}`;

    const response = await client.messages.create({
      model,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: message,
        },
      ],
    });

    // Extract text from response
    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      logger.warn("No text in Claude response");
      return null;
    }

    // Parse the intent
    return parseIntentResponse(textBlock.text);
  } catch (error) {
    logger.error("Intent parser failed", { error: String(error) });
    return null;
  }
}

/**
 * Parse JSON response from Claude
 */
export function parseIntentResponse(rawText: string): ParsedIntent | null {
  try {
    // Strip markdown code fences if present
    let jsonText = rawText.trim();
    if (jsonText.startsWith("```json")) {
      jsonText = jsonText.substring(7);
    }
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.substring(3);
    }
    if (jsonText.endsWith("```")) {
      jsonText = jsonText.substring(0, jsonText.length - 3);
    }
    jsonText = jsonText.trim();

    // Parse JSON
    const parsed = JSON.parse(jsonText);

    // Validate action is a valid IntentAction
    const validActions: IntentAction[] = [
      "CREATE_TASK",
      "STATUS",
      "PING",
      "AGENT_STATUS",
      "MOVE_EMAIL",
      "UNKNOWN",
    ];

    if (!validActions.includes(parsed.action)) {
      logger.warn("Invalid action in parsed intent", { action: parsed.action });
      return null;
    }

    // Validate confidence is a number between 0 and 1
    const confidence = parseFloat(parsed.confidence);
    if (isNaN(confidence) || confidence < 0 || confidence > 1) {
      logger.warn("Invalid confidence value", { confidence: parsed.confidence });
      return null;
    }

    // Validate params shape
    if (!parsed.params || typeof parsed.params !== "object") {
      logger.warn("Invalid params in parsed intent");
      return null;
    }

    const params: IntentParams = {
      taskTitle: parsed.params.taskTitle ?? undefined,
      taskDescription: parsed.params.taskDescription ?? undefined,
      taskPriority: parsed.params.taskPriority ?? undefined,
      taskDueDate: parsed.params.taskDueDate ?? undefined,
      targetFolder: parsed.params.targetFolder ?? undefined,
      rawArgs: parsed.params.rawArgs ?? [],
    };

    const intent: ParsedIntent = {
      action: parsed.action,
      confidence,
      reasoning: parsed.reasoning ?? "No reasoning provided",
      params,
    };

    logger.debug("Parsed intent from Claude", {
      action: intent.action,
      confidence: intent.confidence,
    });

    return intent;
  } catch (error) {
    logger.warn("Failed to parse intent response", { error: String(error) });
    return null;
  }
}
