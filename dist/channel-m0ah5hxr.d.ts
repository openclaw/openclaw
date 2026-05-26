import { t as BaseProbeResult } from "./types.core-1gFCH89g.js";
import { n as ChannelPlugin } from "./types.public-BfuQlAVf.js";
import { z as z$1 } from "zod";

//#region extensions/feishu/src/config-schema.d.ts
declare const FeishuConfigSchema: z$1.ZodObject<{
  dmPolicy: z$1.ZodDefault<z$1.ZodOptional<z$1.ZodEnum<{
    pairing: "pairing";
    allowlist: "allowlist";
    open: "open";
  }>>>;
  reactionNotifications: z$1.ZodDefault<z$1.ZodOptional<z$1.ZodOptional<z$1.ZodEnum<{
    off: "off";
    all: "all";
    own: "own";
  }>>>>;
  groupPolicy: z$1.ZodDefault<z$1.ZodOptional<z$1.ZodUnion<readonly [z$1.ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    open: "open";
  }>, z$1.ZodPipe<z$1.ZodLiteral<"allowall">, z$1.ZodTransform<"open", "allowall">>]>>>;
  requireMention: z$1.ZodOptional<z$1.ZodBoolean>;
  groupSessionScope: z$1.ZodOptional<z$1.ZodEnum<{
    group: "group";
    group_sender: "group_sender";
    group_topic: "group_topic";
    group_topic_sender: "group_topic_sender";
  }>>;
  topicSessionMode: z$1.ZodOptional<z$1.ZodEnum<{
    enabled: "enabled";
    disabled: "disabled";
  }>>;
  dynamicAgentCreation: z$1.ZodOptional<z$1.ZodObject<{
    enabled: z$1.ZodOptional<z$1.ZodBoolean>;
    workspaceTemplate: z$1.ZodOptional<z$1.ZodString>;
    agentDirTemplate: z$1.ZodOptional<z$1.ZodString>;
    maxAgents: z$1.ZodOptional<z$1.ZodNumber>;
  }, z$1.core.$strict>>;
  typingIndicator: z$1.ZodDefault<z$1.ZodOptional<z$1.ZodBoolean>>;
  resolveSenderNames: z$1.ZodDefault<z$1.ZodOptional<z$1.ZodBoolean>>;
  accounts: z$1.ZodOptional<z$1.ZodRecord<z$1.ZodString, z$1.ZodOptional<z$1.ZodObject<{
    groupSessionScope: z$1.ZodOptional<z$1.ZodEnum<{
      group: "group";
      group_sender: "group_sender";
      group_topic: "group_topic";
      group_topic_sender: "group_topic_sender";
    }>>;
    topicSessionMode: z$1.ZodOptional<z$1.ZodEnum<{
      enabled: "enabled";
      disabled: "disabled";
    }>>;
    webhookHost: z$1.ZodOptional<z$1.ZodString>;
    webhookPort: z$1.ZodOptional<z$1.ZodNumber>;
    capabilities: z$1.ZodOptional<z$1.ZodArray<z$1.ZodString>>;
    markdown: z$1.ZodOptional<z$1.ZodObject<{
      mode: z$1.ZodOptional<z$1.ZodEnum<{
        native: "native";
        escape: "escape";
        strip: "strip";
      }>>;
      tableMode: z$1.ZodOptional<z$1.ZodEnum<{
        native: "native";
        ascii: "ascii";
        simple: "simple";
      }>>;
    }, z$1.core.$strict>>;
    configWrites: z$1.ZodOptional<z$1.ZodBoolean>;
    dmPolicy: z$1.ZodOptional<z$1.ZodEnum<{
      pairing: "pairing";
      allowlist: "allowlist";
      open: "open";
    }>>;
    allowFrom: z$1.ZodOptional<z$1.ZodArray<z$1.ZodUnion<readonly [z$1.ZodString, z$1.ZodNumber]>>>;
    groupPolicy: z$1.ZodOptional<z$1.ZodUnion<readonly [z$1.ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      open: "open";
    }>, z$1.ZodPipe<z$1.ZodLiteral<"allowall">, z$1.ZodTransform<"open", "allowall">>]>>;
    groupAllowFrom: z$1.ZodOptional<z$1.ZodArray<z$1.ZodUnion<readonly [z$1.ZodString, z$1.ZodNumber]>>>;
    groupSenderAllowFrom: z$1.ZodOptional<z$1.ZodArray<z$1.ZodUnion<readonly [z$1.ZodString, z$1.ZodNumber]>>>;
    requireMention: z$1.ZodOptional<z$1.ZodBoolean>;
    groups: z$1.ZodOptional<z$1.ZodRecord<z$1.ZodString, z$1.ZodOptional<z$1.ZodObject<{
      requireMention: z$1.ZodOptional<z$1.ZodBoolean>;
      tools: z$1.ZodOptional<z$1.ZodObject<{
        allow: z$1.ZodOptional<z$1.ZodArray<z$1.ZodString>>;
        deny: z$1.ZodOptional<z$1.ZodArray<z$1.ZodString>>;
      }, z$1.core.$strict>>;
      skills: z$1.ZodOptional<z$1.ZodArray<z$1.ZodString>>;
      enabled: z$1.ZodOptional<z$1.ZodBoolean>;
      allowFrom: z$1.ZodOptional<z$1.ZodArray<z$1.ZodUnion<readonly [z$1.ZodString, z$1.ZodNumber]>>>;
      systemPrompt: z$1.ZodOptional<z$1.ZodString>;
      groupSessionScope: z$1.ZodOptional<z$1.ZodEnum<{
        group: "group";
        group_sender: "group_sender";
        group_topic: "group_topic";
        group_topic_sender: "group_topic_sender";
      }>>;
      topicSessionMode: z$1.ZodOptional<z$1.ZodEnum<{
        enabled: "enabled";
        disabled: "disabled";
      }>>;
      replyInThread: z$1.ZodOptional<z$1.ZodEnum<{
        enabled: "enabled";
        disabled: "disabled";
      }>>;
    }, z$1.core.$strict>>>>;
    historyLimit: z$1.ZodOptional<z$1.ZodNumber>;
    dmHistoryLimit: z$1.ZodOptional<z$1.ZodNumber>;
    dms: z$1.ZodOptional<z$1.ZodRecord<z$1.ZodString, z$1.ZodOptional<z$1.ZodObject<{
      enabled: z$1.ZodOptional<z$1.ZodBoolean>;
      systemPrompt: z$1.ZodOptional<z$1.ZodString>;
    }, z$1.core.$strict>>>>;
    textChunkLimit: z$1.ZodOptional<z$1.ZodNumber>;
    chunkMode: z$1.ZodOptional<z$1.ZodEnum<{
      length: "length";
      newline: "newline";
    }>>;
    blockStreaming: z$1.ZodOptional<z$1.ZodBoolean>;
    blockStreamingCoalesce: z$1.ZodOptional<z$1.ZodObject<{
      enabled: z$1.ZodOptional<z$1.ZodBoolean>;
      minDelayMs: z$1.ZodOptional<z$1.ZodNumber>;
      maxDelayMs: z$1.ZodOptional<z$1.ZodNumber>;
    }, z$1.core.$strict>>;
    mediaMaxMb: z$1.ZodOptional<z$1.ZodNumber>;
    httpTimeoutMs: z$1.ZodOptional<z$1.ZodNumber>;
    heartbeat: z$1.ZodOptional<z$1.ZodObject<{
      visibility: z$1.ZodOptional<z$1.ZodEnum<{
        visible: "visible";
        hidden: "hidden";
      }>>;
      intervalMs: z$1.ZodOptional<z$1.ZodNumber>;
    }, z$1.core.$strict>>;
    renderMode: z$1.ZodOptional<z$1.ZodEnum<{
      raw: "raw";
      auto: "auto";
      card: "card";
    }>>;
    streaming: z$1.ZodOptional<z$1.ZodBoolean>;
    tools: z$1.ZodOptional<z$1.ZodObject<{
      doc: z$1.ZodOptional<z$1.ZodBoolean>;
      chat: z$1.ZodOptional<z$1.ZodBoolean>;
      wiki: z$1.ZodOptional<z$1.ZodBoolean>;
      drive: z$1.ZodOptional<z$1.ZodBoolean>;
      perm: z$1.ZodOptional<z$1.ZodBoolean>;
      scopes: z$1.ZodOptional<z$1.ZodBoolean>;
    }, z$1.core.$strict>>;
    actions: z$1.ZodOptional<z$1.ZodObject<{
      reactions: z$1.ZodOptional<z$1.ZodBoolean>;
    }, z$1.core.$strict>>;
    replyInThread: z$1.ZodOptional<z$1.ZodEnum<{
      enabled: "enabled";
      disabled: "disabled";
    }>>;
    reactionNotifications: z$1.ZodOptional<z$1.ZodEnum<{
      off: "off";
      all: "all";
      own: "own";
    }>>;
    typingIndicator: z$1.ZodOptional<z$1.ZodBoolean>;
    resolveSenderNames: z$1.ZodOptional<z$1.ZodBoolean>;
    tts: z$1.ZodOptional<z$1.ZodObject<{
      auto: z$1.ZodOptional<z$1.ZodEnum<{
        off: "off";
        always: "always";
        tagged: "tagged";
        inbound: "inbound";
      }>>;
      enabled: z$1.ZodOptional<z$1.ZodBoolean>;
      mode: z$1.ZodOptional<z$1.ZodEnum<{
        all: "all";
        final: "final";
      }>>;
      provider: z$1.ZodOptional<z$1.ZodString>;
      persona: z$1.ZodOptional<z$1.ZodString>;
      personas: z$1.ZodOptional<z$1.ZodRecord<z$1.ZodString, z$1.ZodRecord<z$1.ZodString, z$1.ZodUnknown>>>;
      summaryModel: z$1.ZodOptional<z$1.ZodString>;
      modelOverrides: z$1.ZodOptional<z$1.ZodRecord<z$1.ZodString, z$1.ZodUnknown>>;
      providers: z$1.ZodOptional<z$1.ZodRecord<z$1.ZodString, z$1.ZodRecord<z$1.ZodString, z$1.ZodUnknown>>>;
      prefsPath: z$1.ZodOptional<z$1.ZodString>;
      maxTextLength: z$1.ZodOptional<z$1.ZodNumber>;
      timeoutMs: z$1.ZodOptional<z$1.ZodNumber>;
    }, z$1.core.$strict>>;
    enabled: z$1.ZodOptional<z$1.ZodBoolean>;
    name: z$1.ZodOptional<z$1.ZodString>;
    appId: z$1.ZodOptional<z$1.ZodString>;
    appSecret: z$1.ZodOptional<z$1.ZodUnion<readonly [z$1.ZodString, z$1.ZodDiscriminatedUnion<[z$1.ZodObject<{
      source: z$1.ZodLiteral<"env">;
      provider: z$1.ZodString;
      id: z$1.ZodString;
    }, z$1.core.$strip>, z$1.ZodObject<{
      source: z$1.ZodLiteral<"file">;
      provider: z$1.ZodString;
      id: z$1.ZodString;
    }, z$1.core.$strip>, z$1.ZodObject<{
      source: z$1.ZodLiteral<"exec">;
      provider: z$1.ZodString;
      id: z$1.ZodString;
    }, z$1.core.$strip>], "source">]>>;
    encryptKey: z$1.ZodOptional<z$1.ZodUnion<readonly [z$1.ZodString, z$1.ZodDiscriminatedUnion<[z$1.ZodObject<{
      source: z$1.ZodLiteral<"env">;
      provider: z$1.ZodString;
      id: z$1.ZodString;
    }, z$1.core.$strip>, z$1.ZodObject<{
      source: z$1.ZodLiteral<"file">;
      provider: z$1.ZodString;
      id: z$1.ZodString;
    }, z$1.core.$strip>, z$1.ZodObject<{
      source: z$1.ZodLiteral<"exec">;
      provider: z$1.ZodString;
      id: z$1.ZodString;
    }, z$1.core.$strip>], "source">]>>;
    verificationToken: z$1.ZodOptional<z$1.ZodUnion<readonly [z$1.ZodString, z$1.ZodDiscriminatedUnion<[z$1.ZodObject<{
      source: z$1.ZodLiteral<"env">;
      provider: z$1.ZodString;
      id: z$1.ZodString;
    }, z$1.core.$strip>, z$1.ZodObject<{
      source: z$1.ZodLiteral<"file">;
      provider: z$1.ZodString;
      id: z$1.ZodString;
    }, z$1.core.$strip>, z$1.ZodObject<{
      source: z$1.ZodLiteral<"exec">;
      provider: z$1.ZodString;
      id: z$1.ZodString;
    }, z$1.core.$strip>], "source">]>>;
    domain: z$1.ZodOptional<z$1.ZodUnion<readonly [z$1.ZodEnum<{
      feishu: "feishu";
      lark: "lark";
    }>, z$1.ZodString]>>;
    connectionMode: z$1.ZodOptional<z$1.ZodEnum<{
      webhook: "webhook";
      websocket: "websocket";
    }>>;
    webhookPath: z$1.ZodOptional<z$1.ZodString>;
  }, z$1.core.$strict>>>>;
  webhookHost: z$1.ZodOptional<z$1.ZodString>;
  webhookPort: z$1.ZodOptional<z$1.ZodNumber>;
  capabilities: z$1.ZodOptional<z$1.ZodArray<z$1.ZodString>>;
  markdown: z$1.ZodOptional<z$1.ZodObject<{
    mode: z$1.ZodOptional<z$1.ZodEnum<{
      native: "native";
      escape: "escape";
      strip: "strip";
    }>>;
    tableMode: z$1.ZodOptional<z$1.ZodEnum<{
      native: "native";
      ascii: "ascii";
      simple: "simple";
    }>>;
  }, z$1.core.$strict>>;
  configWrites: z$1.ZodOptional<z$1.ZodBoolean>;
  allowFrom: z$1.ZodOptional<z$1.ZodArray<z$1.ZodUnion<readonly [z$1.ZodString, z$1.ZodNumber]>>>;
  groupAllowFrom: z$1.ZodOptional<z$1.ZodArray<z$1.ZodUnion<readonly [z$1.ZodString, z$1.ZodNumber]>>>;
  groupSenderAllowFrom: z$1.ZodOptional<z$1.ZodArray<z$1.ZodUnion<readonly [z$1.ZodString, z$1.ZodNumber]>>>;
  groups: z$1.ZodOptional<z$1.ZodRecord<z$1.ZodString, z$1.ZodOptional<z$1.ZodObject<{
    requireMention: z$1.ZodOptional<z$1.ZodBoolean>;
    tools: z$1.ZodOptional<z$1.ZodObject<{
      allow: z$1.ZodOptional<z$1.ZodArray<z$1.ZodString>>;
      deny: z$1.ZodOptional<z$1.ZodArray<z$1.ZodString>>;
    }, z$1.core.$strict>>;
    skills: z$1.ZodOptional<z$1.ZodArray<z$1.ZodString>>;
    enabled: z$1.ZodOptional<z$1.ZodBoolean>;
    allowFrom: z$1.ZodOptional<z$1.ZodArray<z$1.ZodUnion<readonly [z$1.ZodString, z$1.ZodNumber]>>>;
    systemPrompt: z$1.ZodOptional<z$1.ZodString>;
    groupSessionScope: z$1.ZodOptional<z$1.ZodEnum<{
      group: "group";
      group_sender: "group_sender";
      group_topic: "group_topic";
      group_topic_sender: "group_topic_sender";
    }>>;
    topicSessionMode: z$1.ZodOptional<z$1.ZodEnum<{
      enabled: "enabled";
      disabled: "disabled";
    }>>;
    replyInThread: z$1.ZodOptional<z$1.ZodEnum<{
      enabled: "enabled";
      disabled: "disabled";
    }>>;
  }, z$1.core.$strict>>>>;
  historyLimit: z$1.ZodOptional<z$1.ZodNumber>;
  dmHistoryLimit: z$1.ZodOptional<z$1.ZodNumber>;
  dms: z$1.ZodOptional<z$1.ZodRecord<z$1.ZodString, z$1.ZodOptional<z$1.ZodObject<{
    enabled: z$1.ZodOptional<z$1.ZodBoolean>;
    systemPrompt: z$1.ZodOptional<z$1.ZodString>;
  }, z$1.core.$strict>>>>;
  textChunkLimit: z$1.ZodOptional<z$1.ZodNumber>;
  chunkMode: z$1.ZodOptional<z$1.ZodEnum<{
    length: "length";
    newline: "newline";
  }>>;
  blockStreaming: z$1.ZodOptional<z$1.ZodBoolean>;
  blockStreamingCoalesce: z$1.ZodOptional<z$1.ZodObject<{
    enabled: z$1.ZodOptional<z$1.ZodBoolean>;
    minDelayMs: z$1.ZodOptional<z$1.ZodNumber>;
    maxDelayMs: z$1.ZodOptional<z$1.ZodNumber>;
  }, z$1.core.$strict>>;
  mediaMaxMb: z$1.ZodOptional<z$1.ZodNumber>;
  httpTimeoutMs: z$1.ZodOptional<z$1.ZodNumber>;
  heartbeat: z$1.ZodOptional<z$1.ZodObject<{
    visibility: z$1.ZodOptional<z$1.ZodEnum<{
      visible: "visible";
      hidden: "hidden";
    }>>;
    intervalMs: z$1.ZodOptional<z$1.ZodNumber>;
  }, z$1.core.$strict>>;
  renderMode: z$1.ZodOptional<z$1.ZodEnum<{
    raw: "raw";
    auto: "auto";
    card: "card";
  }>>;
  streaming: z$1.ZodOptional<z$1.ZodBoolean>;
  tools: z$1.ZodOptional<z$1.ZodObject<{
    doc: z$1.ZodOptional<z$1.ZodBoolean>;
    chat: z$1.ZodOptional<z$1.ZodBoolean>;
    wiki: z$1.ZodOptional<z$1.ZodBoolean>;
    drive: z$1.ZodOptional<z$1.ZodBoolean>;
    perm: z$1.ZodOptional<z$1.ZodBoolean>;
    scopes: z$1.ZodOptional<z$1.ZodBoolean>;
  }, z$1.core.$strict>>;
  actions: z$1.ZodOptional<z$1.ZodObject<{
    reactions: z$1.ZodOptional<z$1.ZodBoolean>;
  }, z$1.core.$strict>>;
  replyInThread: z$1.ZodOptional<z$1.ZodEnum<{
    enabled: "enabled";
    disabled: "disabled";
  }>>;
  tts: z$1.ZodOptional<z$1.ZodObject<{
    auto: z$1.ZodOptional<z$1.ZodEnum<{
      off: "off";
      always: "always";
      tagged: "tagged";
      inbound: "inbound";
    }>>;
    enabled: z$1.ZodOptional<z$1.ZodBoolean>;
    mode: z$1.ZodOptional<z$1.ZodEnum<{
      all: "all";
      final: "final";
    }>>;
    provider: z$1.ZodOptional<z$1.ZodString>;
    persona: z$1.ZodOptional<z$1.ZodString>;
    personas: z$1.ZodOptional<z$1.ZodRecord<z$1.ZodString, z$1.ZodRecord<z$1.ZodString, z$1.ZodUnknown>>>;
    summaryModel: z$1.ZodOptional<z$1.ZodString>;
    modelOverrides: z$1.ZodOptional<z$1.ZodRecord<z$1.ZodString, z$1.ZodUnknown>>;
    providers: z$1.ZodOptional<z$1.ZodRecord<z$1.ZodString, z$1.ZodRecord<z$1.ZodString, z$1.ZodUnknown>>>;
    prefsPath: z$1.ZodOptional<z$1.ZodString>;
    maxTextLength: z$1.ZodOptional<z$1.ZodNumber>;
    timeoutMs: z$1.ZodOptional<z$1.ZodNumber>;
  }, z$1.core.$strict>>;
  enabled: z$1.ZodOptional<z$1.ZodBoolean>;
  defaultAccount: z$1.ZodOptional<z$1.ZodString>;
  appId: z$1.ZodOptional<z$1.ZodString>;
  appSecret: z$1.ZodOptional<z$1.ZodUnion<readonly [z$1.ZodString, z$1.ZodDiscriminatedUnion<[z$1.ZodObject<{
    source: z$1.ZodLiteral<"env">;
    provider: z$1.ZodString;
    id: z$1.ZodString;
  }, z$1.core.$strip>, z$1.ZodObject<{
    source: z$1.ZodLiteral<"file">;
    provider: z$1.ZodString;
    id: z$1.ZodString;
  }, z$1.core.$strip>, z$1.ZodObject<{
    source: z$1.ZodLiteral<"exec">;
    provider: z$1.ZodString;
    id: z$1.ZodString;
  }, z$1.core.$strip>], "source">]>>;
  encryptKey: z$1.ZodOptional<z$1.ZodUnion<readonly [z$1.ZodString, z$1.ZodDiscriminatedUnion<[z$1.ZodObject<{
    source: z$1.ZodLiteral<"env">;
    provider: z$1.ZodString;
    id: z$1.ZodString;
  }, z$1.core.$strip>, z$1.ZodObject<{
    source: z$1.ZodLiteral<"file">;
    provider: z$1.ZodString;
    id: z$1.ZodString;
  }, z$1.core.$strip>, z$1.ZodObject<{
    source: z$1.ZodLiteral<"exec">;
    provider: z$1.ZodString;
    id: z$1.ZodString;
  }, z$1.core.$strip>], "source">]>>;
  verificationToken: z$1.ZodOptional<z$1.ZodUnion<readonly [z$1.ZodString, z$1.ZodDiscriminatedUnion<[z$1.ZodObject<{
    source: z$1.ZodLiteral<"env">;
    provider: z$1.ZodString;
    id: z$1.ZodString;
  }, z$1.core.$strip>, z$1.ZodObject<{
    source: z$1.ZodLiteral<"file">;
    provider: z$1.ZodString;
    id: z$1.ZodString;
  }, z$1.core.$strip>, z$1.ZodObject<{
    source: z$1.ZodLiteral<"exec">;
    provider: z$1.ZodString;
    id: z$1.ZodString;
  }, z$1.core.$strip>], "source">]>>;
  domain: z$1.ZodDefault<z$1.ZodOptional<z$1.ZodUnion<readonly [z$1.ZodEnum<{
    feishu: "feishu";
    lark: "lark";
  }>, z$1.ZodString]>>>;
  connectionMode: z$1.ZodDefault<z$1.ZodOptional<z$1.ZodEnum<{
    webhook: "webhook";
    websocket: "websocket";
  }>>>;
  webhookPath: z$1.ZodDefault<z$1.ZodOptional<z$1.ZodString>>;
}, z$1.core.$strict>;
//#endregion
//#region extensions/feishu/src/types.d.ts
type FeishuConfig = z$1.infer<typeof FeishuConfigSchema>;
type FeishuDomain = "feishu" | "lark" | (string & {});
type FeishuDefaultAccountSelectionSource = "explicit-default" | "mapped-default" | "fallback";
type FeishuAccountSelectionSource = "explicit" | FeishuDefaultAccountSelectionSource;
type ResolvedFeishuAccount = {
  accountId: string;
  selectionSource: FeishuAccountSelectionSource;
  enabled: boolean;
  configured: boolean;
  name?: string;
  appId?: string;
  appSecret?: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain; /** Merged config (top-level defaults + account-specific overrides) */
  config: FeishuConfig;
};
interface FeishuProbeResult extends BaseProbeResult {
  appId?: string;
  botName?: string;
  botOpenId?: string;
}
//#endregion
//#region extensions/feishu/src/channel.d.ts
declare const feishuPlugin: ChannelPlugin<ResolvedFeishuAccount, FeishuProbeResult>;
//#endregion
export { feishuPlugin as t };