/**
 * Cognitive Context — Compact BDI extraction for agent context injection.
 *
 * Runs 5 extractors in parallel to build a compact cognitive state summary
 * (~2000 tokens worst case) from Beliefs, Desires, Plans, Knowledge, and MEMORY.md.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

async function readMd(p: string): Promise<string> {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Extract high-certainty beliefs (certainty > 0.7, max 15 rows).
 * ~400 token budget.
 */
function extractHighCertaintyBeliefs(content: string): string {
  if (\!content.trim()) return "";
  const lines = content.split("\n");
  const highCertainty: string[] = [];

  for (const line of lines) {
    // Match lines with certainty values like "certainty: 0.85" or "| 0.9 |"
    const certMatch = line.match(/certainty[:\s]+([0-9.]+)|(?:\|\s*)([0-9.]+)(?:\s*\|)/i);
    if (certMatch) {
      const cert = parseFloat(certMatch[1] ?? certMatch[2]);
      if (cert > 0.7) {
        highCertainty.push(line.trim());
      }
    }
  }

  if (highCertainty.length === 0) return "";
  return highCertainty.slice(0, 15).join("\n");
}

/**
 * Extract active desires (max 10 lines).
 * ~300 token budget.
 */
function extractActiveDesires(content: string): string {
  if (\!content.trim()) return "";
  const lines = content.split("\n");
  const active: string[] = [];

  for (const line of lines) {
    if (/status:\s*active/i.test(line) || /\bactive\b/i.test(line)) {
      active.push(line.trim());
    }
  }

  if (active.length === 0) return "";
  return active.slice(0, 10).join("\n");
}

/**
 * Extract executing plans (status: executing sections, max 10 lines).
 * ~300 token budget.
 */
function extractExecutingPlans(content: string): string {
  if (\!content.trim()) return "";
  const lines = content.split("\n");
  const executing: string[] = [];
  let inExecutingSection = false;

  for (const line of lines) {
    if (/status:\s*executing/i.test(line)) {
      inExecutingSection = true;
      executing.push(line.trim());
      continue;
    }
    if (inExecutingSection) {
      if (line.startsWith("## ") || line.startsWith("# ")) {
        inExecutingSection = false;
        continue;
      }
      if (line.trim()) {
        executing.push(line.trim());
      }
    }
  }

  if (executing.length === 0) return "";
  return executing.slice(0, 10).join("\n");
}

/**
 * Extract knowledge summary (first 500 chars).
 * ~125 token budget.
 */
function extractKnowledgeSummary(content: string): string {
  if (\!content.trim()) return "";
  return content.trim().slice(0, 500);
}

/**
 * Extract long-term memory highlights (sections with key headers, max 15 lines).
 * ~200 token budget.
 */
function extractLongTermHighlights(content: string): string {
  if (\!content.trim()) return "";
  const lines = content.split("\n");
  const highlights: string[] = [];
  let inHighlightSection = false;

  for (const line of lines) {
    if (/^#{1,3}\s+.*\b(highlight|key|important|decision)\b/i.test(line)) {
      inHighlightSection = true;
      highlights.push(line.trim());
      continue;
    }
    if (inHighlightSection) {
      if (/^#{1,3}\s/.test(line) && \!/\b(highlight|key|important|decision)\b/i.test(line)) {
        inHighlightSection = false;
        continue;
      }
      if (line.trim()) {
        highlights.push(line.trim());
      }
    }
  }

  if (highlights.length === 0) return "";
  return highlights.slice(0, 15).join("\n");
}

/**
 * Assemble cognitive context from BDI files.
 *
 * Runs all 5 extractors in parallel.
 * Returns { cognitiveExtras, longTermHighlights }.
 * Total ~2000 tokens worst case.
 */
export async function assembleCognitiveContext(agentDir: string): Promise<{
  cognitiveExtras: string;
  longTermHighlights: string;
}> {
  const [beliefs, desires, plans, knowledge, memory] = await Promise.all([
    readMd(join(agentDir, "Beliefs.md")),
    readMd(join(agentDir, "Desires.md")),
    readMd(join(agentDir, "Plans.md")),
    readMd(join(agentDir, "Knowledge.md")),
    readMd(join(agentDir, "memory", "MEMORY.md")),
  ]);

  const sections: string[] = [];

  const highBeliefs = extractHighCertaintyBeliefs(beliefs);
  if (highBeliefs) sections.push(`### High-Certainty Beliefs\n${highBeliefs}`);

  const activeDesires = extractActiveDesires(desires);
  if (activeDesires) sections.push(`### Active Desires\n${activeDesires}`);

  const execPlans = extractExecutingPlans(plans);
  if (execPlans) sections.push(`### Executing Plans\n${execPlans}`);

  const knowledgeSummary = extractKnowledgeSummary(knowledge);
  if (knowledgeSummary) sections.push(`### Knowledge Summary\n${knowledgeSummary}`);

  const longTermHighlights = extractLongTermHighlights(memory);

  return {
    cognitiveExtras: sections.length > 0 ? sections.join("\n\n") : "",
    longTermHighlights,
  };
}
