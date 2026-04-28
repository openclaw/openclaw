// Generate a personalized RunPR cold-pitch email by calling the local codex CLI (gpt-5.5 via
// ChatGPT OAuth). The codex binary is non-interactive in `codex exec` mode and expects a prompt
// on stdin or as the first positional arg.
//
// We give the model:
//   - The voice playbook (data/playbook.md) verbatim.
//   - The reference email templates (data/email-templates.md).
//   - A structured JSON brief: agency name, domain, detected tool, recent news, contact name.
//   - A strict output contract (subject + body_text + body_html as JSON).

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Contact, DetectedToolResult, DraftEmail, RawProspect, RecentNews } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = resolve(__dirname, "..", "data");

let cachedPlaybook: string | null = null;
let cachedTemplates: string | null = null;

async function loadAssets(): Promise<{ playbook: string; templates: string }> {
  if (!cachedPlaybook) cachedPlaybook = await readFile(resolve(DATA_DIR, "playbook.md"), "utf8");
  if (!cachedTemplates)
    cachedTemplates = await readFile(resolve(DATA_DIR, "email-templates.md"), "utf8");
  return { playbook: cachedPlaybook, templates: cachedTemplates };
}

function buildPrompt(opts: {
  agency: RawProspect;
  detected: DetectedToolResult;
  news: RecentNews | null;
  contact: Contact;
  playbook: string;
  templates: string;
}): string {
  const { agency, detected, news, contact, playbook, templates } = opts;

  const newsBlock = news
    ? `Headline: ${news.headline}\nURL: ${news.url}\nPublished: ${news.published_at ?? "unknown"}\nSnippet: ${news.snippet}`
    : "(no recent news found; use the agency blurb as context)";

  return `You are drafting a single cold-pitch email from Jeff (founder of RunPR) to a PR agency. Follow the voice playbook EXACTLY. Output ONLY a JSON object.

# VOICE PLAYBOOK

${playbook}

# REFERENCE EXAMPLES

${templates}

# AGENCY BRIEF

Agency name: ${agency.name}
Agency domain: ${agency.domain}
Agency blurb (auto-scraped): ${agency.blurb || "(none)"}
Detected incumbent tool: ${detected.tool} (confidence: ${detected.confidence})
Detection evidence:
${detected.evidence.length ? detected.evidence.map((e) => `  - ${e}`).join("\n") : "  - (none)"}

Recent news to use as the personalization hook:
${newsBlock}

Recipient:
  First name: ${contact.first_name}
  Title: ${contact.title || "(unknown)"}
  Contact confidence: ${contact.confidence}

# OUTPUT CONTRACT

Return EXACTLY a JSON object with these keys (and nothing else, no markdown fence, no commentary):

{
  "subject": "<sentence-case subject line>",
  "body_text": "<plain text body, 80-130 words, signed 'Jeff'>",
  "body_html": "<HTML body, same content as body_text but the FIRST 'RunPR' is wrapped in <a href=\\"https://runpr.ai/\\">RunPR</a>, paragraphs use <p> tags, sign-off on its own paragraph>"
}

Rules to double-check before emitting:
1. ZERO em dashes anywhere. Search your output. If you find one, rewrite.
2. The first line of body_text starts with "Hi ${contact.first_name}," exactly.
3. Body ends with the line "Jeff" alone (no surname, no signature block).
4. Subject is sentence case (only the first word and proper nouns capitalized).
5. The opening hook references the recent news / agency-specific signal above.
6. If detected tool is "unknown", do NOT invent a tool. Use the "modern PR teams running on three or four tools" framing.
7. Single-question close, real question.
8. NEVER reference team members' demographics.

Emit the JSON object now.`;
}

async function runCodex(prompt: string, timeoutMs = 90_000): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    // `codex exec` reads prompt from stdin if provided via pipe. The `--skip-git-repo-check`
    // flag avoids codex complaining that we're running outside a git tree (the prompt itself is
    // self-contained).
    const args = ["exec", "--skip-git-repo-check", "-"];
    const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (b) => chunks.push(b));
    child.stderr.on("data", (b) => errChunks.push(b));
    child.on("error", (err) => {
      clearTimeout(t);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      const stdout = Buffer.concat(chunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");
      if (timedOut) return rejectPromise(new Error("codex exec timed out"));
      if (code !== 0) {
        return rejectPromise(
          new Error(`codex exec exited ${code}: ${stderr.slice(0, 800) || "(no stderr)"}`),
        );
      }
      resolvePromise(stdout);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Codex `exec` prints a header and a footer around the model output. Strip those and pull out the
// first JSON object we find.
function extractJson(raw: string): string | null {
  // Look for the first '{' and last '}' that brace-balance.
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

function stripEmDashes(s: string): string {
  // Defense in depth. The model is instructed to never produce em dashes, but if one slips
  // through, replace it with a period+space.
  return s.replace(/—/g, ". ").replace(/–/g, ", ");
}

export async function draftEmail(opts: {
  agency: RawProspect;
  detected: DetectedToolResult;
  news: RecentNews | null;
  contact: Contact;
}): Promise<DraftEmail> {
  const { playbook, templates } = await loadAssets();
  const prompt = buildPrompt({ ...opts, playbook, templates });

  const raw = await runCodex(prompt);
  const json = extractJson(raw);
  if (!json) {
    throw new Error(
      `codex returned no JSON for ${opts.agency.name}. Raw head: ${raw.slice(0, 400)}`,
    );
  }
  let parsed: { subject?: string; body_text?: string; body_html?: string };
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `codex JSON parse failed for ${opts.agency.name}: ${(err as Error).message}\n${json.slice(0, 400)}`,
    );
  }
  if (!parsed.subject || !parsed.body_text || !parsed.body_html) {
    throw new Error(`codex output missing required fields for ${opts.agency.name}`);
  }
  return {
    subject: stripEmDashes(parsed.subject.trim()),
    body_text: stripEmDashes(parsed.body_text.trim()),
    body_html: stripEmDashes(parsed.body_html.trim()),
  };
}
