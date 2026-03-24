/**
 * Detects and suppresses bot-authored messages in the WhatsApp inbound stream.
 * Prevents "double-processing" loops on personal-number setups.
 * Addresses #54010.
 */
export function isBotAuthoredMessage(message: any, botId: string): boolean {
    // Baileys messages from self often have specific flags or match the connection ID
    if (message.key?.fromMe === true) {
        return true;
    }
    if (message.participant && message.participant.includes(botId)) {
        return true;
    }
    return false;
}
