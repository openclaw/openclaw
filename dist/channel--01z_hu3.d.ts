import { $ as ZodPipe, B as ZodLiteral, C as ZodEnum, Mi as output, Q as ZodOptional, Y as ZodNumber, Z as ZodObject, bt as ZodUnion, c as ZodBoolean, ft as ZodTransform, it as ZodRecord, na as $strict, r as ZodArray, ra as $strip, st as ZodString, v as ZodDefault, xt as ZodUnknown, y as ZodDiscriminatedUnion } from "./schemas-CkRCGSfd.js";
import { t as BaseProbeResult } from "./types.core-BkmTlRzr.js";
import { n as ChannelPlugin } from "./types.public-B2Ho5PN_.js";
//#region extensions/feishu/src/config-schema.d.ts
declare const FeishuConfigSchema: ZodObject<{
  dmPolicy: ZodDefault<ZodOptional<ZodEnum<{
    allowlist: "allowlist";
    pairing: "pairing";
    open: "open";
  }>>>;
  reactionNotifications: ZodDefault<ZodOptional<ZodOptional<ZodEnum<{
    off: "off";
    all: "all";
    own: "own";
  }>>>>;
  groupPolicy: ZodDefault<ZodOptional<ZodUnion<readonly [ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    open: "open";
  }>, ZodPipe<ZodLiteral<"allowall">, ZodTransform<"open", "allowall">>]>>>;
  requireMention: ZodOptional<ZodBoolean>;
  groupSessionScope: ZodOptional<ZodEnum<{
    group: "group";
    group_sender: "group_sender";
    group_topic: "group_topic";
    group_topic_sender: "group_topic_sender";
  }>>;
  topicSessionMode: ZodOptional<ZodEnum<{
    enabled: "enabled";
    disabled: "disabled";
  }>>;
  dynamicAgentCreation: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    workspaceTemplate: ZodOptional<ZodString>;
    agentDirTemplate: ZodOptional<ZodString>;
    maxAgents: ZodOptional<ZodNumber>;
  }, $strict>>;
  typingIndicator: ZodDefault<ZodOptional<ZodBoolean>>;
  resolveSenderNames: ZodDefault<ZodOptional<ZodBoolean>>;
  accounts: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    groupSessionScope: ZodOptional<ZodEnum<{
      group: "group";
      group_sender: "group_sender";
      group_topic: "group_topic";
      group_topic_sender: "group_topic_sender";
    }>>;
    topicSessionMode: ZodOptional<ZodEnum<{
      enabled: "enabled";
      disabled: "disabled";
    }>>;
    webhookHost: ZodOptional<ZodString>;
    webhookPort: ZodOptional<ZodNumber>;
    capabilities: ZodOptional<ZodArray<ZodString>>;
    markdown: ZodOptional<ZodObject<{
      mode: ZodOptional<ZodEnum<{
        native: "native";
        escape: "escape";
        strip: "strip";
      }>>;
      tableMode: ZodOptional<ZodEnum<{
        native: "native";
        ascii: "ascii";
        simple: "simple";
      }>>;
    }, $strict>>;
    configWrites: ZodOptional<ZodBoolean>;
    dmPolicy: ZodOptional<ZodEnum<{
      allowlist: "allowlist";
      pairing: "pairing";
      open: "open";
    }>>;
    allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    groupPolicy: ZodOptional<ZodUnion<readonly [ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      open: "open";
    }>, ZodPipe<ZodLiteral<"allowall">, ZodTransform<"open", "allowall">>]>>;
    groupAllowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    groupSenderAllowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    requireMention: ZodOptional<ZodBoolean>;
    groups: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      requireMention: ZodOptional<ZodBoolean>;
      tools: ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>;
      skills: ZodOptional<ZodArray<ZodString>>;
      enabled: ZodOptional<ZodBoolean>;
      allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
      systemPrompt: ZodOptional<ZodString>;
      groupSessionScope: ZodOptional<ZodEnum<{
        group: "group";
        group_sender: "group_sender";
        group_topic: "group_topic";
        group_topic_sender: "group_topic_sender";
      }>>;
      topicSessionMode: ZodOptional<ZodEnum<{
        enabled: "enabled";
        disabled: "disabled";
      }>>;
      replyInThread: ZodOptional<ZodEnum<{
        enabled: "enabled";
        disabled: "disabled";
      }>>;
    }, $strict>>>>;
    historyLimit: ZodOptional<ZodNumber>;
    dmHistoryLimit: ZodOptional<ZodNumber>;
    dms: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      systemPrompt: ZodOptional<ZodString>;
    }, $strict>>>>;
    textChunkLimit: ZodOptional<ZodNumber>;
    chunkMode: ZodOptional<ZodEnum<{
      length: "length";
      newline: "newline";
    }>>;
    blockStreaming: ZodOptional<ZodBoolean>;
    blockStreamingCoalesce: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      minDelayMs: ZodOptional<ZodNumber>;
      maxDelayMs: ZodOptional<ZodNumber>;
    }, $strict>>;
    mediaMaxMb: ZodOptional<ZodNumber>;
    httpTimeoutMs: ZodOptional<ZodNumber>;
    heartbeat: ZodOptional<ZodObject<{
      visibility: ZodOptional<ZodEnum<{
        visible: "visible";
        hidden: "hidden";
      }>>;
      intervalMs: ZodOptional<ZodNumber>;
    }, $strict>>;
    renderMode: ZodOptional<ZodEnum<{
      raw: "raw";
      card: "card";
      auto: "auto";
    }>>;
    streaming: ZodOptional<ZodBoolean>;
    tools: ZodOptional<ZodObject<{
      doc: ZodOptional<ZodBoolean>;
      chat: ZodOptional<ZodBoolean>;
      wiki: ZodOptional<ZodBoolean>;
      drive: ZodOptional<ZodBoolean>;
      perm: ZodOptional<ZodBoolean>;
      scopes: ZodOptional<ZodBoolean>;
    }, $strict>>;
    actions: ZodOptional<ZodObject<{
      reactions: ZodOptional<ZodBoolean>;
    }, $strict>>;
    replyInThread: ZodOptional<ZodEnum<{
      enabled: "enabled";
      disabled: "disabled";
    }>>;
    reactionNotifications: ZodOptional<ZodEnum<{
      off: "off";
      all: "all";
      own: "own";
    }>>;
    typingIndicator: ZodOptional<ZodBoolean>;
    resolveSenderNames: ZodOptional<ZodBoolean>;
    tts: ZodOptional<ZodObject<{
      auto: ZodOptional<ZodEnum<{
        off: "off";
        always: "always";
        tagged: "tagged";
        inbound: "inbound";
      }>>;
      enabled: ZodOptional<ZodBoolean>;
      mode: ZodOptional<ZodEnum<{
        all: "all";
        final: "final";
      }>>;
      provider: ZodOptional<ZodString>;
      persona: ZodOptional<ZodString>;
      personas: ZodOptional<ZodRecord<ZodString, ZodRecord<ZodString, ZodUnknown>>>;
      summaryModel: ZodOptional<ZodString>;
      modelOverrides: ZodOptional<ZodRecord<ZodString, ZodUnknown>>;
      providers: ZodOptional<ZodRecord<ZodString, ZodRecord<ZodString, ZodUnknown>>>;
      prefsPath: ZodOptional<ZodString>;
      maxTextLength: ZodOptional<ZodNumber>;
      timeoutMs: ZodOptional<ZodNumber>;
    }, $strict>>;
    enabled: ZodOptional<ZodBoolean>;
    name: ZodOptional<ZodString>;
    appId: ZodOptional<ZodString>;
    appSecret: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
      source: ZodLiteral<"env">;
      provider: ZodString;
      id: ZodString;
    }, $strip>, ZodObject<{
      source: ZodLiteral<"file">;
      provider: ZodString;
      id: ZodString;
    }, $strip>, ZodObject<{
      source: ZodLiteral<"exec">;
      provider: ZodString;
      id: ZodString;
    }, $strip>], "source">]>>;
    encryptKey: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
      source: ZodLiteral<"env">;
      provider: ZodString;
      id: ZodString;
    }, $strip>, ZodObject<{
      source: ZodLiteral<"file">;
      provider: ZodString;
      id: ZodString;
    }, $strip>, ZodObject<{
      source: ZodLiteral<"exec">;
      provider: ZodString;
      id: ZodString;
    }, $strip>], "source">]>>;
    verificationToken: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
      source: ZodLiteral<"env">;
      provider: ZodString;
      id: ZodString;
    }, $strip>, ZodObject<{
      source: ZodLiteral<"file">;
      provider: ZodString;
      id: ZodString;
    }, $strip>, ZodObject<{
      source: ZodLiteral<"exec">;
      provider: ZodString;
      id: ZodString;
    }, $strip>], "source">]>>;
    domain: ZodOptional<ZodUnion<readonly [ZodEnum<{
      feishu: "feishu";
      lark: "lark";
    }>, ZodString]>>;
    connectionMode: ZodOptional<ZodEnum<{
      webhook: "webhook";
      websocket: "websocket";
    }>>;
    webhookPath: ZodOptional<ZodString>;
  }, $strict>>>>;
  webhookHost: ZodOptional<ZodString>;
  webhookPort: ZodOptional<ZodNumber>;
  capabilities: ZodOptional<ZodArray<ZodString>>;
  markdown: ZodOptional<ZodObject<{
    mode: ZodOptional<ZodEnum<{
      native: "native";
      escape: "escape";
      strip: "strip";
    }>>;
    tableMode: ZodOptional<ZodEnum<{
      native: "native";
      ascii: "ascii";
      simple: "simple";
    }>>;
  }, $strict>>;
  configWrites: ZodOptional<ZodBoolean>;
  allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
  groupAllowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
  groupSenderAllowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
  groups: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    requireMention: ZodOptional<ZodBoolean>;
    tools: ZodOptional<ZodObject<{
      allow: ZodOptional<ZodArray<ZodString>>;
      deny: ZodOptional<ZodArray<ZodString>>;
    }, $strict>>;
    skills: ZodOptional<ZodArray<ZodString>>;
    enabled: ZodOptional<ZodBoolean>;
    allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    systemPrompt: ZodOptional<ZodString>;
    groupSessionScope: ZodOptional<ZodEnum<{
      group: "group";
      group_sender: "group_sender";
      group_topic: "group_topic";
      group_topic_sender: "group_topic_sender";
    }>>;
    topicSessionMode: ZodOptional<ZodEnum<{
      enabled: "enabled";
      disabled: "disabled";
    }>>;
    replyInThread: ZodOptional<ZodEnum<{
      enabled: "enabled";
      disabled: "disabled";
    }>>;
  }, $strict>>>>;
  historyLimit: ZodOptional<ZodNumber>;
  dmHistoryLimit: ZodOptional<ZodNumber>;
  dms: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    systemPrompt: ZodOptional<ZodString>;
  }, $strict>>>>;
  textChunkLimit: ZodOptional<ZodNumber>;
  chunkMode: ZodOptional<ZodEnum<{
    length: "length";
    newline: "newline";
  }>>;
  blockStreaming: ZodOptional<ZodBoolean>;
  blockStreamingCoalesce: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    minDelayMs: ZodOptional<ZodNumber>;
    maxDelayMs: ZodOptional<ZodNumber>;
  }, $strict>>;
  mediaMaxMb: ZodOptional<ZodNumber>;
  httpTimeoutMs: ZodOptional<ZodNumber>;
  heartbeat: ZodOptional<ZodObject<{
    visibility: ZodOptional<ZodEnum<{
      visible: "visible";
      hidden: "hidden";
    }>>;
    intervalMs: ZodOptional<ZodNumber>;
  }, $strict>>;
  renderMode: ZodOptional<ZodEnum<{
    raw: "raw";
    card: "card";
    auto: "auto";
  }>>;
  streaming: ZodOptional<ZodBoolean>;
  tools: ZodOptional<ZodObject<{
    doc: ZodOptional<ZodBoolean>;
    chat: ZodOptional<ZodBoolean>;
    wiki: ZodOptional<ZodBoolean>;
    drive: ZodOptional<ZodBoolean>;
    perm: ZodOptional<ZodBoolean>;
    scopes: ZodOptional<ZodBoolean>;
  }, $strict>>;
  actions: ZodOptional<ZodObject<{
    reactions: ZodOptional<ZodBoolean>;
  }, $strict>>;
  replyInThread: ZodOptional<ZodEnum<{
    enabled: "enabled";
    disabled: "disabled";
  }>>;
  tts: ZodOptional<ZodObject<{
    auto: ZodOptional<ZodEnum<{
      off: "off";
      always: "always";
      tagged: "tagged";
      inbound: "inbound";
    }>>;
    enabled: ZodOptional<ZodBoolean>;
    mode: ZodOptional<ZodEnum<{
      all: "all";
      final: "final";
    }>>;
    provider: ZodOptional<ZodString>;
    persona: ZodOptional<ZodString>;
    personas: ZodOptional<ZodRecord<ZodString, ZodRecord<ZodString, ZodUnknown>>>;
    summaryModel: ZodOptional<ZodString>;
    modelOverrides: ZodOptional<ZodRecord<ZodString, ZodUnknown>>;
    providers: ZodOptional<ZodRecord<ZodString, ZodRecord<ZodString, ZodUnknown>>>;
    prefsPath: ZodOptional<ZodString>;
    maxTextLength: ZodOptional<ZodNumber>;
    timeoutMs: ZodOptional<ZodNumber>;
  }, $strict>>;
  enabled: ZodOptional<ZodBoolean>;
  defaultAccount: ZodOptional<ZodString>;
  appId: ZodOptional<ZodString>;
  appSecret: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
    source: ZodLiteral<"env">;
    provider: ZodString;
    id: ZodString;
  }, $strip>, ZodObject<{
    source: ZodLiteral<"file">;
    provider: ZodString;
    id: ZodString;
  }, $strip>, ZodObject<{
    source: ZodLiteral<"exec">;
    provider: ZodString;
    id: ZodString;
  }, $strip>], "source">]>>;
  encryptKey: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
    source: ZodLiteral<"env">;
    provider: ZodString;
    id: ZodString;
  }, $strip>, ZodObject<{
    source: ZodLiteral<"file">;
    provider: ZodString;
    id: ZodString;
  }, $strip>, ZodObject<{
    source: ZodLiteral<"exec">;
    provider: ZodString;
    id: ZodString;
  }, $strip>], "source">]>>;
  verificationToken: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
    source: ZodLiteral<"env">;
    provider: ZodString;
    id: ZodString;
  }, $strip>, ZodObject<{
    source: ZodLiteral<"file">;
    provider: ZodString;
    id: ZodString;
  }, $strip>, ZodObject<{
    source: ZodLiteral<"exec">;
    provider: ZodString;
    id: ZodString;
  }, $strip>], "source">]>>;
  domain: ZodDefault<ZodOptional<ZodUnion<readonly [ZodEnum<{
    feishu: "feishu";
    lark: "lark";
  }>, ZodString]>>>;
  connectionMode: ZodDefault<ZodOptional<ZodEnum<{
    webhook: "webhook";
    websocket: "websocket";
  }>>>;
  webhookPath: ZodDefault<ZodOptional<ZodString>>;
}, $strict>;
//#endregion
//#region extensions/feishu/src/types.d.ts
type FeishuConfig = output<typeof FeishuConfigSchema>;
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