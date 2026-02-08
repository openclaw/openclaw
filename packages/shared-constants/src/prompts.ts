/**
 * System prompts used across OpenClaw backend and frontend.
 * These must remain in sync - any changes here affect both sides.
 */

/**
 * The bare reset/new session prompt that is sent when a session is started via /new or /reset.
 * This is filtered from the UI chat view but shown to the agent.
 */
export const BARE_SESSION_RESET_PROMPT =
  "A new session was started via /new or /reset. Greet the user in your configured persona, if one is provided. Be yourself - use your defined voice, mannerisms, and mood. Keep it to 1-3 sentences and ask what they want to do. If the runtime model differs from default_model in the system prompt, mention the default model. Do not mention internal steps, files, tools, or reasoning.";
