// lib/anthropic-client.mjs
// Thin wrapper around @mariozechner/pi-ai. One function per call pattern we use.
import { completeSimple, getModel } from '@mariozechner/pi-ai';

const MODEL_IDS = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

function resolveModel(tier) {
  const id = MODEL_IDS[tier];
  if (!id) throw new Error(`Unknown model tier: ${tier}`);
  return getModel('anthropic', id);
}

function extractText(res) {
  return (res.content || [])
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
    .trim();
}

export async function completeOnce({ prompt, model = 'haiku', maxTokens, apiKey }) {
  const res = await completeSimple(
    resolveModel(model),
    { messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] },
    { apiKey, maxTokens },
  );
  return {
    text: extractText(res),
    inputTokens: res.usage?.input ?? 0,
    outputTokens: res.usage?.output ?? 0,
  };
}

export async function routeSkill({ message, skillsList, model = 'haiku', apiKey }) {
  const { text, inputTokens, outputTokens } = await completeOnce({
    prompt: buildRouterPrompt(message, skillsList),
    model,
    maxTokens: 50,
    apiKey,
  });
  const predicted = text.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return { predicted, inputTokens, outputTokens };
}

export async function proposeEdit({ skill, currentDesc, misroutes, model, apiKey }) {
  const { text, inputTokens, outputTokens } = await completeOnce({
    prompt: buildHypothesisPrompt(skill, currentDesc, misroutes),
    model,
    maxTokens: 300,
    apiKey,
  });
  return { newDescription: text, inputTokens, outputTokens };
}

function buildRouterPrompt(message, skillsList) {
  const list = skillsList.map(s => `- ${s.name}: ${s.description}`).join('\n');
  return `You are a skill router. Given these skills:\n\n${list}\n\nWhich skill should handle this message: "${message}"\n\nRespond with ONLY the skill name (lowercase, dashes ok), or "none" if no skill fits. No explanation.`;
}

function buildHypothesisPrompt(skill, currentDesc, misroutes) {
  const misrouteList = misroutes.slice(0, 5).map(m =>
    `  - Message: "${m.message}"\n    Currently routed to: ${m.predicted} (should have been ${m.expected})`
  ).join('\n');
  return `Task: Improve this skill description to fix routing misfires.

Skill: ${skill}
Current description: "${currentDesc}"

Recent misroutes to fix:
${misrouteList}

Rules:
- Length: 50-500 characters
- No keyword stuffing (no word used ≥5 times)
- Stay close to the current description semantically — refine, don't rewrite

Output ONLY the new description text. No quotes, no preamble, no explanation.`;
}
