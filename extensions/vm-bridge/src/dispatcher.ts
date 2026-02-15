/**
 * Route an actionable message to a project + intent.
 * Sender email → cos_contacts → linked projects → LLM matches intents.
 */

import type { Db, Project, Intent } from "./db.js";

export type DispatchResult = {
  matched: boolean;
  project_id?: string;
  project?: Project;
  intent?: string;
  qa_doc?: string;
  confidence?: number;
  reasoning?: string;
};

const INTENT_MATCH_PROMPT = `You are a project intent matcher. Given a message and a list of projects with their intents, determine which project and intent best matches the message.

If no project/intent matches with reasonable confidence, respond with {"matched": false}.

Otherwise respond with:
{
  "matched": true,
  "project_id": "...",
  "intent": "one-line description of what the sender wants done",
  "qa_doc": "step-by-step verification instructions for confirming the work was done correctly (written for a QA agent that will check via Chrome browser)",
  "confidence": 0.0-1.0,
  "reasoning": "one sentence"
}`;

export async function dispatchMessage(
  senderEmail: string,
  messageBody: string,
  messageSubject: string | undefined,
  db: Db,
  classifierModel: string,
): Promise<DispatchResult> {
  // 1. Look up sender in contacts
  const contact = await db.getContactByEmail(senderEmail);
  if (!contact || contact.project_ids.length === 0) {
    return { matched: false };
  }

  // 2. Load linked projects + their intents
  const projects = await db.getProjectsByIds(contact.project_ids);
  if (projects.length === 0) {
    return { matched: false };
  }

  const projectIntents: Array<{ project: Project; intents: Intent[] }> = [];
  for (const project of projects) {
    const intents = await db.getIntentsByProject(project.id);
    projectIntents.push({ project, intents });
  }

  // 3. If only one project with clear intents, skip LLM for speed
  if (projects.length === 1 && projectIntents[0].intents.length <= 1) {
    const project = projects[0];
    return {
      matched: true,
      project_id: project.id,
      project,
      intent: messageSubject ?? messageBody.slice(0, 200),
      qa_doc: projectIntents[0].intents[0]?.description ?? "Verify the change was applied correctly",
      confidence: 0.8,
      reasoning: "Single project match, skipped LLM",
    };
  }

  // 4. Use LLM to match
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Fallback to first project
    const project = projects[0];
    return {
      matched: true,
      project_id: project.id,
      project,
      intent: messageSubject ?? messageBody.slice(0, 200),
      confidence: 0.5,
      reasoning: "No API key, defaulted to first project",
    };
  }

  const projectContext = projectIntents.map(({ project, intents }) =>
    `Project: ${project.id} (${project.name})\n  Domain: ${project.domain ?? "N/A"}\n  Intents:\n${intents.map((i) => `    - ${i.description}`).join("\n")}`
  ).join("\n\n");

  const userPrompt = [
    messageSubject ? `Subject: ${messageSubject}` : null,
    `Message: ${messageBody.slice(0, 2000)}`,
    "",
    "Available projects:",
    projectContext,
  ].filter((s) => s !== null).join("\n");

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: classifierModel,
        messages: [
          { role: "system", content: INTENT_MATCH_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const raw = JSON.parse(data.choices[0].message.content);

    if (!raw.matched) {
      return { matched: false };
    }

    const matchedProject = projects.find((p) => p.id === raw.project_id) ?? projects[0];
    return {
      matched: true,
      project_id: matchedProject.id,
      project: matchedProject,
      intent: raw.intent ?? messageSubject ?? messageBody.slice(0, 200),
      qa_doc: raw.qa_doc ?? "Verify the change was applied correctly",
      confidence: raw.confidence ?? 0.7,
      reasoning: raw.reasoning ?? "",
    };
  } catch {
    return { matched: false };
  }
}
