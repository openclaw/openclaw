// Feishu plugin entry point with error handling

// Simple placeholder that won't cause errors
const feishuPluginPlaceholder = {
  id: "feishu",
  name: "Feishu",
  description: "Feishu/Lark channel plugin (disabled)",
  register: () => {},
  activate: () => {},
  plugin: {
    id: "feishu",
    meta: {
      id: "feishu",
      label: "Feishu",
      selectionLabel: "Feishu/Lark (飞书)",
      docsPath: "/channels/feishu",
      docsLabel: "feishu",
      blurb: "飞书/Lark enterprise messaging.",
      aliases: ["lark"],
      order: 70,
    },
    capabilities: {
      chatTypes: ["direct", "channel"],
      polls: false,
      threads: true,
      media: true,
      reactions: true,
      edit: true,
      reply: true,
    },
    actions: {
      describeMessageTool: () => ({
        actions: [],
        capabilities: [],
        schema: null,
      }),
      handleAction: async () => ({
        content: [{ type: "text", text: "Feishu plugin is disabled due to loading error" }],
        details: { error: "Feishu plugin is disabled" },
      }),
    },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => null,
      defaultAccountId: () => null,
      setAccountEnabled: (cfg) => cfg,
      deleteAccount: (cfg) => cfg,
      isConfigured: () => false,
      describeAccount: () => ({}),
    },
  },
  setRuntime: () => {},
  registerFull: () => {},
};

export default feishuPluginPlaceholder;

export const feishuPlugin = feishuPluginPlaceholder.plugin;
export const setFeishuRuntime = () => {};
export const monitorFeishuProvider = () => {};
export const sendMessageFeishu = () => {};
export const sendCardFeishu = () => {};
export const updateCardFeishu = () => {};
export const editMessageFeishu = () => {};
export const getMessageFeishu = () => {};
export const uploadImageFeishu = () => {};
export const uploadFileFeishu = () => {};
export const sendImageFeishu = () => {};
export const sendFileFeishu = () => {};
export const sendMediaFeishu = () => {};
export const probeFeishu = () => {};
export const addReactionFeishu = () => {};
export const removeReactionFeishu = () => {};
export const listReactionsFeishu = () => {};
export const FeishuEmoji = {};
export const extractMentionTargets = () => [];
export const extractMessageBody = () => "";
export const isMentionForwardRequest = () => false;
export const formatMentionForText = () => "";
export const formatMentionForCard = () => {};
export const formatMentionAllForText = () => "";
export const formatMentionAllForCard = () => {};
export const buildMentionedMessage = () => {};
export const buildMentionedCardContent = () => {};
