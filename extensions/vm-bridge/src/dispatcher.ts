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
- PARITY: If the request says "as well as X", "same as X", or "like X does", the intent must explicitly state that the target should MATCH the reference entity's existing state for the relevant scope
- VERIFICATION: A concrete, pass/fail condition an automated QA agent can check via Chrome browser or database query

ENTITY EXTRACTION — Identify every person, system, or data object mentioned or implied:
- Action targets: the entity being added/changed/removed
- Reference entities: anyone mentioned for parity ("as well as X", "same as X", "like X does")
- Unchanged entities: anyone explicitly preserved ("do not remove", "keep")
- Scope qualifiers: filters that limit the action (brand, department, location type)

When reference entities are mentioned ("as well as X"), the intent MUST state that the action target should MATCH the reference entity's existing state for the relevant scope. Do not interpret the scope independently — derive it from what the reference entities already have.

If no project/intent matches with reasonable confidence, respond with {"matched": false}.

Otherwise respond with:
{
  "matched": true,
  "project_id": "...",
  "intent": "Logically complete statement that an engineer could execute without referring back to the original email. Include names, emails, specific locations/brands, and what NOT to change. When parity is implied, state explicitly that the target must match the reference entity's existing state.",
  "qa_doc": [
    {"id": "short_snake_id", "description": "what to verify", "nav": "deployed application URL where the change is visible (e.g. https://app.example.com/settings)", "pass_if": "exact state assertion — not existence, but complete expected state as seen in the browser"}
  ],
  "confidence": 0.0-1.0,
  "reasoning": "one sentence"
}

qa_doc rules — ENTITY-POSITIONAL CHECKS:
Every entity mentioned or implied gets a STATE ASSERTION, not just an existence check.

For each entity, the check must specify its COMPLETE EXPECTED STATE after execution:
- Action targets: What records/settings they should have after the action, at what scope, with what attributes
- Reference entities ("as well as X"): PARITY CHECK — target must match the reference entity's state for the relevant scope. The target should be present everywhere the reference is present, with matching attributes.
- Unchanged entities: SNAPSHOT CHECK — entity's state must be identical before and after execution. Total count, record list, and attributes must all be unchanged.
- Scope boundaries: BOUNDARY CHECK — no records should exist outside the stated scope for the action target.

Do NOT write existence checks like "X is still present" or "X is listed as Active."
DO write state checks like "X has the same total records at the same locations with the same attributes as before execution."

Each check MUST be verifiable by navigating to the deployed application URL in Chrome.
The "nav" field must be a real URL where the QA agent can see the result (not "Database: ..." references).
The "pass_if" field must describe what the QA agent will see on that page (visible text, element state, counts displayed in UI).
The QA agent runs in a Chrome browser pointed at the live application — it does not have direct database access.
If the application has an admin panel or dashboard that shows the relevant data, use that URL.`;

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
