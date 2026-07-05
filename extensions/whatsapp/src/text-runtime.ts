// Whatsapp plugin module implements text runtime behavior.
export {
  convertMarkdownTables,
  sanitizeAssistantVisibleText,
  sanitizeAssistantVisibleTextWithProfile,
  stripToolCallXmlTags,
} from "openclaw/plugin-sdk/text-chunking";
export { normalizeE164, resolveUserPath, sleep } from "openclaw/plugin-sdk/text-utility-runtime";
export {
  assertWebChannel,
  isSelfChatMode,
  jidToE164,
  markdownToWhatsApp,
<<<<<<< HEAD
  resolveEquivalentWhatsAppDirectChatJids,
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  resolveJidToE164,
  toWhatsappJid,
  toWhatsappJidWithLid,
  type JidToE164Options,
<<<<<<< HEAD
  type LidLookup,
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  type WebChannel,
} from "./targets-runtime.js";
