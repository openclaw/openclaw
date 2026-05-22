import { t as BaseProbeResult } from "./types.core-gexONR-2.js";
import { n as ChannelPlugin } from "./types.public-D_xOTs5v.js";
import { t as zod_d_exports } from "./zod-Cjas1ftF.js";
//#region extensions/feishu/src/config-schema.d.ts
declare const FeishuConfigSchema: zod_d_exports.z.ZodObject<{
  dmPolicy: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    pairing: "pairing";
    allowlist: "allowlist";
    open: "open";
  }>>>;
  reactionNotifications: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    off: "off";
    all: "all";
    own: "own";
  }>>>>;
  groupPolicy: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    open: "open";
  }>, zod_d_exports.z.ZodPipe<zod_d_exports.z.ZodLiteral<"allowall">, zod_d_exports.z.ZodTransform<"open", "allowall">>]>>>;
  requireMention: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
  groupSessionScope: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    group: "group";
    group_sender: "group_sender";
    group_topic: "group_topic";
    group_topic_sender: "group_topic_sender";
  }>>;
  topicSessionMode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    enabled: "enabled";
    disabled: "disabled";
  }>>;
  dynamicAgentCreation: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
    enabled: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    workspaceTemplate: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    agentDirTemplate: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    maxAgents: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
  }, zod_d_exports.z.core.$strict>>;
  typingIndicator: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>>;
  resolveSenderNames: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>>;
  accounts: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
    groupSessionScope: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      group: "group";
      group_sender: "group_sender";
      group_topic: "group_topic";
      group_topic_sender: "group_topic_sender";
    }>>;
    topicSessionMode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      enabled: "enabled";
      disabled: "disabled";
    }>>;
    webhookHost: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    webhookPort: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
    capabilities: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodString>>;
    markdown: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
      mode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
        native: "native";
        escape: "escape";
        strip: "strip";
      }>>;
      tableMode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
        native: "native";
        ascii: "ascii";
        simple: "simple";
      }>>;
    }, zod_d_exports.z.core.$strict>>;
    configWrites: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    dmPolicy: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      pairing: "pairing";
      allowlist: "allowlist";
      open: "open";
    }>>;
    allowFrom: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodNumber]>>>;
    groupPolicy: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      open: "open";
    }>, zod_d_exports.z.ZodPipe<zod_d_exports.z.ZodLiteral<"allowall">, zod_d_exports.z.ZodTransform<"open", "allowall">>]>>;
    groupAllowFrom: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodNumber]>>>;
    groupSenderAllowFrom: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodNumber]>>>;
    requireMention: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    groups: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
      requireMention: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      tools: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
        allow: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodString>>;
        deny: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodString>>;
      }, zod_d_exports.z.core.$strict>>;
      skills: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodString>>;
      enabled: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      allowFrom: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodNumber]>>>;
      systemPrompt: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
      groupSessionScope: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
        group: "group";
        group_sender: "group_sender";
        group_topic: "group_topic";
        group_topic_sender: "group_topic_sender";
      }>>;
      topicSessionMode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
        enabled: "enabled";
        disabled: "disabled";
      }>>;
      replyInThread: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
        enabled: "enabled";
        disabled: "disabled";
      }>>;
    }, zod_d_exports.z.core.$strict>>>>;
    historyLimit: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
    dmHistoryLimit: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
    dms: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
      enabled: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      systemPrompt: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    }, zod_d_exports.z.core.$strict>>>>;
    textChunkLimit: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
    chunkMode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      length: "length";
      newline: "newline";
    }>>;
    blockStreaming: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    blockStreamingCoalesce: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
      enabled: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      minDelayMs: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
      maxDelayMs: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
    }, zod_d_exports.z.core.$strict>>;
    mediaMaxMb: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
    httpTimeoutMs: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
    heartbeat: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
      visibility: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
        visible: "visible";
        hidden: "hidden";
      }>>;
      intervalMs: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
    }, zod_d_exports.z.core.$strict>>;
    renderMode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      raw: "raw";
      auto: "auto";
      card: "card";
    }>>;
    streaming: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    tools: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
      doc: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      chat: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      wiki: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      drive: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      perm: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      scopes: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    }, zod_d_exports.z.core.$strict>>;
    actions: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
      reactions: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    }, zod_d_exports.z.core.$strict>>;
    replyInThread: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      enabled: "enabled";
      disabled: "disabled";
    }>>;
    reactionNotifications: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      off: "off";
      all: "all";
      own: "own";
    }>>;
    typingIndicator: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    resolveSenderNames: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    tts: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
      auto: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
        off: "off";
        tagged: "tagged";
        always: "always";
        inbound: "inbound";
      }>>;
      enabled: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      mode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
        all: "all";
        final: "final";
      }>>;
      provider: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
      persona: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
      personas: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodUnknown>>>;
      summaryModel: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
      modelOverrides: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodUnknown>>;
      providers: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodUnknown>>>;
      prefsPath: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
      maxTextLength: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
      timeoutMs: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
    }, zod_d_exports.z.core.$strict>>;
    enabled: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    name: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    appId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    appSecret: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodDiscriminatedUnion<[zod_d_exports.z.ZodObject<{
      source: zod_d_exports.z.ZodLiteral<"env">;
      provider: zod_d_exports.z.ZodString;
      id: zod_d_exports.z.ZodString;
    }, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
      source: zod_d_exports.z.ZodLiteral<"file">;
      provider: zod_d_exports.z.ZodString;
      id: zod_d_exports.z.ZodString;
    }, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
      source: zod_d_exports.z.ZodLiteral<"exec">;
      provider: zod_d_exports.z.ZodString;
      id: zod_d_exports.z.ZodString;
    }, zod_d_exports.z.core.$strip>], "source">]>>;
    encryptKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodDiscriminatedUnion<[zod_d_exports.z.ZodObject<{
      source: zod_d_exports.z.ZodLiteral<"env">;
      provider: zod_d_exports.z.ZodString;
      id: zod_d_exports.z.ZodString;
    }, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
      source: zod_d_exports.z.ZodLiteral<"file">;
      provider: zod_d_exports.z.ZodString;
      id: zod_d_exports.z.ZodString;
    }, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
      source: zod_d_exports.z.ZodLiteral<"exec">;
      provider: zod_d_exports.z.ZodString;
      id: zod_d_exports.z.ZodString;
    }, zod_d_exports.z.core.$strip>], "source">]>>;
    verificationToken: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodDiscriminatedUnion<[zod_d_exports.z.ZodObject<{
      source: zod_d_exports.z.ZodLiteral<"env">;
      provider: zod_d_exports.z.ZodString;
      id: zod_d_exports.z.ZodString;
    }, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
      source: zod_d_exports.z.ZodLiteral<"file">;
      provider: zod_d_exports.z.ZodString;
      id: zod_d_exports.z.ZodString;
    }, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
      source: zod_d_exports.z.ZodLiteral<"exec">;
      provider: zod_d_exports.z.ZodString;
      id: zod_d_exports.z.ZodString;
    }, zod_d_exports.z.core.$strip>], "source">]>>;
    domain: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodEnum<{
      feishu: "feishu";
      lark: "lark";
    }>, zod_d_exports.z.ZodString]>>;
    connectionMode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      webhook: "webhook";
      websocket: "websocket";
    }>>;
    webhookPath: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  }, zod_d_exports.z.core.$strict>>>>;
  webhookHost: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  webhookPort: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
  capabilities: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodString>>;
  markdown: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
    mode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      native: "native";
      escape: "escape";
      strip: "strip";
    }>>;
    tableMode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      native: "native";
      ascii: "ascii";
      simple: "simple";
    }>>;
  }, zod_d_exports.z.core.$strict>>;
  configWrites: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
  allowFrom: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodNumber]>>>;
  groupAllowFrom: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodNumber]>>>;
  groupSenderAllowFrom: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodNumber]>>>;
  groups: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
    requireMention: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    tools: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
      allow: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodString>>;
      deny: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodString>>;
    }, zod_d_exports.z.core.$strict>>;
    skills: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodString>>;
    enabled: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    allowFrom: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodNumber]>>>;
    systemPrompt: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    groupSessionScope: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      group: "group";
      group_sender: "group_sender";
      group_topic: "group_topic";
      group_topic_sender: "group_topic_sender";
    }>>;
    topicSessionMode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      enabled: "enabled";
      disabled: "disabled";
    }>>;
    replyInThread: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      enabled: "enabled";
      disabled: "disabled";
    }>>;
  }, zod_d_exports.z.core.$strict>>>>;
  historyLimit: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
  dmHistoryLimit: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
  dms: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
    enabled: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    systemPrompt: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  }, zod_d_exports.z.core.$strict>>>>;
  textChunkLimit: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
  chunkMode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    length: "length";
    newline: "newline";
  }>>;
  blockStreaming: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
  blockStreamingCoalesce: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
    enabled: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    minDelayMs: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
    maxDelayMs: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
  }, zod_d_exports.z.core.$strict>>;
  mediaMaxMb: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
  httpTimeoutMs: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
  heartbeat: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
    visibility: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      visible: "visible";
      hidden: "hidden";
    }>>;
    intervalMs: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
  }, zod_d_exports.z.core.$strict>>;
  renderMode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    raw: "raw";
    auto: "auto";
    card: "card";
  }>>;
  streaming: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
  tools: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
    doc: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    chat: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    wiki: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    drive: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    perm: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    scopes: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
  }, zod_d_exports.z.core.$strict>>;
  actions: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
    reactions: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
  }, zod_d_exports.z.core.$strict>>;
  replyInThread: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    enabled: "enabled";
    disabled: "disabled";
  }>>;
  tts: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
    auto: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      off: "off";
      tagged: "tagged";
      always: "always";
      inbound: "inbound";
    }>>;
    enabled: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    mode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      all: "all";
      final: "final";
    }>>;
    provider: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    persona: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    personas: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodUnknown>>>;
    summaryModel: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    modelOverrides: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodUnknown>>;
    providers: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodUnknown>>>;
    prefsPath: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    maxTextLength: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
    timeoutMs: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
  }, zod_d_exports.z.core.$strict>>;
  enabled: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
  defaultAccount: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  appId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  appSecret: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodDiscriminatedUnion<[zod_d_exports.z.ZodObject<{
    source: zod_d_exports.z.ZodLiteral<"env">;
    provider: zod_d_exports.z.ZodString;
    id: zod_d_exports.z.ZodString;
  }, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
    source: zod_d_exports.z.ZodLiteral<"file">;
    provider: zod_d_exports.z.ZodString;
    id: zod_d_exports.z.ZodString;
  }, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
    source: zod_d_exports.z.ZodLiteral<"exec">;
    provider: zod_d_exports.z.ZodString;
    id: zod_d_exports.z.ZodString;
  }, zod_d_exports.z.core.$strip>], "source">]>>;
  encryptKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodDiscriminatedUnion<[zod_d_exports.z.ZodObject<{
    source: zod_d_exports.z.ZodLiteral<"env">;
    provider: zod_d_exports.z.ZodString;
    id: zod_d_exports.z.ZodString;
  }, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
    source: zod_d_exports.z.ZodLiteral<"file">;
    provider: zod_d_exports.z.ZodString;
    id: zod_d_exports.z.ZodString;
  }, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
    source: zod_d_exports.z.ZodLiteral<"exec">;
    provider: zod_d_exports.z.ZodString;
    id: zod_d_exports.z.ZodString;
  }, zod_d_exports.z.core.$strip>], "source">]>>;
  verificationToken: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodDiscriminatedUnion<[zod_d_exports.z.ZodObject<{
    source: zod_d_exports.z.ZodLiteral<"env">;
    provider: zod_d_exports.z.ZodString;
    id: zod_d_exports.z.ZodString;
  }, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
    source: zod_d_exports.z.ZodLiteral<"file">;
    provider: zod_d_exports.z.ZodString;
    id: zod_d_exports.z.ZodString;
  }, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
    source: zod_d_exports.z.ZodLiteral<"exec">;
    provider: zod_d_exports.z.ZodString;
    id: zod_d_exports.z.ZodString;
  }, zod_d_exports.z.core.$strip>], "source">]>>;
  domain: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodEnum<{
    feishu: "feishu";
    lark: "lark";
  }>, zod_d_exports.z.ZodString]>>>;
  connectionMode: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    webhook: "webhook";
    websocket: "websocket";
  }>>>;
  webhookPath: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>>;
}, zod_d_exports.z.core.$strict>;
//#endregion
//#region extensions/feishu/src/types.d.ts
type FeishuConfig = zod_d_exports.z.infer<typeof FeishuConfigSchema>;
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