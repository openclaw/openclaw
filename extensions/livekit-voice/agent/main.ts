import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
// Silero VAD removed — Gemini Live has built-in voice activity detection
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { SessionLogger } from './src/session-logger.js';
import { buildVoiceSystemPrompt, type CallerInfo } from './src/context-loader.js';
import { createVoiceTools } from './src/tool-handler.js';
import { syncCallToSession } from './src/post-call-sync.js';

dotenv.config({ path: '.env.local' });

const DEFAULT_SESSION_KEY = process.env.OWNER_SESSION_KEY || 'agent:main:whatsapp:dm:85297603778';

export default defineAgent({
  // Silero VAD prewarm removed — Gemini Live handles voice activity natively

  entry: async (ctx: JobContext) => {
   try {
    await ctx.connect();
    console.log('[Agent] Connected to room');
    const participant = await ctx.waitForParticipant();
    console.log('[Agent] Participant joined:', participant.identity);

    // Extract caller info from participant metadata (set by frontend token route)
    let sessionKey = DEFAULT_SESSION_KEY;
    let callerName = 'Unknown';
    let callerEmail = '';
    let callerId = '';
    let isOwner = false;
    let avatarUrl = '';
    let givenName = '';
    let familyName = '';
    let locale = '';
    let createdAt = '';
    try {
      const meta = JSON.parse(participant.metadata || '{}');
      if (meta.sessionKey) sessionKey = meta.sessionKey;
      if (meta.callerName) callerName = meta.callerName;
      if (meta.email) callerEmail = meta.email;
      if (meta.userId) callerId = meta.userId;
      if (meta.isOwner) isOwner = meta.isOwner;
      if (meta.avatarUrl) avatarUrl = meta.avatarUrl;
      if (meta.givenName) givenName = meta.givenName;
      if (meta.familyName) familyName = meta.familyName;
      if (meta.locale) locale = meta.locale;
      if (meta.createdAt) createdAt = meta.createdAt;
    } catch {
      console.warn('[Agent] Could not parse participant metadata, using default session');
    }

    const callerInfo: CallerInfo = {
      isOwner, callerName, email: callerEmail, userId: callerId, sessionKey,
      avatarUrl, givenName, familyName, locale, createdAt,
    };
    console.log(`[Agent] Call from ${callerName} (${isOwner ? 'OWNER' : 'guest'}), session: ${sessionKey}`);

    // Build system prompt — loads owner's USER.md or per-user profile based on caller
    const systemInstruction = await buildVoiceSystemPrompt(sessionKey, callerInfo);
    console.log(`[Agent] System prompt: ${systemInstruction.length} chars`);

    // Create Gemini Live realtime model (native audio — no separate STT/TTS)
    const realtimeModel = new google.beta.realtime.RealtimeModel({
      model: process.env.GEMINI_MODEL || 'gemini-live-2.5-flash-native-audio',
      voice: process.env.GEMINI_VOICE || 'Kore',
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT || 'shiftmindlab',
      location: process.env.GOOGLE_CLOUD_LOCATION || 'us-west1',
      temperature: 0.9,
      geminiTools: { googleSearch: {} },
      // enableAffectiveDialog: true,  // DISABLED — forces v1alpha which causes 1006 disconnects
      apiVersion: 'v1beta1',
      realtimeInputConfig: {
        automaticActivityDetection: {
          startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
          endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
          prefixPaddingMs: 20,
          silenceDurationMs: 100,
        },
      },
      // Context window compression — enables unlimited call duration
      // When context reaches 100K tokens, compress to 60K by summarizing oldest turns
      contextWindowCompression: {
        triggerTokens: 100000,
        slidingWindow: { targetTokens: 60000 },
      },
      // Session resumption — survives brief disconnects (wifi→5G, etc)
      sessionResumption: { transparent: true },
      extraConfig: {
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
        ],
      },
    } as any);

    // Register tools for Gemini Live to call
    const tools = createVoiceTools();

    const logger = new SessionLogger(ctx.room.name ?? 'unknown');
    const callStartTime = Date.now();

    const agent = new voice.Agent({
      instructions: systemInstruction,
      llm: realtimeModel,
      tools,
    });

    const session = new voice.AgentSession({
      // VAD removed — Gemini Live's automaticActivityDetection handles this
      voiceOptions: {
        minInterruptionDuration: 700,   // 700ms of speech needed to interrupt
      },
    });

    // Log user speech transcriptions (final only)
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      try {
        if (ev.isFinal && ev.transcript?.trim()) {
          logger.log('user', ev.transcript.trim());
          console.log(`[User] ${ev.transcript.trim()}`);
        }
      } catch {
        // never crash the call
      }
    });

    // Log assistant responses
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      try {
        const item = ev.item;
        if (item.role !== 'assistant') return;
        const text =
          typeof item.content === 'string'
            ? item.content
            : Array.isArray(item.content)
              ? item.content
                  .map((c: any) => c?.transcript || c?.text || '')
                  .filter(Boolean)
                  .join(' ')
              : '';
        if (text.trim()) {
          logger.log('assistant', text.trim());
          console.log(`[Ada] ${text.trim()}`);
        }
      } catch {
        // never crash the call
      }
    });

    await session.start({ agent, room: ctx.room });

    // Initial greeting with retry — cold starts can timeout on first Gemini connection
    const greetingInstruction = isOwner
      ? "Greet naturally, like picking up a call from someone you know well. Keep it short — one line max."
      : `The caller's name is ${callerName}. Greet them by name naturally, like picking up a call. Keep it short — one line max.`;
    const MAX_GREETING_RETRIES = 3;
    const sendGreeting = async () => {
      for (let attempt = 1; attempt <= MAX_GREETING_RETRIES; attempt++) {
        try {
          console.log(`[Agent] Sending initial greeting (attempt ${attempt}/${MAX_GREETING_RETRIES})`);
          await session.generateReply({ instructions: greetingInstruction });
          console.log('[Agent] Greeting sent successfully');
          return;
        } catch (err) {
          console.error(`[Agent] Greeting attempt ${attempt} failed:`, err);
          if (attempt < MAX_GREETING_RETRIES) {
            const delay = 2000 * attempt;
            console.log(`[Agent] Retrying greeting in ${delay}ms...`);
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
      console.error('[Agent] All greeting attempts failed — waiting for user to speak first');
    };
    // Fire greeting async — don't block the call if it fails
    sendGreeting().catch((err) => console.error('[Agent] Greeting error:', err));

    // Post-call sync on disconnect
    ctx.room.on('disconnected', async () => {
      const durationSec = Math.round((Date.now() - callStartTime) / 1000);
      logger.close();

      // Sync the call summary to the OpenClaw session (fire-and-forget)
      syncCallToSession(sessionKey, logger.entries, durationSec, callerInfo).catch((err) =>
        console.error('[Agent] Post-call sync failed:', err),
      );
    });
   } catch (err) {
    console.error('[Agent] FATAL ERROR in entrypoint:', err);
   }
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: process.env.OWNER_IDENTITY ? `${process.env.OWNER_IDENTITY}-voice` : 'ada-voice',
  }),
);
