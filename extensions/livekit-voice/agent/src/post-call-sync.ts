import type { ConversationEntry } from './session-logger.js';
import type { CallerInfo } from './context-loader.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const WORKSPACE_DIR = path.join(process.env.HOME || '/home/ada', '.openclaw', 'workspace');

/**
 * Sync a voice call summary to the OpenClaw session via /v1/chat/completions.
 * This ensures the text-based session (WhatsApp DM) knows what was discussed on the call.
 */
/**
 * Update a non-owner user's profile based on call transcript.
 * Extracts preferences, facts, and context worth remembering.
 */
async function updateUserProfile(caller: CallerInfo, entries: ConversationEntry[]): Promise<void> {
  if (caller.isOwner || !caller.userId) return;
  if (entries.length < 4) return; // Too short to learn anything

  const userFile = path.join(WORKSPACE_DIR, 'users', `${caller.userId}.md`);
  const transcript = entries
    .map((e) => `${e.role === 'user' ? 'Caller' : 'Ada'}: ${e.text}`)
    .join('\n');

  try {
    const existing = await fs.readFile(userFile, 'utf8').catch(() => '');

    // Use the gateway LLM to extract profile updates
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model: 'openclaw:main',
        messages: [{
          role: 'user',
          content: [
            'Extract useful profile information about the caller from this voice call transcript.',
            'Only extract facts worth remembering: name, preferences, timezone, language, interests, decisions, what they work on.',
            'Skip greetings, small talk, and anything already in the existing profile.',
            '',
            'Existing profile:',
            existing || '(empty)',
            '',
            'Call transcript:',
            transcript,
            '',
            'Return ONLY the new bullet points to append (markdown format: "- **Key:** Value"). If nothing new worth saving, return "NONE".',
          ].join('\n'),
        }],
        stream: false,
      }),
    });

    if (!res.ok) {
      console.error(`[PostCallSync] Profile update LLM error: ${res.status}`);
      return;
    }

    const data = await res.json() as any;
    const updates = data.choices?.[0]?.message?.content?.trim() || '';

    if (!updates || updates === 'NONE') {
      console.log(`[PostCallSync] No profile updates for user ${caller.userId}`);
      return;
    }

    // Append updates to user file
    const today = new Date().toISOString().split('T')[0];
    const appendText = `\n## Updated ${today} (from voice call)\n${updates}\n`;
    await fs.appendFile(userFile, appendText, 'utf8');
    console.log(`[PostCallSync] Updated profile for user ${caller.userId}`);
  } catch (err) {
    console.error(`[PostCallSync] Failed to update user profile:`, err);
  }
}

export async function syncCallToSession(
  sessionKey: string,
  entries: ConversationEntry[],
  durationSec: number,
  caller?: CallerInfo,
): Promise<void> {
  if (entries.length === 0) {
    console.log('[PostCallSync] No conversation entries, skipping sync');
    return;
  }

  const transcript = entries
    .map((e) => `${e.role === 'user' ? 'Caller' : 'Ada'}: ${e.text}`)
    .join('\n');

  const durationMin = Math.floor(durationSec / 60);
  const durationRemSec = durationSec % 60;

  const summaryRequest = [
    `[VOICE CALL SUMMARY — ${durationMin}m ${durationRemSec}s, ${entries.length} turns]`,
    '',
    'A voice call just ended. Here is the transcript:',
    '',
    transcript,
    '',
    'Summarize what was discussed and any action items. Store this in your session context for continuity.',
  ].join('\n');

  try {
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        'x-openclaw-session-key': sessionKey,
        'x-openclaw-agent-id': 'main',
        'x-openclaw-message-channel': 'voice',
      },
      body: JSON.stringify({
        model: 'openclaw:main',
        messages: [{ role: 'user', content: summaryRequest }],
        // Non-streaming — we just want the summary stored in the session
        stream: false,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[PostCallSync] Gateway error (${res.status}): ${text}`);
      return;
    }

    const data = await res.json();
    const reply = (data as any).choices?.[0]?.message?.content || '';
    console.log(`[PostCallSync] Session synced. Reply: ${reply.slice(0, 120)}...`);
  } catch (err) {
    console.error('[PostCallSync] Failed to sync call summary:', err);
  }

  // Update non-owner user profiles with learned information
  if (caller && !caller.isOwner) {
    await updateUserProfile(caller, entries);
  }
}
