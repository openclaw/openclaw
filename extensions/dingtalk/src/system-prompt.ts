/**
 * System Prompt for DingTalk channel behaviors.
 *
 * This module generates the system prompt that teaches the AI how to
 * use DingTalk-specific skills (send media, schedule reminders, etc).
 */

/**
 * Generates the DingTalk channel system prompt.
 *
 * Keep this short: detailed instructions should live in channel-scoped skills.
 *
 * @returns The system prompt string
 */
export function buildDingTalkSystemPrompt(): string {
    return `## DingTalk channel notes (钉钉)

When the user asks you to **send** an image or file (as an attachment), include a media tag in your reply:

- Image: [DING:IMAGE path="/absolute/path/to/image.png"]
- File:  [DING:FILE  path="/absolute/path/to/file.pdf" name="用户看到的文件名.pdf"]

Rules:
- \`path\` must be an **absolute local path** and the file must exist.
- Output tags verbatim (no code fences, no escaping).
- You can include multiple tags in one reply; they will be processed in order.`;
}

/**
 * Default DingTalk channel system prompt.
 */
export const DEFAULT_DINGTALK_SYSTEM_PROMPT = buildDingTalkSystemPrompt();

/**
 * Generates the sender context prompt string.
 * This provides the AI with the DingTalk sender's staff ID for identification.
 * 
 * @param senderId The sender's ID (e.g. staffId)
 * @returns The formatted context string
 */
export function buildSenderContext(senderId: string): string {
    return `[钉钉消息 | senderStaffId: ${senderId}]`;
}
