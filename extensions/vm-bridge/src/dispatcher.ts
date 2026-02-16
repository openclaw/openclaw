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

const INTENT_MATCH_PROMPT = `You are a project intent matcher and rewriter. Given a message and a list of projects with their intents, determine which project best matches, then produce a LOGICALLY COMPLETE intent statement.

A logically complete intent resolves all ambiguity from the original message:
- WHO: Full names and email addresses of people involved (extract from message body, CC list, and signatures)
- WHAT: The specific action to take, using precise system terminology from the project's intent descriptions
- WHERE: Exact location, page, table, or component to modify
- BOUNDARY: What should NOT change (e.g., "do not remove existing recipients")
- VERIFICATION: A concrete, pass/fail condition an automated QA agent can check via Chrome browser

Example — raw message: "Can you update VTC USA Service related reviews go to Jason Shearer as well as Chris and Pete"
Logically complete intent: "Add jshearer@vvgtruck.com (Jason Shearer) to NEGATIVE review notifications for all VTC USA Service department locations. Chris Abarca (cabarca@vvgtruck.com) and Pete Hobbs (phobbs@vvgtruck.com) should already be receiving these — do not remove them."

If no project/intent matches with reasonable confidence, respond with {"matched": false}.

Otherwise respond with:
{
  "matched": true,
  "project_id": "...",
  "intent": "Logically complete statement that an engineer could execute without referring back to the original email. Include names, emails, specific locations/brands, and what NOT to change.",
  "qa_doc": [
    {"id": "short_snake_id", "description": "what to verify", "nav": "URL or page location to navigate to", "pass_if": "exact condition that must be true for this check to pass"}
  ],
  "confidence": 0.0-1.0,
  "reasoning": "one sentence"
}

qa_doc rules:
- Each check must be independently verifiable via Chrome browser
- Include at least one check per entity mentioned in the intent
- Include boundary checks for what should NOT have changed (e.g. existing users still present)
- Use specific URLs, page elements, or database values in nav and pass_if
- Example for "Add jshearer to Service dept notifications, keep cabarca and phobbs":
  [
    {"id": "user_added", "description": "jshearer in recipients", "nav": "customer-response.vtc.systems/admin/settings > Recipients tab", "pass_if": "jshearer@vvgtruck.com listed as Active"},
    {"id": "correct_scope", "description": "Scope is Service dept only", "nav": "Location Subscriptions tab for jshearer", "pass_if": "Only VTC USA Service department locations are checked"},
    {"id": "cabarca_unchanged", "description": "cabarca still present", "nav": "Recipients tab", "pass_if": "cabarca@vvgtruck.com still listed as Active"},
    {"id": "phobbs_unchanged", "description": "phobbs still present", "nav": "Recipients tab", "pass_if": "phobbs@vvgtruck.com still listed as Active"}
  ]`;

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

  // 3. Use LLM to rewrite intent into a logically complete statement
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Fallback — can't rewrite intent without LLM, pass raw text with low confidence
    const project = projects[0];
    return {
      matched: true,
      project_id: project.id,
      project,
      intent: `[RAW — needs rewrite] ${messageSubject ?? messageBody.slice(0, 200)}`,
      confidence: 0.3,
      reasoning: "No API key — intent not logically resolved, needs human review",
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
        max_tokens: 1000,
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
      qa_doc: raw.qa_doc
        ? (Array.isArray(raw.qa_doc) ? JSON.stringify(raw.qa_doc) : String(raw.qa_doc))
        : "Verify the change was applied correctly",
      confidence: raw.confidence ?? 0.7,
      reasoning: raw.reasoning ?? "",
    };
  } catch {
    return { matched: false };
  }
}
