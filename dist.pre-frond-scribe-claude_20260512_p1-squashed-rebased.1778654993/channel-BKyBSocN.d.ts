import { t as BaseProbeResult } from "./types.core-BDQOD1ST.js";
import { n as ChannelPlugin } from "./types.public-D-nwYThg.js";
import { z as z$2 } from "zod";

//#region extensions/feishu/src/config-schema.d.ts
declare const FeishuConfigSchema: z$2.ZodObject<{
  dmPolicy: z$2.ZodDefault<z$2.ZodOptional<z$2.ZodEnum<{
    allowlist: "allowlist";
    pairing: "pairing";
    open: "open";
  }>>>;
  reactionNotifications: z$2.ZodDefault<z$2.ZodOptional<z$2.ZodOptional<z$2.ZodEnum<{
    off: "off";
    all: "all";
    own: "own";
  }>>>>;
  groupPolicy: z$2.ZodDefault<z$2.ZodOptional<z$2.ZodUnion<readonly [z$2.ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    open: "open";
  }>, z$2.ZodPipe<z$2.ZodLiteral<"allowall">, z$2.ZodTransform<"open", "allowall">>]>>>;
  requireMention: z$2.ZodOptional<z$2.ZodBoolean>;
  groupSessionScope: z$2.ZodOptional<z$2.ZodEnum<{
    group: "group";
    group_sender: "group_sender";
    group_topic: "group_topic";
    group_topic_sender: "group_topic_sender";
  }>>;
  topicSessionMode: z$2.ZodOptional<z$2.ZodEnum<{
    enabled: "enabled";
    disabled: "disabled";
  }>>;
  dynamicAgentCreation: z$2.ZodOptional<z$2.ZodObject<{
    enabled: z$2.ZodOptional<z$2.ZodBoolean>;
    workspaceTemplate: z$2.ZodOptional<z$2.ZodString>;
    agentDirTemplate: z$2.ZodOptional<z$2.ZodString>;
    maxAgents: z$2.ZodOptional<z$2.ZodNumber>;
  }, z$2.core.$strict>>;
  typingIndicator: z$2.ZodDefault<z$2.ZodOptional<z$2.ZodBoolean>>;
  resolveSenderNames: z$2.ZodDefault<z$2.ZodOptional<z$2.ZodBoolean>>;
  accounts: z$2.ZodOptional<z$2.ZodRecord<z$2.ZodString, z$2.ZodOptional<z$2.ZodObject<{
    groupSessionScope: z$2.ZodOptional<z$2.ZodEnum<{
      group: "group";
      group_sender: "group_sender";
      group_topic: "group_topic";
      group_topic_sender: "group_topic_sender";
    }>>;
    topicSessionMode: z$2.ZodOptional<z$2.ZodEnum<{
      enabled: "enabled";
      disabled: "disabled";
    }>>;
    webhookHost: z$2.ZodOptional<z$2.ZodString>;
    webhookPort: z$2.ZodOptional<z$2.ZodNumber>;
    capabilities: z$2.ZodOptional<z$2.ZodArray<z$2.ZodString>>;
    markdown: z$2.ZodOptional<z$2.ZodObject<{
      mode: z$2.ZodOptional<z$2.ZodEnum<{
        native: "native";
        escape: "escape";
        strip: "strip";
      }>>;
      tableMode: z$2.ZodOptional<z$2.ZodEnum<{
        native: "native";
        ascii: "ascii";
        simple: "simple";
      }>>;
    }, z$2.core.$strict>>;
    configWrites: z$2.ZodOptional<z$2.ZodBoolean>;
    dmPolicy: z$2.ZodOptional<z$2.ZodEnum<{
      allowlist: "allowlist";
      pairing: "pairing";
      open: "open";
    }>>;
    allowFrom: z$2.ZodOptional<z$2.ZodArray<z$2.ZodUnion<readonly [z$2.ZodString, z$2.ZodNumber]>>>;
    groupPolicy: z$2.ZodOptional<z$2.ZodUnion<readonly [z$2.ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      open: "open";
    }>, z$2.ZodPipe<z$2.ZodLiteral<"allowall">, z$2.ZodTransform<"open", "allowall">>]>>;
    groupAllowFrom: z$2.ZodOptional<z$2.ZodArray<z$2.ZodUnion<readonly [z$2.ZodString, z$2.ZodNumber]>>>;
    groupSenderAllowFrom: z$2.ZodOptional<z$2.ZodArray<z$2.ZodUnion<readonly [z$2.ZodString, z$2.ZodNumber]>>>;
    requireMention: z$2.ZodOptional<z$2.ZodBoolean>;
    groups: z$2.ZodOptional<z$2.ZodRecord<z$2.ZodString, z$2.ZodOptional<z$2.ZodObject<{
      requireMention: z$2.ZodOptional<z$2.ZodBoolean>;
      tools: z$2.ZodOptional<z$2.ZodObject<{
        allow: z$2.ZodOptional<z$2.ZodArray<z$2.ZodString>>;
        deny: z$2.ZodOptional<z$2.ZodArray<z$2.ZodString>>;
      }, z$2.core.$strict>>;
      skills: z$2.ZodOptional<z$2.ZodArray<z$2.ZodString>>;
      enabled: z$2.ZodOptional<z$2.ZodBoolean>;
      allowFrom: z$2.ZodOptional<z$2.ZodArray<z$2.ZodUnion<readonly [z$2.ZodString, z$2.ZodNumber]>>>;
      systemPrompt: z$2.ZodOptional<z$2.ZodString>;
      groupSessionScope: z$2.ZodOptional<z$2.ZodEnum<{
        group: "group";
        group_sender: "group_sender";
        group_topic: "group_topic";
        group_topic_sender: "group_topic_sender";
      }>>;
      topicSessionMode: z$2.ZodOptional<z$2.ZodEnum<{
        enabled: "enabled";
        disabled: "disabled";
      }>>;
      replyInThread: z$2.ZodOptional<z$2.ZodEnum<{
        enabled: "enabled";
        disabled: "disabled";
      }>>;
    }, z$2.core.$strict>>>>;
    historyLimit: z$2.ZodOptional<z$2.ZodNumber>;
    dmHistoryLimit: z$2.ZodOptional<z$2.ZodNumber>;
    dms: z$2.ZodOptional<z$2.ZodRecord<z$2.ZodString, z$2.ZodOptional<z$2.ZodObject<{
      enabled: z$2.ZodOptional<z$2.ZodBoolean>;
      systemPrompt: z$2.ZodOptional<z$2.ZodString>;
    }, z$2.core.$strict>>>>;
    textChunkLimit: z$2.ZodOptional<z$2.ZodNumber>;
    chunkMode: z$2.ZodOptional<z$2.ZodEnum<{
      length: "length";
      newline: "newline";
    }>>;
    blockStreaming: z$2.ZodOptional<z$2.ZodBoolean>;
    blockStreamingCoalesce: z$2.ZodOptional<z$2.ZodObject<{
      enabled: z$2.ZodOptional<z$2.ZodBoolean>;
      minDelayMs: z$2.ZodOptional<z$2.ZodNumber>;
      maxDelayMs: z$2.ZodOptional<z$2.ZodNumber>;
    }, z$2.core.$strict>>;
    mediaMaxMb: z$2.ZodOptional<z$2.ZodNumber>;
    httpTimeoutMs: z$2.ZodOptional<z$2.ZodNumber>;
    heartbeat: z$2.ZodOptional<z$2.ZodObject<{
      visibility: z$2.ZodOptional<z$2.ZodEnum<{
        visible: "visible";
        hidden: "hidden";
      }>>;
      intervalMs: z$2.ZodOptional<z$2.ZodNumber>;
    }, z$2.core.$strict>>;
    renderMode: z$2.ZodOptional<z$2.ZodEnum<{
      raw: "raw";
      auto: "auto";
      card: "card";
    }>>;
    streaming: z$2.ZodOptional<z$2.ZodBoolean>;
    tools: z$2.ZodOptional<z$2.ZodObject<{
      doc: z$2.ZodOptional<z$2.ZodBoolean>;
      chat: z$2.ZodOptional<z$2.ZodBoolean>;
      wiki: z$2.ZodOptional<z$2.ZodBoolean>;
      drive: z$2.ZodOptional<z$2.ZodBoolean>;
      perm: z$2.ZodOptional<z$2.ZodBoolean>;
      scopes: z$2.ZodOptional<z$2.ZodBoolean>;
    }, z$2.core.$strict>>;
    actions: z$2.ZodOptional<z$2.ZodObject<{
      reactions: z$2.ZodOptional<z$2.ZodBoolean>;
    }, z$2.core.$strict>>;
    replyInThread: z$2.ZodOptional<z$2.ZodEnum<{
      enabled: "enabled";
      disabled: "disabled";
    }>>;
    reactionNotifications: z$2.ZodOptional<z$2.ZodEnum<{
      off: "off";
      all: "all";
      own: "own";
    }>>;
    typingIndicator: z$2.ZodOptional<z$2.ZodBoolean>;
    resolveSenderNames: z$2.ZodOptional<z$2.ZodBoolean>;
    tts: z$2.ZodOptional<z$2.ZodObject<{
      auto: z$2.ZodOptional<z$2.ZodEnum<{
        off: "off";
        always: "always";
        tagged: "tagged";
        inbound: "inbound";
      }>>;
      enabled: z$2.ZodOptional<z$2.ZodBoolean>;
      mode: z$2.ZodOptional<z$2.ZodEnum<{
        all: "all";
        final: "final";
      }>>;
      provider: z$2.ZodOptional<z$2.ZodString>;
      persona: z$2.ZodOptional<z$2.ZodString>;
      personas: z$2.ZodOptional<z$2.ZodRecord<z$2.ZodString, z$2.ZodRecord<z$2.ZodString, z$2.ZodUnknown>>>;
      summaryModel: z$2.ZodOptional<z$2.ZodString>;
      modelOverrides: z$2.ZodOptional<z$2.ZodRecord<z$2.ZodString, z$2.ZodUnknown>>;
      providers: z$2.ZodOptional<z$2.ZodRecord<z$2.ZodString, z$2.ZodRecord<z$2.ZodString, z$2.ZodUnknown>>>;
      prefsPath: z$2.ZodOptional<z$2.ZodString>;
      maxTextLength: z$2.ZodOptional<z$2.ZodNumber>;
      timeoutMs: z$2.ZodOptional<z$2.ZodNumber>;
    }, z$2.core.$strict>>;
    enabled: z$2.ZodOptional<z$2.ZodBoolean>;
    name: z$2.ZodOptional<z$2.ZodString>;
    appId: z$2.ZodOptional<z$2.ZodString>;
    appSecret: z$2.ZodOptional<z$2.ZodUnion<readonly [z$2.ZodString, z$2.ZodDiscriminatedUnion<[z$2.ZodObject<{
      source: z$2.ZodLiteral<"env">;
      provider: z$2.ZodString;
      id: z$2.ZodString;
    }, z$2.core.$strip>, z$2.ZodObject<{
      source: z$2.ZodLiteral<"file">;
      provider: z$2.ZodString;
      id: z$2.ZodString;
    }, z$2.core.$strip>, z$2.ZodObject<{
      source: z$2.ZodLiteral<"exec">;
      provider: z$2.ZodString;
      id: z$2.ZodString;
    }, z$2.core.$strip>], "source">]>>;
    encryptKey: z$2.ZodOptional<z$2.ZodUnion<readonly [z$2.ZodString, z$2.ZodDiscriminatedUnion<[z$2.ZodObject<{
      source: z$2.ZodLiteral<"env">;
      provider: z$2.ZodString;
      id: z$2.ZodString;
    }, z$2.core.$strip>, z$2.ZodObject<{
      source: z$2.ZodLiteral<"file">;
      provider: z$2.ZodString;
      id: z$2.ZodString;
    }, z$2.core.$strip>, z$2.ZodObject<{
      source: z$2.ZodLiteral<"exec">;
      provider: z$2.ZodString;
      id: z$2.ZodString;
    }, z$2.core.$strip>], "source">]>>;
    verificationToken: z$2.ZodOptional<z$2.ZodUnion<readonly [z$2.ZodString, z$2.ZodDiscriminatedUnion<[z$2.ZodObject<{
      source: z$2.ZodLiteral<"env">;
      provider: z$2.ZodString;
      id: z$2.ZodString;
    }, z$2.core.$strip>, z$2.ZodObject<{
      source: z$2.ZodLiteral<"file">;
      provider: z$2.ZodString;
      id: z$2.ZodString;
    }, z$2.core.$strip>, z$2.ZodObject<{
      source: z$2.ZodLiteral<"exec">;
      provider: z$2.ZodString;
      id: z$2.ZodString;
    }, z$2.core.$strip>], "source">]>>;
    domain: z$2.ZodOptional<z$2.ZodUnion<readonly [z$2.ZodEnum<{
      feishu: "feishu";
      lark: "lark";
    }>, z$2.ZodString]>>;
    connectionMode: z$2.ZodOptional<z$2.ZodEnum<{
      webhook: "webhook";
      websocket: "websocket";
    }>>;
    webhookPath: z$2.ZodOptional<z$2.ZodString>;
  }, z$2.core.$strict>>>>;
  webhookHost: z$2.ZodOptional<z$2.ZodString>;
  webhookPort: z$2.ZodOptional<z$2.ZodNumber>;
  capabilities: z$2.ZodOptional<z$2.ZodArray<z$2.ZodString>>;
  markdown: z$2.ZodOptional<z$2.ZodObject<{
    mode: z$2.ZodOptional<z$2.ZodEnum<{
      native: "native";
      escape: "escape";
      strip: "strip";
    }>>;
    tableMode: z$2.ZodOptional<z$2.ZodEnum<{
      native: "native";
      ascii: "ascii";
      simple: "simple";
    }>>;
  }, z$2.core.$strict>>;
  configWrites: z$2.ZodOptional<z$2.ZodBoolean>;
  allowFrom: z$2.ZodOptional<z$2.ZodArray<z$2.ZodUnion<readonly [z$2.ZodString, z$2.ZodNumber]>>>;
  groupAllowFrom: z$2.ZodOptional<z$2.ZodArray<z$2.ZodUnion<readonly [z$2.ZodString, z$2.ZodNumber]>>>;
  groupSenderAllowFrom: z$2.ZodOptional<z$2.ZodArray<z$2.ZodUnion<readonly [z$2.ZodString, z$2.ZodNumber]>>>;
  groups: z$2.ZodOptional<z$2.ZodRecord<z$2.ZodString, z$2.ZodOptional<z$2.ZodObject<{
    requireMention: z$2.ZodOptional<z$2.ZodBoolean>;
    tools: z$2.ZodOptional<z$2.ZodObject<{
      allow: z$2.ZodOptional<z$2.ZodArray<z$2.ZodString>>;
      deny: z$2.ZodOptional<z$2.ZodArray<z$2.ZodString>>;
    }, z$2.core.$strict>>;
    skills: z$2.ZodOptional<z$2.ZodArray<z$2.ZodString>>;
    enabled: z$2.ZodOptional<z$2.ZodBoolean>;
    allowFrom: z$2.ZodOptional<z$2.ZodArray<z$2.ZodUnion<readonly [z$2.ZodString, z$2.ZodNumber]>>>;
    systemPrompt: z$2.ZodOptional<z$2.ZodString>;
    groupSessionScope: z$2.ZodOptional<z$2.ZodEnum<{
      group: "group";
      group_sender: "group_sender";
      group_topic: "group_topic";
      group_topic_sender: "group_topic_sender";
    }>>;
    topicSessionMode: z$2.ZodOptional<z$2.ZodEnum<{
      enabled: "enabled";
      disabled: "disabled";
    }>>;
    replyInThread: z$2.ZodOptional<z$2.ZodEnum<{
      enabled: "enabled";
      disabled: "disabled";
    }>>;
  }, z$2.core.$strict>>>>;
  historyLimit: z$2.ZodOptional<z$2.ZodNumber>;
  dmHistoryLimit: z$2.ZodOptional<z$2.ZodNumber>;
  dms: z$2.ZodOptional<z$2.ZodRecord<z$2.ZodString, z$2.ZodOptional<z$2.ZodObject<{
    enabled: z$2.ZodOptional<z$2.ZodBoolean>;
    systemPrompt: z$2.ZodOptional<z$2.ZodString>;
  }, z$2.core.$strict>>>>;
  textChunkLimit: z$2.ZodOptional<z$2.ZodNumber>;
  chunkMode: z$2.ZodOptional<z$2.ZodEnum<{
    length: "length";
    newline: "newline";
  }>>;
  blockStreaming: z$2.ZodOptional<z$2.ZodBoolean>;
  blockStreamingCoalesce: z$2.ZodOptional<z$2.ZodObject<{
    enabled: z$2.ZodOptional<z$2.ZodBoolean>;
    minDelayMs: z$2.ZodOptional<z$2.ZodNumber>;
    maxDelayMs: z$2.ZodOptional<z$2.ZodNumber>;
  }, z$2.core.$strict>>;
  mediaMaxMb: z$2.ZodOptional<z$2.ZodNumber>;
  httpTimeoutMs: z$2.ZodOptional<z$2.ZodNumber>;
  heartbeat: z$2.ZodOptional<z$2.ZodObject<{
    visibility: z$2.ZodOptional<z$2.ZodEnum<{
      visible: "visible";
      hidden: "hidden";
    }>>;
    intervalMs: z$2.ZodOptional<z$2.ZodNumber>;
  }, z$2.core.$strict>>;
  renderMode: z$2.ZodOptional<z$2.ZodEnum<{
    raw: "raw";
    auto: "auto";
    card: "card";
  }>>;
  streaming: z$2.ZodOptional<z$2.ZodBoolean>;
  tools: z$2.ZodOptional<z$2.ZodObject<{
    doc: z$2.ZodOptional<z$2.ZodBoolean>;
    chat: z$2.ZodOptional<z$2.ZodBoolean>;
    wiki: z$2.ZodOptional<z$2.ZodBoolean>;
    drive: z$2.ZodOptional<z$2.ZodBoolean>;
    perm: z$2.ZodOptional<z$2.ZodBoolean>;
    scopes: z$2.ZodOptional<z$2.ZodBoolean>;
  }, z$2.core.$strict>>;
  actions: z$2.ZodOptional<z$2.ZodObject<{
    reactions: z$2.ZodOptional<z$2.ZodBoolean>;
  }, z$2.core.$strict>>;
  replyInThread: z$2.ZodOptional<z$2.ZodEnum<{
    enabled: "enabled";
    disabled: "disabled";
  }>>;
  tts: z$2.ZodOptional<z$2.ZodObject<{
    auto: z$2.ZodOptional<z$2.ZodEnum<{
      off: "off";
      always: "always";
      tagged: "tagged";
      inbound: "inbound";
    }>>;
    enabled: z$2.ZodOptional<z$2.ZodBoolean>;
    mode: z$2.ZodOptional<z$2.ZodEnum<{
      all: "all";
      final: "final";
    }>>;
    provider: z$2.ZodOptional<z$2.ZodString>;
    persona: z$2.ZodOptional<z$2.ZodString>;
    personas: z$2.ZodOptional<z$2.ZodRecord<z$2.ZodString, z$2.ZodRecord<z$2.ZodString, z$2.ZodUnknown>>>;
    summaryModel: z$2.ZodOptional<z$2.ZodString>;
    modelOverrides: z$2.ZodOptional<z$2.ZodRecord<z$2.ZodString, z$2.ZodUnknown>>;
    providers: z$2.ZodOptional<z$2.ZodRecord<z$2.ZodString, z$2.ZodRecord<z$2.ZodString, z$2.ZodUnknown>>>;
    prefsPath: z$2.ZodOptional<z$2.ZodString>;
    maxTextLength: z$2.ZodOptional<z$2.ZodNumber>;
    timeoutMs: z$2.ZodOptional<z$2.ZodNumber>;
  }, z$2.core.$strict>>;
  enabled: z$2.ZodOptional<z$2.ZodBoolean>;
  defaultAccount: z$2.ZodOptional<z$2.ZodString>;
  appId: z$2.ZodOptional<z$2.ZodString>;
  appSecret: z$2.ZodOptional<z$2.ZodUnion<readonly [z$2.ZodString, z$2.ZodDiscriminatedUnion<[z$2.ZodObject<{
    source: z$2.ZodLiteral<"env">;
    provider: z$2.ZodString;
    id: z$2.ZodString;
  }, z$2.core.$strip>, z$2.ZodObject<{
    source: z$2.ZodLiteral<"file">;
    provider: z$2.ZodString;
    id: z$2.ZodString;
  }, z$2.core.$strip>, z$2.ZodObject<{
    source: z$2.ZodLiteral<"exec">;
    provider: z$2.ZodString;
    id: z$2.ZodString;
  }, z$2.core.$strip>], "source">]>>;
  encryptKey: z$2.ZodOptional<z$2.ZodUnion<readonly [z$2.ZodString, z$2.ZodDiscriminatedUnion<[z$2.ZodObject<{
    source: z$2.ZodLiteral<"env">;
    provider: z$2.ZodString;
    id: z$2.ZodString;
  }, z$2.core.$strip>, z$2.ZodObject<{
    source: z$2.ZodLiteral<"file">;
    provider: z$2.ZodString;
    id: z$2.ZodString;
  }, z$2.core.$strip>, z$2.ZodObject<{
    source: z$2.ZodLiteral<"exec">;
    provider: z$2.ZodString;
    id: z$2.ZodString;
  }, z$2.core.$strip>], "source">]>>;
  verificationToken: z$2.ZodOptional<z$2.ZodUnion<readonly [z$2.ZodString, z$2.ZodDiscriminatedUnion<[z$2.ZodObject<{
    source: z$2.ZodLiteral<"env">;
    provider: z$2.ZodString;
    id: z$2.ZodString;
  }, z$2.core.$strip>, z$2.ZodObject<{
    source: z$2.ZodLiteral<"file">;
    provider: z$2.ZodString;
    id: z$2.ZodString;
  }, z$2.core.$strip>, z$2.ZodObject<{
    source: z$2.ZodLiteral<"exec">;
    provider: z$2.ZodString;
    id: z$2.ZodString;
  }, z$2.core.$strip>], "source">]>>;
  domain: z$2.ZodDefault<z$2.ZodOptional<z$2.ZodUnion<readonly [z$2.ZodEnum<{
    feishu: "feishu";
    lark: "lark";
  }>, z$2.ZodString]>>>;
  connectionMode: z$2.ZodDefault<z$2.ZodOptional<z$2.ZodEnum<{
    webhook: "webhook";
    websocket: "websocket";
  }>>>;
  webhookPath: z$2.ZodDefault<z$2.ZodOptional<z$2.ZodString>>;
}, z$2.core.$strict>;
//#endregion
//#region extensions/feishu/src/types.d.ts
type FeishuConfig = z$2.infer<typeof FeishuConfigSchema>;
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