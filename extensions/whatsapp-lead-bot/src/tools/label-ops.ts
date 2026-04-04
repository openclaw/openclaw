/**
 * Tools: get_labels, create_label, add_chat_label
 *
 * Low-level WhatsApp label operations for diagnostics and testing.
 * These go through the gateway's live Baileys socket.
 */

import type { Runtime } from "../runtime.js";

export const getLabelsTool = {
  name: "get_labels",
  description: "List all WhatsApp labels for the account. Returns id, name, color, deleted.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [] as string[],
  },
  execute: async (_params: Record<string, never>, context: { runtime: Runtime }) => {
    const { runtime } = context;
    if (!runtime.getLabels) {
      return { success: false, error: "getLabels not available on this runtime" };
    }
    const labels = await runtime.getLabels();
    return { success: true, labels };
  },
};

export const createLabelTool = {
  name: "create_label",
  description: "Create a new WhatsApp label. Returns the created label's id, name, and color.",
  inputSchema: {
    type: "object" as const,
    properties: {
      name: { type: "string" as const, description: "Label name" },
      color: { type: "number" as const, description: "Color index 0-19 (default 0)" },
    },
    required: ["name"] as string[],
  },
  execute: async (params: { name: string; color?: number }, context: { runtime: Runtime }) => {
    const { runtime } = context;
    if (!runtime.createLabel) {
      return { success: false, error: "createLabel not available on this runtime" };
    }
    const result = await runtime.createLabel(params.name, params.color ?? 0);
    return { success: true, label: result ?? null };
  },
};

export const addChatLabelTool = {
  name: "add_chat_label",
  description: "Apply a label to a WhatsApp chat by JID.",
  inputSchema: {
    type: "object" as const,
    properties: {
      chat_jid: {
        type: "string" as const,
        description: "Chat JID (e.g. 5216621413782@s.whatsapp.net)",
      },
      label_id: { type: "string" as const, description: "Label ID to apply" },
    },
    required: ["chat_jid", "label_id"] as string[],
  },
  execute: async (
    params: { chat_jid: string; label_id: string },
    context: { runtime: Runtime },
  ) => {
    const { runtime } = context;
    if (!runtime.addChatLabel) {
      return { success: false, error: "addChatLabel not available on this runtime" };
    }
    await runtime.addChatLabel(params.chat_jid, params.label_id);
    return { success: true, chat_jid: params.chat_jid, label_id: params.label_id };
  },
};
