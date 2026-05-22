import { $ as ZodPipe, B as ZodLiteral, C as ZodEnum, Q as ZodOptional, Y as ZodNumber, Z as ZodObject, bt as ZodUnion, c as ZodBoolean, ea as $catchall, ft as ZodTransform, it as ZodRecord, na as $strict, q as ZodNull, r as ZodArray, st as ZodString, tt as ZodPreprocess, v as ZodDefault, xt as ZodUnknown, y as ZodDiscriminatedUnion } from "./schemas-CkRCGSfd.js";
//#region src/config/zod-schema.providers-core.d.ts
declare const TelegramConfigSchema: ZodObject<{
  name: ZodOptional<ZodString>;
  capabilities: ZodOptional<ZodUnion<readonly [ZodArray<ZodString>, ZodObject<{
    inlineButtons: ZodOptional<ZodEnum<{
      off: "off";
      all: "all";
      group: "group";
      allowlist: "allowlist";
      dm: "dm";
    }>>;
  }, $strict>]>>;
  execApprovals: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"auto">]>>;
    approvers: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    agentFilter: ZodOptional<ZodArray<ZodString>>;
    sessionFilter: ZodOptional<ZodArray<ZodString>>;
    target: ZodOptional<ZodEnum<{
      channel: "channel";
      both: "both";
      dm: "dm";
    }>>;
  }, $strict>>;
  markdown: ZodOptional<ZodObject<{
    tables: ZodOptional<ZodEnum<{
      code: "code";
      off: "off";
      block: "block";
      bullets: "bullets";
    }>>;
  }, $strict>>;
  enabled: ZodOptional<ZodBoolean>;
  commands: ZodOptional<ZodObject<{
    native: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"auto">]>>;
    nativeSkills: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"auto">]>>;
  }, $strict>>;
  customCommands: ZodOptional<ZodArray<ZodObject<{
    command: ZodString;
    description: ZodString;
  }, $strict>>>;
  configWrites: ZodOptional<ZodBoolean>;
  dmPolicy: ZodDefault<ZodOptional<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    pairing: "pairing";
    open: "open";
  }>>>;
  botToken: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
    source: ZodLiteral<"env">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"file">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"exec">;
    provider: ZodString;
    id: ZodString;
  }, $strict>], "source">]>>;
  tokenFile: ZodOptional<ZodString>;
  replyToMode: ZodOptional<ZodUnion<readonly [ZodLiteral<"off">, ZodLiteral<"first">, ZodLiteral<"all">, ZodLiteral<"batched">]>>;
  dm: ZodOptional<ZodObject<{
    threadReplies: ZodOptional<ZodEnum<{
      off: "off";
      always: "always";
      inbound: "inbound";
    }>>;
  }, $strict>>;
  groups: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    requireMention: ZodOptional<ZodBoolean>;
    ingest: ZodOptional<ZodBoolean>;
    disableAudioPreflight: ZodOptional<ZodBoolean>;
    groupPolicy: ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      open: "open";
    }>>;
    tools: ZodOptional<ZodObject<{
      allow: ZodOptional<ZodArray<ZodString>>;
      alsoAllow: ZodOptional<ZodArray<ZodString>>;
      deny: ZodOptional<ZodArray<ZodString>>;
    }, $strict>>;
    toolsBySender: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      allow: ZodOptional<ZodArray<ZodString>>;
      alsoAllow: ZodOptional<ZodArray<ZodString>>;
      deny: ZodOptional<ZodArray<ZodString>>;
    }, $strict>>>>;
    skills: ZodOptional<ZodArray<ZodString>>;
    enabled: ZodOptional<ZodBoolean>;
    allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    systemPrompt: ZodOptional<ZodString>;
    topics: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      requireMention: ZodOptional<ZodBoolean>;
      ingest: ZodOptional<ZodBoolean>;
      disableAudioPreflight: ZodOptional<ZodBoolean>;
      groupPolicy: ZodOptional<ZodEnum<{
        disabled: "disabled";
        allowlist: "allowlist";
        open: "open";
      }>>;
      skills: ZodOptional<ZodArray<ZodString>>;
      enabled: ZodOptional<ZodBoolean>;
      allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
      systemPrompt: ZodOptional<ZodString>;
      agentId: ZodOptional<ZodString>;
      errorPolicy: ZodOptional<ZodEnum<{
        silent: "silent";
        always: "always";
        once: "once";
      }>>;
      errorCooldownMs: ZodOptional<ZodNumber>;
    }, $strict>>>>;
    errorPolicy: ZodOptional<ZodEnum<{
      silent: "silent";
      always: "always";
      once: "once";
    }>>;
    errorCooldownMs: ZodOptional<ZodNumber>;
  }, $strict>>>>;
  allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
  defaultTo: ZodOptional<ZodUnion<readonly [ZodString, ZodNumber]>>;
  groupAllowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
  groupPolicy: ZodDefault<ZodOptional<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    open: "open";
  }>>>;
  contextVisibility: ZodOptional<ZodEnum<{
    all: "all";
    allowlist: "allowlist";
    allowlist_quote: "allowlist_quote";
  }>>;
  historyLimit: ZodOptional<ZodNumber>;
  dmHistoryLimit: ZodOptional<ZodNumber>;
  dms: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    historyLimit: ZodOptional<ZodNumber>;
  }, $strict>>>>;
  direct: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    dmPolicy: ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      pairing: "pairing";
      open: "open";
    }>>;
    threadReplies: ZodOptional<ZodEnum<{
      off: "off";
      always: "always";
      inbound: "inbound";
    }>>;
    tools: ZodOptional<ZodObject<{
      allow: ZodOptional<ZodArray<ZodString>>;
      alsoAllow: ZodOptional<ZodArray<ZodString>>;
      deny: ZodOptional<ZodArray<ZodString>>;
    }, $strict>>;
    toolsBySender: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      allow: ZodOptional<ZodArray<ZodString>>;
      alsoAllow: ZodOptional<ZodArray<ZodString>>;
      deny: ZodOptional<ZodArray<ZodString>>;
    }, $strict>>>>;
    skills: ZodOptional<ZodArray<ZodString>>;
    enabled: ZodOptional<ZodBoolean>;
    allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    systemPrompt: ZodOptional<ZodString>;
    topics: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      requireMention: ZodOptional<ZodBoolean>;
      ingest: ZodOptional<ZodBoolean>;
      disableAudioPreflight: ZodOptional<ZodBoolean>;
      groupPolicy: ZodOptional<ZodEnum<{
        disabled: "disabled";
        allowlist: "allowlist";
        open: "open";
      }>>;
      skills: ZodOptional<ZodArray<ZodString>>;
      enabled: ZodOptional<ZodBoolean>;
      allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
      systemPrompt: ZodOptional<ZodString>;
      agentId: ZodOptional<ZodString>;
      errorPolicy: ZodOptional<ZodEnum<{
        silent: "silent";
        always: "always";
        once: "once";
      }>>;
      errorCooldownMs: ZodOptional<ZodNumber>;
    }, $strict>>>>;
    errorPolicy: ZodOptional<ZodEnum<{
      silent: "silent";
      always: "always";
      once: "once";
    }>>;
    errorCooldownMs: ZodOptional<ZodNumber>;
    requireTopic: ZodOptional<ZodBoolean>;
    autoTopicLabel: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      prompt: ZodOptional<ZodString>;
    }, $strict>]>>;
  }, $strict>>>>;
  textChunkLimit: ZodOptional<ZodNumber>;
  streaming: ZodOptional<ZodObject<{
    mode: ZodOptional<ZodEnum<{
      off: "off";
      progress: "progress";
      partial: "partial";
      block: "block";
    }>>;
    chunkMode: ZodOptional<ZodEnum<{
      length: "length";
      newline: "newline";
    }>>;
    progress: ZodOptional<ZodObject<{
      label: ZodOptional<ZodUnion<readonly [ZodString, ZodLiteral<false>]>>;
      labels: ZodOptional<ZodArray<ZodString>>;
      maxLines: ZodOptional<ZodNumber>;
      maxLineChars: ZodOptional<ZodNumber>;
      render: ZodOptional<ZodEnum<{
        text: "text";
        rich: "rich";
      }>>;
      toolProgress: ZodOptional<ZodBoolean>;
      commandText: ZodOptional<ZodEnum<{
        status: "status";
        raw: "raw";
      }>>;
    }, $strict>>;
    block: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      coalesce: ZodOptional<ZodObject<{
        minChars: ZodOptional<ZodNumber>;
        maxChars: ZodOptional<ZodNumber>;
        idleMs: ZodOptional<ZodNumber>;
      }, $strict>>;
    }, $strict>>;
    preview: ZodOptional<ZodObject<{
      chunk: ZodOptional<ZodObject<{
        minChars: ZodOptional<ZodNumber>;
        maxChars: ZodOptional<ZodNumber>;
        breakPreference: ZodOptional<ZodUnion<readonly [ZodLiteral<"paragraph">, ZodLiteral<"newline">, ZodLiteral<"sentence">]>>;
      }, $strict>>;
      toolProgress: ZodOptional<ZodBoolean>;
      commandText: ZodOptional<ZodEnum<{
        status: "status";
        raw: "raw";
      }>>;
      nativeToolProgress: ZodOptional<ZodBoolean>;
      nativeToolProgressAllowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    }, $strict>>;
  }, $strict>>;
  mediaMaxMb: ZodOptional<ZodNumber>;
  timeoutSeconds: ZodOptional<ZodNumber>;
  mediaGroupFlushMs: ZodOptional<ZodNumber>;
  pollingStallThresholdMs: ZodOptional<ZodNumber>;
  retry: ZodOptional<ZodObject<{
    attempts: ZodOptional<ZodNumber>;
    minDelayMs: ZodOptional<ZodNumber>;
    maxDelayMs: ZodOptional<ZodNumber>;
    jitter: ZodOptional<ZodNumber>;
  }, $strict>>;
  network: ZodOptional<ZodObject<{
    autoSelectFamily: ZodOptional<ZodBoolean>;
    dnsResultOrder: ZodOptional<ZodEnum<{
      ipv4first: "ipv4first";
      verbatim: "verbatim";
    }>>;
    dangerouslyAllowPrivateNetwork: ZodOptional<ZodBoolean>;
  }, $strict>>;
  proxy: ZodOptional<ZodString>;
  webhookUrl: ZodOptional<ZodString>;
  webhookSecret: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
    source: ZodLiteral<"env">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"file">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"exec">;
    provider: ZodString;
    id: ZodString;
  }, $strict>], "source">]>>;
  webhookPath: ZodOptional<ZodString>;
  webhookHost: ZodOptional<ZodString>;
  webhookPort: ZodOptional<ZodNumber>;
  webhookCertPath: ZodOptional<ZodString>;
  actions: ZodOptional<ZodObject<{
    reactions: ZodOptional<ZodBoolean>;
    sendMessage: ZodOptional<ZodBoolean>;
    poll: ZodOptional<ZodBoolean>;
    deleteMessage: ZodOptional<ZodBoolean>;
    editMessage: ZodOptional<ZodBoolean>;
    sticker: ZodOptional<ZodBoolean>;
    createForumTopic: ZodOptional<ZodBoolean>;
    editForumTopic: ZodOptional<ZodBoolean>;
  }, $strict>>;
  threadBindings: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    idleHours: ZodOptional<ZodNumber>;
    maxAgeHours: ZodOptional<ZodNumber>;
    spawnSessions: ZodOptional<ZodBoolean>;
    defaultSpawnContext: ZodOptional<ZodEnum<{
      isolated: "isolated";
      fork: "fork";
    }>>;
    spawnSubagentSessions: ZodOptional<ZodBoolean>;
    spawnAcpSessions: ZodOptional<ZodBoolean>;
  }, $strict>>;
  reactionNotifications: ZodOptional<ZodEnum<{
    off: "off";
    all: "all";
    own: "own";
  }>>;
  reactionLevel: ZodOptional<ZodEnum<{
    off: "off";
    minimal: "minimal";
    extensive: "extensive";
    ack: "ack";
  }>>;
  heartbeat: ZodOptional<ZodObject<{
    showOk: ZodOptional<ZodBoolean>;
    showAlerts: ZodOptional<ZodBoolean>;
    useIndicator: ZodOptional<ZodBoolean>;
  }, $strict>>;
  healthMonitor: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
  }, $strict>>;
  linkPreview: ZodOptional<ZodBoolean>;
  silentErrorReplies: ZodOptional<ZodBoolean>;
  responsePrefix: ZodOptional<ZodString>;
  ackReaction: ZodOptional<ZodString>;
  errorPolicy: ZodOptional<ZodEnum<{
    silent: "silent";
    always: "always";
    once: "once";
  }>>;
  errorCooldownMs: ZodOptional<ZodNumber>;
  apiRoot: ZodOptional<ZodString>;
  trustedLocalFileRoots: ZodOptional<ZodArray<ZodString>>;
  autoTopicLabel: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    prompt: ZodOptional<ZodString>;
  }, $strict>]>>;
  accounts: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    name: ZodOptional<ZodString>;
    capabilities: ZodOptional<ZodUnion<readonly [ZodArray<ZodString>, ZodObject<{
      inlineButtons: ZodOptional<ZodEnum<{
        off: "off";
        all: "all";
        group: "group";
        allowlist: "allowlist";
        dm: "dm";
      }>>;
    }, $strict>]>>;
    execApprovals: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"auto">]>>;
      approvers: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
      agentFilter: ZodOptional<ZodArray<ZodString>>;
      sessionFilter: ZodOptional<ZodArray<ZodString>>;
      target: ZodOptional<ZodEnum<{
        channel: "channel";
        both: "both";
        dm: "dm";
      }>>;
    }, $strict>>;
    markdown: ZodOptional<ZodObject<{
      tables: ZodOptional<ZodEnum<{
        code: "code";
        off: "off";
        block: "block";
        bullets: "bullets";
      }>>;
    }, $strict>>;
    enabled: ZodOptional<ZodBoolean>;
    commands: ZodOptional<ZodObject<{
      native: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"auto">]>>;
      nativeSkills: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"auto">]>>;
    }, $strict>>;
    customCommands: ZodOptional<ZodArray<ZodObject<{
      command: ZodString;
      description: ZodString;
    }, $strict>>>;
    configWrites: ZodOptional<ZodBoolean>;
    dmPolicy: ZodDefault<ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      pairing: "pairing";
      open: "open";
    }>>>;
    botToken: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
      source: ZodLiteral<"env">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"file">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"exec">;
      provider: ZodString;
      id: ZodString;
    }, $strict>], "source">]>>;
    tokenFile: ZodOptional<ZodString>;
    replyToMode: ZodOptional<ZodUnion<readonly [ZodLiteral<"off">, ZodLiteral<"first">, ZodLiteral<"all">, ZodLiteral<"batched">]>>;
    dm: ZodOptional<ZodObject<{
      threadReplies: ZodOptional<ZodEnum<{
        off: "off";
        always: "always";
        inbound: "inbound";
      }>>;
    }, $strict>>;
    groups: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      requireMention: ZodOptional<ZodBoolean>;
      ingest: ZodOptional<ZodBoolean>;
      disableAudioPreflight: ZodOptional<ZodBoolean>;
      groupPolicy: ZodOptional<ZodEnum<{
        disabled: "disabled";
        allowlist: "allowlist";
        open: "open";
      }>>;
      tools: ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        alsoAllow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>;
      toolsBySender: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        alsoAllow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>>>;
      skills: ZodOptional<ZodArray<ZodString>>;
      enabled: ZodOptional<ZodBoolean>;
      allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
      systemPrompt: ZodOptional<ZodString>;
      topics: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
        requireMention: ZodOptional<ZodBoolean>;
        ingest: ZodOptional<ZodBoolean>;
        disableAudioPreflight: ZodOptional<ZodBoolean>;
        groupPolicy: ZodOptional<ZodEnum<{
          disabled: "disabled";
          allowlist: "allowlist";
          open: "open";
        }>>;
        skills: ZodOptional<ZodArray<ZodString>>;
        enabled: ZodOptional<ZodBoolean>;
        allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
        systemPrompt: ZodOptional<ZodString>;
        agentId: ZodOptional<ZodString>;
        errorPolicy: ZodOptional<ZodEnum<{
          silent: "silent";
          always: "always";
          once: "once";
        }>>;
        errorCooldownMs: ZodOptional<ZodNumber>;
      }, $strict>>>>;
      errorPolicy: ZodOptional<ZodEnum<{
        silent: "silent";
        always: "always";
        once: "once";
      }>>;
      errorCooldownMs: ZodOptional<ZodNumber>;
    }, $strict>>>>;
    allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    defaultTo: ZodOptional<ZodUnion<readonly [ZodString, ZodNumber]>>;
    groupAllowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    groupPolicy: ZodDefault<ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      open: "open";
    }>>>;
    contextVisibility: ZodOptional<ZodEnum<{
      all: "all";
      allowlist: "allowlist";
      allowlist_quote: "allowlist_quote";
    }>>;
    historyLimit: ZodOptional<ZodNumber>;
    dmHistoryLimit: ZodOptional<ZodNumber>;
    dms: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      historyLimit: ZodOptional<ZodNumber>;
    }, $strict>>>>;
    direct: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      dmPolicy: ZodOptional<ZodEnum<{
        disabled: "disabled";
        allowlist: "allowlist";
        pairing: "pairing";
        open: "open";
      }>>;
      threadReplies: ZodOptional<ZodEnum<{
        off: "off";
        always: "always";
        inbound: "inbound";
      }>>;
      tools: ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        alsoAllow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>;
      toolsBySender: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        alsoAllow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>>>;
      skills: ZodOptional<ZodArray<ZodString>>;
      enabled: ZodOptional<ZodBoolean>;
      allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
      systemPrompt: ZodOptional<ZodString>;
      topics: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
        requireMention: ZodOptional<ZodBoolean>;
        ingest: ZodOptional<ZodBoolean>;
        disableAudioPreflight: ZodOptional<ZodBoolean>;
        groupPolicy: ZodOptional<ZodEnum<{
          disabled: "disabled";
          allowlist: "allowlist";
          open: "open";
        }>>;
        skills: ZodOptional<ZodArray<ZodString>>;
        enabled: ZodOptional<ZodBoolean>;
        allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
        systemPrompt: ZodOptional<ZodString>;
        agentId: ZodOptional<ZodString>;
        errorPolicy: ZodOptional<ZodEnum<{
          silent: "silent";
          always: "always";
          once: "once";
        }>>;
        errorCooldownMs: ZodOptional<ZodNumber>;
      }, $strict>>>>;
      errorPolicy: ZodOptional<ZodEnum<{
        silent: "silent";
        always: "always";
        once: "once";
      }>>;
      errorCooldownMs: ZodOptional<ZodNumber>;
      requireTopic: ZodOptional<ZodBoolean>;
      autoTopicLabel: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodObject<{
        enabled: ZodOptional<ZodBoolean>;
        prompt: ZodOptional<ZodString>;
      }, $strict>]>>;
    }, $strict>>>>;
    textChunkLimit: ZodOptional<ZodNumber>;
    streaming: ZodOptional<ZodObject<{
      mode: ZodOptional<ZodEnum<{
        off: "off";
        progress: "progress";
        partial: "partial";
        block: "block";
      }>>;
      chunkMode: ZodOptional<ZodEnum<{
        length: "length";
        newline: "newline";
      }>>;
      progress: ZodOptional<ZodObject<{
        label: ZodOptional<ZodUnion<readonly [ZodString, ZodLiteral<false>]>>;
        labels: ZodOptional<ZodArray<ZodString>>;
        maxLines: ZodOptional<ZodNumber>;
        maxLineChars: ZodOptional<ZodNumber>;
        render: ZodOptional<ZodEnum<{
          text: "text";
          rich: "rich";
        }>>;
        toolProgress: ZodOptional<ZodBoolean>;
        commandText: ZodOptional<ZodEnum<{
          status: "status";
          raw: "raw";
        }>>;
      }, $strict>>;
      block: ZodOptional<ZodObject<{
        enabled: ZodOptional<ZodBoolean>;
        coalesce: ZodOptional<ZodObject<{
          minChars: ZodOptional<ZodNumber>;
          maxChars: ZodOptional<ZodNumber>;
          idleMs: ZodOptional<ZodNumber>;
        }, $strict>>;
      }, $strict>>;
      preview: ZodOptional<ZodObject<{
        chunk: ZodOptional<ZodObject<{
          minChars: ZodOptional<ZodNumber>;
          maxChars: ZodOptional<ZodNumber>;
          breakPreference: ZodOptional<ZodUnion<readonly [ZodLiteral<"paragraph">, ZodLiteral<"newline">, ZodLiteral<"sentence">]>>;
        }, $strict>>;
        toolProgress: ZodOptional<ZodBoolean>;
        commandText: ZodOptional<ZodEnum<{
          status: "status";
          raw: "raw";
        }>>;
        nativeToolProgress: ZodOptional<ZodBoolean>;
        nativeToolProgressAllowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
      }, $strict>>;
    }, $strict>>;
    mediaMaxMb: ZodOptional<ZodNumber>;
    timeoutSeconds: ZodOptional<ZodNumber>;
    mediaGroupFlushMs: ZodOptional<ZodNumber>;
    pollingStallThresholdMs: ZodOptional<ZodNumber>;
    retry: ZodOptional<ZodObject<{
      attempts: ZodOptional<ZodNumber>;
      minDelayMs: ZodOptional<ZodNumber>;
      maxDelayMs: ZodOptional<ZodNumber>;
      jitter: ZodOptional<ZodNumber>;
    }, $strict>>;
    network: ZodOptional<ZodObject<{
      autoSelectFamily: ZodOptional<ZodBoolean>;
      dnsResultOrder: ZodOptional<ZodEnum<{
        ipv4first: "ipv4first";
        verbatim: "verbatim";
      }>>;
      dangerouslyAllowPrivateNetwork: ZodOptional<ZodBoolean>;
    }, $strict>>;
    proxy: ZodOptional<ZodString>;
    webhookUrl: ZodOptional<ZodString>;
    webhookSecret: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
      source: ZodLiteral<"env">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"file">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"exec">;
      provider: ZodString;
      id: ZodString;
    }, $strict>], "source">]>>;
    webhookPath: ZodOptional<ZodString>;
    webhookHost: ZodOptional<ZodString>;
    webhookPort: ZodOptional<ZodNumber>;
    webhookCertPath: ZodOptional<ZodString>;
    actions: ZodOptional<ZodObject<{
      reactions: ZodOptional<ZodBoolean>;
      sendMessage: ZodOptional<ZodBoolean>;
      poll: ZodOptional<ZodBoolean>;
      deleteMessage: ZodOptional<ZodBoolean>;
      editMessage: ZodOptional<ZodBoolean>;
      sticker: ZodOptional<ZodBoolean>;
      createForumTopic: ZodOptional<ZodBoolean>;
      editForumTopic: ZodOptional<ZodBoolean>;
    }, $strict>>;
    threadBindings: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      idleHours: ZodOptional<ZodNumber>;
      maxAgeHours: ZodOptional<ZodNumber>;
      spawnSessions: ZodOptional<ZodBoolean>;
      defaultSpawnContext: ZodOptional<ZodEnum<{
        isolated: "isolated";
        fork: "fork";
      }>>;
      spawnSubagentSessions: ZodOptional<ZodBoolean>;
      spawnAcpSessions: ZodOptional<ZodBoolean>;
    }, $strict>>;
    reactionNotifications: ZodOptional<ZodEnum<{
      off: "off";
      all: "all";
      own: "own";
    }>>;
    reactionLevel: ZodOptional<ZodEnum<{
      off: "off";
      minimal: "minimal";
      extensive: "extensive";
      ack: "ack";
    }>>;
    heartbeat: ZodOptional<ZodObject<{
      showOk: ZodOptional<ZodBoolean>;
      showAlerts: ZodOptional<ZodBoolean>;
      useIndicator: ZodOptional<ZodBoolean>;
    }, $strict>>;
    healthMonitor: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
    }, $strict>>;
    linkPreview: ZodOptional<ZodBoolean>;
    silentErrorReplies: ZodOptional<ZodBoolean>;
    responsePrefix: ZodOptional<ZodString>;
    ackReaction: ZodOptional<ZodString>;
    errorPolicy: ZodOptional<ZodEnum<{
      silent: "silent";
      always: "always";
      once: "once";
    }>>;
    errorCooldownMs: ZodOptional<ZodNumber>;
    apiRoot: ZodOptional<ZodString>;
    trustedLocalFileRoots: ZodOptional<ZodArray<ZodString>>;
    autoTopicLabel: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      prompt: ZodOptional<ZodString>;
    }, $strict>]>>;
  }, $strict>>>>;
  defaultAccount: ZodOptional<ZodString>;
}, $strict>;
declare const DiscordConfigSchema: ZodObject<{
  name: ZodOptional<ZodString>;
  capabilities: ZodOptional<ZodArray<ZodString>>;
  markdown: ZodOptional<ZodObject<{
    tables: ZodOptional<ZodEnum<{
      code: "code";
      off: "off";
      block: "block";
      bullets: "bullets";
    }>>;
  }, $strict>>;
  enabled: ZodOptional<ZodBoolean>;
  commands: ZodOptional<ZodObject<{
    native: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"auto">]>>;
    nativeSkills: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"auto">]>>;
  }, $strict>>;
  configWrites: ZodOptional<ZodBoolean>;
  token: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
    source: ZodLiteral<"env">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"file">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"exec">;
    provider: ZodString;
    id: ZodString;
  }, $strict>], "source">]>>;
  applicationId: ZodOptional<ZodPipe<ZodPipe<ZodUnion<readonly [ZodString, ZodNumber]>, ZodTransform<string, string | number>>, ZodString>>;
  proxy: ZodOptional<ZodString>;
  gatewayInfoTimeoutMs: ZodOptional<ZodNumber>;
  gatewayReadyTimeoutMs: ZodOptional<ZodNumber>;
  gatewayRuntimeReadyTimeoutMs: ZodOptional<ZodNumber>;
  allowBots: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"mentions">]>>;
  botLoopProtection: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    maxEventsPerWindow: ZodOptional<ZodNumber>;
    windowSeconds: ZodOptional<ZodNumber>;
    cooldownSeconds: ZodOptional<ZodNumber>;
  }, $strict>>;
  dangerouslyAllowNameMatching: ZodOptional<ZodBoolean>;
  mentionAliases: ZodOptional<ZodRecord<ZodString, ZodString>>;
  groupPolicy: ZodDefault<ZodOptional<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    open: "open";
  }>>>;
  contextVisibility: ZodOptional<ZodEnum<{
    all: "all";
    allowlist: "allowlist";
    allowlist_quote: "allowlist_quote";
  }>>;
  historyLimit: ZodOptional<ZodNumber>;
  dmHistoryLimit: ZodOptional<ZodNumber>;
  dms: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    historyLimit: ZodOptional<ZodNumber>;
  }, $strict>>>>;
  textChunkLimit: ZodOptional<ZodNumber>;
  suppressEmbeds: ZodOptional<ZodBoolean>;
  streaming: ZodOptional<ZodObject<{
    mode: ZodOptional<ZodEnum<{
      off: "off";
      progress: "progress";
      partial: "partial";
      block: "block";
    }>>;
    chunkMode: ZodOptional<ZodEnum<{
      length: "length";
      newline: "newline";
    }>>;
    preview: ZodOptional<ZodObject<{
      chunk: ZodOptional<ZodObject<{
        minChars: ZodOptional<ZodNumber>;
        maxChars: ZodOptional<ZodNumber>;
        breakPreference: ZodOptional<ZodUnion<readonly [ZodLiteral<"paragraph">, ZodLiteral<"newline">, ZodLiteral<"sentence">]>>;
      }, $strict>>;
      toolProgress: ZodOptional<ZodBoolean>;
      commandText: ZodOptional<ZodEnum<{
        status: "status";
        raw: "raw";
      }>>;
    }, $strict>>;
    progress: ZodOptional<ZodObject<{
      label: ZodOptional<ZodUnion<readonly [ZodString, ZodLiteral<false>]>>;
      labels: ZodOptional<ZodArray<ZodString>>;
      maxLines: ZodOptional<ZodNumber>;
      maxLineChars: ZodOptional<ZodNumber>;
      render: ZodOptional<ZodEnum<{
        text: "text";
        rich: "rich";
      }>>;
      toolProgress: ZodOptional<ZodBoolean>;
      commandText: ZodOptional<ZodEnum<{
        status: "status";
        raw: "raw";
      }>>;
    }, $strict>>;
    block: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      coalesce: ZodOptional<ZodObject<{
        minChars: ZodOptional<ZodNumber>;
        maxChars: ZodOptional<ZodNumber>;
        idleMs: ZodOptional<ZodNumber>;
      }, $strict>>;
    }, $strict>>;
  }, $strict>>;
  maxLinesPerMessage: ZodOptional<ZodNumber>;
  mediaMaxMb: ZodOptional<ZodNumber>;
  retry: ZodOptional<ZodObject<{
    attempts: ZodOptional<ZodNumber>;
    minDelayMs: ZodOptional<ZodNumber>;
    maxDelayMs: ZodOptional<ZodNumber>;
    jitter: ZodOptional<ZodNumber>;
  }, $strict>>;
  actions: ZodOptional<ZodObject<{
    reactions: ZodOptional<ZodBoolean>;
    stickers: ZodOptional<ZodBoolean>;
    emojiUploads: ZodOptional<ZodBoolean>;
    stickerUploads: ZodOptional<ZodBoolean>;
    polls: ZodOptional<ZodBoolean>;
    permissions: ZodOptional<ZodBoolean>;
    messages: ZodOptional<ZodBoolean>;
    threads: ZodOptional<ZodBoolean>;
    pins: ZodOptional<ZodBoolean>;
    search: ZodOptional<ZodBoolean>;
    memberInfo: ZodOptional<ZodBoolean>;
    roleInfo: ZodOptional<ZodBoolean>;
    roles: ZodOptional<ZodBoolean>;
    channelInfo: ZodOptional<ZodBoolean>;
    voiceStatus: ZodOptional<ZodBoolean>;
    events: ZodOptional<ZodBoolean>;
    moderation: ZodOptional<ZodBoolean>;
    channels: ZodOptional<ZodBoolean>;
    presence: ZodOptional<ZodBoolean>;
  }, $strict>>;
  replyToMode: ZodOptional<ZodUnion<readonly [ZodLiteral<"off">, ZodLiteral<"first">, ZodLiteral<"all">, ZodLiteral<"batched">]>>;
  thread: ZodOptional<ZodObject<{
    inheritParent: ZodOptional<ZodBoolean>;
  }, $strict>>;
  dmPolicy: ZodOptional<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    pairing: "pairing";
    open: "open";
  }>>;
  allowFrom: ZodOptional<ZodArray<ZodPipe<ZodPipe<ZodUnion<readonly [ZodString, ZodNumber]>, ZodTransform<string, string | number>>, ZodString>>>;
  defaultTo: ZodOptional<ZodString>;
  dm: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    policy: ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      pairing: "pairing";
      open: "open";
    }>>;
    allowFrom: ZodOptional<ZodArray<ZodPipe<ZodPipe<ZodUnion<readonly [ZodString, ZodNumber]>, ZodTransform<string, string | number>>, ZodString>>>;
    groupEnabled: ZodOptional<ZodBoolean>;
    groupChannels: ZodOptional<ZodArray<ZodPipe<ZodPipe<ZodUnion<readonly [ZodString, ZodNumber]>, ZodTransform<string, string | number>>, ZodString>>>;
  }, $strict>>;
  guilds: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    slug: ZodOptional<ZodString>;
    requireMention: ZodOptional<ZodBoolean>;
    ignoreOtherMentions: ZodOptional<ZodBoolean>;
    tools: ZodOptional<ZodObject<{
      allow: ZodOptional<ZodArray<ZodString>>;
      alsoAllow: ZodOptional<ZodArray<ZodString>>;
      deny: ZodOptional<ZodArray<ZodString>>;
    }, $strict>>;
    toolsBySender: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      allow: ZodOptional<ZodArray<ZodString>>;
      alsoAllow: ZodOptional<ZodArray<ZodString>>;
      deny: ZodOptional<ZodArray<ZodString>>;
    }, $strict>>>>;
    reactionNotifications: ZodOptional<ZodEnum<{
      off: "off";
      all: "all";
      allowlist: "allowlist";
      own: "own";
    }>>;
    users: ZodOptional<ZodArray<ZodPipe<ZodPipe<ZodUnion<readonly [ZodString, ZodNumber]>, ZodTransform<string, string | number>>, ZodString>>>;
    roles: ZodOptional<ZodArray<ZodPipe<ZodPipe<ZodUnion<readonly [ZodString, ZodNumber]>, ZodTransform<string, string | number>>, ZodString>>>;
    channels: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      requireMention: ZodOptional<ZodBoolean>;
      ignoreOtherMentions: ZodOptional<ZodBoolean>;
      tools: ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        alsoAllow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>;
      toolsBySender: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        alsoAllow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>>>;
      skills: ZodOptional<ZodArray<ZodString>>;
      enabled: ZodOptional<ZodBoolean>;
      users: ZodOptional<ZodArray<ZodPipe<ZodPipe<ZodUnion<readonly [ZodString, ZodNumber]>, ZodTransform<string, string | number>>, ZodString>>>;
      roles: ZodOptional<ZodArray<ZodPipe<ZodPipe<ZodUnion<readonly [ZodString, ZodNumber]>, ZodTransform<string, string | number>>, ZodString>>>;
      systemPrompt: ZodOptional<ZodString>;
      includeThreadStarter: ZodOptional<ZodBoolean>;
      autoThread: ZodOptional<ZodBoolean>;
      autoThreadName: ZodOptional<ZodEnum<{
        message: "message";
        generated: "generated";
      }>>;
      autoArchiveDuration: ZodOptional<ZodUnion<readonly [ZodEnum<{
        60: "60";
        1440: "1440";
        4320: "4320";
        10080: "10080";
      }>, ZodLiteral<60>, ZodLiteral<1440>, ZodLiteral<4320>, ZodLiteral<10080>]>>;
    }, $strict>>>>;
  }, $strict>>>>;
  heartbeat: ZodOptional<ZodObject<{
    showOk: ZodOptional<ZodBoolean>;
    showAlerts: ZodOptional<ZodBoolean>;
    useIndicator: ZodOptional<ZodBoolean>;
  }, $strict>>;
  healthMonitor: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
  }, $strict>>;
  execApprovals: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"auto">]>>;
    approvers: ZodOptional<ZodArray<ZodPipe<ZodPipe<ZodUnion<readonly [ZodString, ZodNumber]>, ZodTransform<string, string | number>>, ZodString>>>;
    agentFilter: ZodOptional<ZodArray<ZodString>>;
    sessionFilter: ZodOptional<ZodArray<ZodString>>;
    cleanupAfterResolve: ZodOptional<ZodBoolean>;
    target: ZodOptional<ZodEnum<{
      channel: "channel";
      both: "both";
      dm: "dm";
    }>>;
  }, $strict>>;
  agentComponents: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    ttlMs: ZodOptional<ZodNumber>;
  }, $strict>>;
  ui: ZodOptional<ZodObject<{
    components: ZodOptional<ZodObject<{
      accentColor: ZodOptional<ZodString>;
    }, $strict>>;
  }, $strict>>;
  slashCommand: ZodOptional<ZodObject<{
    ephemeral: ZodOptional<ZodBoolean>;
  }, $strict>>;
  threadBindings: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    idleHours: ZodOptional<ZodNumber>;
    maxAgeHours: ZodOptional<ZodNumber>;
    spawnSessions: ZodOptional<ZodBoolean>;
    defaultSpawnContext: ZodOptional<ZodEnum<{
      isolated: "isolated";
      fork: "fork";
    }>>;
    spawnSubagentSessions: ZodOptional<ZodBoolean>;
    spawnAcpSessions: ZodOptional<ZodBoolean>;
  }, $strict>>;
  intents: ZodOptional<ZodObject<{
    presence: ZodOptional<ZodBoolean>;
    guildMembers: ZodOptional<ZodBoolean>;
    voiceStates: ZodOptional<ZodBoolean>;
  }, $strict>>;
  voice: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    mode: ZodOptional<ZodEnum<{
      "stt-tts": "stt-tts";
      "agent-proxy": "agent-proxy";
      bidi: "bidi";
    }>>;
    agentSession: ZodOptional<ZodObject<{
      mode: ZodOptional<ZodEnum<{
        voice: "voice";
        target: "target";
      }>>;
      target: ZodOptional<ZodString>;
    }, $strict>>;
    model: ZodOptional<ZodString>;
    realtime: ZodOptional<ZodObject<{
      provider: ZodOptional<ZodString>;
      model: ZodOptional<ZodString>;
      voice: ZodOptional<ZodString>;
      instructions: ZodOptional<ZodString>;
      toolPolicy: ZodOptional<ZodEnum<{
        none: "none";
        owner: "owner";
        "safe-read-only": "safe-read-only";
      }>>;
      consultPolicy: ZodOptional<ZodEnum<{
        always: "always";
        auto: "auto";
      }>>;
      bootstrapContextFiles: ZodOptional<ZodArray<ZodEnum<{
        "IDENTITY.md": "IDENTITY.md";
        "USER.md": "USER.md";
        "SOUL.md": "SOUL.md";
      }>>>;
      bargeIn: ZodOptional<ZodBoolean>;
      minBargeInAudioEndMs: ZodOptional<ZodNumber>;
      debounceMs: ZodOptional<ZodNumber>;
      providers: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodRecord<ZodString, ZodUnknown>>>>;
    }, $strict>>;
    autoJoin: ZodOptional<ZodArray<ZodObject<{
      guildId: ZodString;
      channelId: ZodString;
    }, $strict>>>;
    followUsersEnabled: ZodOptional<ZodBoolean>;
    followUsers: ZodOptional<ZodArray<ZodString>>;
    allowedChannels: ZodOptional<ZodArray<ZodObject<{
      guildId: ZodString;
      channelId: ZodString;
    }, $strict>>>;
    daveEncryption: ZodOptional<ZodBoolean>;
    decryptionFailureTolerance: ZodOptional<ZodNumber>;
    connectTimeoutMs: ZodOptional<ZodNumber>;
    reconnectGraceMs: ZodOptional<ZodNumber>;
    captureSilenceGraceMs: ZodOptional<ZodNumber>;
    tts: ZodOptional<ZodOptional<ZodObject<{
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
      personas: ZodOptional<ZodRecord<ZodString, ZodObject<{
        label: ZodOptional<ZodString>;
        description: ZodOptional<ZodString>;
        provider: ZodOptional<ZodString>;
        fallbackPolicy: ZodOptional<ZodUnion<readonly [ZodLiteral<"preserve-persona">, ZodLiteral<"provider-defaults">, ZodLiteral<"fail">]>>;
        prompt: ZodOptional<ZodObject<{
          profile: ZodOptional<ZodString>;
          scene: ZodOptional<ZodString>;
          sampleContext: ZodOptional<ZodString>;
          style: ZodOptional<ZodString>;
          accent: ZodOptional<ZodString>;
          pacing: ZodOptional<ZodString>;
          constraints: ZodOptional<ZodArray<ZodString>>;
        }, $strict>>;
        providers: ZodOptional<ZodRecord<ZodString, ZodObject<{
          apiKey: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
            source: ZodLiteral<"env">;
            provider: ZodString;
            id: ZodString;
          }, $strict>, ZodObject<{
            source: ZodLiteral<"file">;
            provider: ZodString;
            id: ZodString;
          }, $strict>, ZodObject<{
            source: ZodLiteral<"exec">;
            provider: ZodString;
            id: ZodString;
          }, $strict>], "source">]>>;
        }, $catchall<ZodUnion<readonly [ZodString, ZodNumber, ZodBoolean, ZodNull, ZodArray<ZodUnknown>, ZodRecord<ZodString, ZodUnknown>]>>>>>;
      }, $strict>>>;
      summaryModel: ZodOptional<ZodString>;
      modelOverrides: ZodOptional<ZodObject<{
        enabled: ZodOptional<ZodBoolean>;
        allowText: ZodOptional<ZodBoolean>;
        allowProvider: ZodOptional<ZodBoolean>;
        allowVoice: ZodOptional<ZodBoolean>;
        allowModelId: ZodOptional<ZodBoolean>;
        allowVoiceSettings: ZodOptional<ZodBoolean>;
        allowNormalization: ZodOptional<ZodBoolean>;
        allowSeed: ZodOptional<ZodBoolean>;
      }, $strict>>;
      providers: ZodOptional<ZodRecord<ZodString, ZodObject<{
        apiKey: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
          source: ZodLiteral<"env">;
          provider: ZodString;
          id: ZodString;
        }, $strict>, ZodObject<{
          source: ZodLiteral<"file">;
          provider: ZodString;
          id: ZodString;
        }, $strict>, ZodObject<{
          source: ZodLiteral<"exec">;
          provider: ZodString;
          id: ZodString;
        }, $strict>], "source">]>>;
      }, $catchall<ZodUnion<readonly [ZodString, ZodNumber, ZodBoolean, ZodNull, ZodArray<ZodUnknown>, ZodRecord<ZodString, ZodUnknown>]>>>>>;
      prefsPath: ZodOptional<ZodString>;
      maxTextLength: ZodOptional<ZodNumber>;
      timeoutMs: ZodOptional<ZodNumber>;
    }, $strict>>>;
  }, $strict>>;
  pluralkit: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    token: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
      source: ZodLiteral<"env">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"file">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"exec">;
      provider: ZodString;
      id: ZodString;
    }, $strict>], "source">]>>;
  }, $strict>>;
  responsePrefix: ZodOptional<ZodString>;
  ackReaction: ZodOptional<ZodString>;
  ackReactionScope: ZodOptional<ZodEnum<{
    none: "none";
    off: "off";
    all: "all";
    direct: "direct";
    "group-mentions": "group-mentions";
    "group-all": "group-all";
  }>>;
  activity: ZodOptional<ZodString>;
  status: ZodOptional<ZodEnum<{
    idle: "idle";
    online: "online";
    dnd: "dnd";
    invisible: "invisible";
  }>>;
  autoPresence: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    intervalMs: ZodOptional<ZodNumber>;
    minUpdateIntervalMs: ZodOptional<ZodNumber>;
    healthyText: ZodOptional<ZodString>;
    degradedText: ZodOptional<ZodString>;
    exhaustedText: ZodOptional<ZodString>;
  }, $strict>>;
  activityType: ZodOptional<ZodUnion<readonly [ZodLiteral<0>, ZodLiteral<1>, ZodLiteral<2>, ZodLiteral<3>, ZodLiteral<4>, ZodLiteral<5>]>>;
  activityUrl: ZodOptional<ZodString>;
  inboundWorker: ZodOptional<ZodObject<{
    runTimeoutMs: ZodOptional<ZodNumber>;
  }, $strict>>;
  eventQueue: ZodOptional<ZodObject<{
    listenerTimeout: ZodOptional<ZodNumber>;
    maxQueueSize: ZodOptional<ZodNumber>;
    maxConcurrency: ZodOptional<ZodNumber>;
  }, $strict>>;
  accounts: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    name: ZodOptional<ZodString>;
    capabilities: ZodOptional<ZodArray<ZodString>>;
    markdown: ZodOptional<ZodObject<{
      tables: ZodOptional<ZodEnum<{
        code: "code";
        off: "off";
        block: "block";
        bullets: "bullets";
      }>>;
    }, $strict>>;
    enabled: ZodOptional<ZodBoolean>;
    commands: ZodOptional<ZodObject<{
      native: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"auto">]>>;
      nativeSkills: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"auto">]>>;
    }, $strict>>;
    configWrites: ZodOptional<ZodBoolean>;
    token: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
      source: ZodLiteral<"env">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"file">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"exec">;
      provider: ZodString;
      id: ZodString;
    }, $strict>], "source">]>>;
    applicationId: ZodOptional<ZodPipe<ZodPipe<ZodUnion<readonly [ZodString, ZodNumber]>, ZodTransform<string, string | number>>, ZodString>>;
    proxy: ZodOptional<ZodString>;
    gatewayInfoTimeoutMs: ZodOptional<ZodNumber>;
    gatewayReadyTimeoutMs: ZodOptional<ZodNumber>;
    gatewayRuntimeReadyTimeoutMs: ZodOptional<ZodNumber>;
    allowBots: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"mentions">]>>;
    botLoopProtection: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      maxEventsPerWindow: ZodOptional<ZodNumber>;
      windowSeconds: ZodOptional<ZodNumber>;
      cooldownSeconds: ZodOptional<ZodNumber>;
    }, $strict>>;
    dangerouslyAllowNameMatching: ZodOptional<ZodBoolean>;
    mentionAliases: ZodOptional<ZodRecord<ZodString, ZodString>>;
    groupPolicy: ZodDefault<ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      open: "open";
    }>>>;
    contextVisibility: ZodOptional<ZodEnum<{
      all: "all";
      allowlist: "allowlist";
      allowlist_quote: "allowlist_quote";
    }>>;
    historyLimit: ZodOptional<ZodNumber>;
    dmHistoryLimit: ZodOptional<ZodNumber>;
    dms: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      historyLimit: ZodOptional<ZodNumber>;
    }, $strict>>>>;
    textChunkLimit: ZodOptional<ZodNumber>;
    suppressEmbeds: ZodOptional<ZodBoolean>;
    streaming: ZodOptional<ZodObject<{
      mode: ZodOptional<ZodEnum<{
        off: "off";
        progress: "progress";
        partial: "partial";
        block: "block";
      }>>;
      chunkMode: ZodOptional<ZodEnum<{
        length: "length";
        newline: "newline";
      }>>;
      preview: ZodOptional<ZodObject<{
        chunk: ZodOptional<ZodObject<{
          minChars: ZodOptional<ZodNumber>;
          maxChars: ZodOptional<ZodNumber>;
          breakPreference: ZodOptional<ZodUnion<readonly [ZodLiteral<"paragraph">, ZodLiteral<"newline">, ZodLiteral<"sentence">]>>;
        }, $strict>>;
        toolProgress: ZodOptional<ZodBoolean>;
        commandText: ZodOptional<ZodEnum<{
          status: "status";
          raw: "raw";
        }>>;
      }, $strict>>;
      progress: ZodOptional<ZodObject<{
        label: ZodOptional<ZodUnion<readonly [ZodString, ZodLiteral<false>]>>;
        labels: ZodOptional<ZodArray<ZodString>>;
        maxLines: ZodOptional<ZodNumber>;
        maxLineChars: ZodOptional<ZodNumber>;
        render: ZodOptional<ZodEnum<{
          text: "text";
          rich: "rich";
        }>>;
        toolProgress: ZodOptional<ZodBoolean>;
        commandText: ZodOptional<ZodEnum<{
          status: "status";
          raw: "raw";
        }>>;
      }, $strict>>;
      block: ZodOptional<ZodObject<{
        enabled: ZodOptional<ZodBoolean>;
        coalesce: ZodOptional<ZodObject<{
          minChars: ZodOptional<ZodNumber>;
          maxChars: ZodOptional<ZodNumber>;
          idleMs: ZodOptional<ZodNumber>;
        }, $strict>>;
      }, $strict>>;
    }, $strict>>;
    maxLinesPerMessage: ZodOptional<ZodNumber>;
    mediaMaxMb: ZodOptional<ZodNumber>;
    retry: ZodOptional<ZodObject<{
      attempts: ZodOptional<ZodNumber>;
      minDelayMs: ZodOptional<ZodNumber>;
      maxDelayMs: ZodOptional<ZodNumber>;
      jitter: ZodOptional<ZodNumber>;
    }, $strict>>;
    actions: ZodOptional<ZodObject<{
      reactions: ZodOptional<ZodBoolean>;
      stickers: ZodOptional<ZodBoolean>;
      emojiUploads: ZodOptional<ZodBoolean>;
      stickerUploads: ZodOptional<ZodBoolean>;
      polls: ZodOptional<ZodBoolean>;
      permissions: ZodOptional<ZodBoolean>;
      messages: ZodOptional<ZodBoolean>;
      threads: ZodOptional<ZodBoolean>;
      pins: ZodOptional<ZodBoolean>;
      search: ZodOptional<ZodBoolean>;
      memberInfo: ZodOptional<ZodBoolean>;
      roleInfo: ZodOptional<ZodBoolean>;
      roles: ZodOptional<ZodBoolean>;
      channelInfo: ZodOptional<ZodBoolean>;
      voiceStatus: ZodOptional<ZodBoolean>;
      events: ZodOptional<ZodBoolean>;
      moderation: ZodOptional<ZodBoolean>;
      channels: ZodOptional<ZodBoolean>;
      presence: ZodOptional<ZodBoolean>;
    }, $strict>>;
    replyToMode: ZodOptional<ZodUnion<readonly [ZodLiteral<"off">, ZodLiteral<"first">, ZodLiteral<"all">, ZodLiteral<"batched">]>>;
    thread: ZodOptional<ZodObject<{
      inheritParent: ZodOptional<ZodBoolean>;
    }, $strict>>;
    dmPolicy: ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      pairing: "pairing";
      open: "open";
    }>>;
    allowFrom: ZodOptional<ZodArray<ZodPipe<ZodPipe<ZodUnion<readonly [ZodString, ZodNumber]>, ZodTransform<string, string | number>>, ZodString>>>;
    defaultTo: ZodOptional<ZodString>;
    dm: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      policy: ZodOptional<ZodEnum<{
        disabled: "disabled";
        allowlist: "allowlist";
        pairing: "pairing";
        open: "open";
      }>>;
      allowFrom: ZodOptional<ZodArray<ZodPipe<ZodPipe<ZodUnion<readonly [ZodString, ZodNumber]>, ZodTransform<string, string | number>>, ZodString>>>;
      groupEnabled: ZodOptional<ZodBoolean>;
      groupChannels: ZodOptional<ZodArray<ZodPipe<ZodPipe<ZodUnion<readonly [ZodString, ZodNumber]>, ZodTransform<string, string | number>>, ZodString>>>;
    }, $strict>>;
    guilds: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      slug: ZodOptional<ZodString>;
      requireMention: ZodOptional<ZodBoolean>;
      ignoreOtherMentions: ZodOptional<ZodBoolean>;
      tools: ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        alsoAllow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>;
      toolsBySender: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        alsoAllow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>>>;
      reactionNotifications: ZodOptional<ZodEnum<{
        off: "off";
        all: "all";
        allowlist: "allowlist";
        own: "own";
      }>>;
      users: ZodOptional<ZodArray<ZodPipe<ZodPipe<ZodUnion<readonly [ZodString, ZodNumber]>, ZodTransform<string, string | number>>, ZodString>>>;
      roles: ZodOptional<ZodArray<ZodPipe<ZodPipe<ZodUnion<readonly [ZodString, ZodNumber]>, ZodTransform<string, string | number>>, ZodString>>>;
      channels: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
        requireMention: ZodOptional<ZodBoolean>;
        ignoreOtherMentions: ZodOptional<ZodBoolean>;
        tools: ZodOptional<ZodObject<{
          allow: ZodOptional<ZodArray<ZodString>>;
          alsoAllow: ZodOptional<ZodArray<ZodString>>;
          deny: ZodOptional<ZodArray<ZodString>>;
        }, $strict>>;
        toolsBySender: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
          allow: ZodOptional<ZodArray<ZodString>>;
          alsoAllow: ZodOptional<ZodArray<ZodString>>;
          deny: ZodOptional<ZodArray<ZodString>>;
        }, $strict>>>>;
        skills: ZodOptional<ZodArray<ZodString>>;
        enabled: ZodOptional<ZodBoolean>;
        users: ZodOptional<ZodArray<ZodPipe<ZodPipe<ZodUnion<readonly [ZodString, ZodNumber]>, ZodTransform<string, string | number>>, ZodString>>>;
        roles: ZodOptional<ZodArray<ZodPipe<ZodPipe<ZodUnion<readonly [ZodString, ZodNumber]>, ZodTransform<string, string | number>>, ZodString>>>;
        systemPrompt: ZodOptional<ZodString>;
        includeThreadStarter: ZodOptional<ZodBoolean>;
        autoThread: ZodOptional<ZodBoolean>;
        autoThreadName: ZodOptional<ZodEnum<{
          message: "message";
          generated: "generated";
        }>>;
        autoArchiveDuration: ZodOptional<ZodUnion<readonly [ZodEnum<{
          60: "60";
          1440: "1440";
          4320: "4320";
          10080: "10080";
        }>, ZodLiteral<60>, ZodLiteral<1440>, ZodLiteral<4320>, ZodLiteral<10080>]>>;
      }, $strict>>>>;
    }, $strict>>>>;
    heartbeat: ZodOptional<ZodObject<{
      showOk: ZodOptional<ZodBoolean>;
      showAlerts: ZodOptional<ZodBoolean>;
      useIndicator: ZodOptional<ZodBoolean>;
    }, $strict>>;
    healthMonitor: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
    }, $strict>>;
    execApprovals: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"auto">]>>;
      approvers: ZodOptional<ZodArray<ZodPipe<ZodPipe<ZodUnion<readonly [ZodString, ZodNumber]>, ZodTransform<string, string | number>>, ZodString>>>;
      agentFilter: ZodOptional<ZodArray<ZodString>>;
      sessionFilter: ZodOptional<ZodArray<ZodString>>;
      cleanupAfterResolve: ZodOptional<ZodBoolean>;
      target: ZodOptional<ZodEnum<{
        channel: "channel";
        both: "both";
        dm: "dm";
      }>>;
    }, $strict>>;
    agentComponents: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      ttlMs: ZodOptional<ZodNumber>;
    }, $strict>>;
    ui: ZodOptional<ZodObject<{
      components: ZodOptional<ZodObject<{
        accentColor: ZodOptional<ZodString>;
      }, $strict>>;
    }, $strict>>;
    slashCommand: ZodOptional<ZodObject<{
      ephemeral: ZodOptional<ZodBoolean>;
    }, $strict>>;
    threadBindings: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      idleHours: ZodOptional<ZodNumber>;
      maxAgeHours: ZodOptional<ZodNumber>;
      spawnSessions: ZodOptional<ZodBoolean>;
      defaultSpawnContext: ZodOptional<ZodEnum<{
        isolated: "isolated";
        fork: "fork";
      }>>;
      spawnSubagentSessions: ZodOptional<ZodBoolean>;
      spawnAcpSessions: ZodOptional<ZodBoolean>;
    }, $strict>>;
    intents: ZodOptional<ZodObject<{
      presence: ZodOptional<ZodBoolean>;
      guildMembers: ZodOptional<ZodBoolean>;
      voiceStates: ZodOptional<ZodBoolean>;
    }, $strict>>;
    voice: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      mode: ZodOptional<ZodEnum<{
        "stt-tts": "stt-tts";
        "agent-proxy": "agent-proxy";
        bidi: "bidi";
      }>>;
      agentSession: ZodOptional<ZodObject<{
        mode: ZodOptional<ZodEnum<{
          voice: "voice";
          target: "target";
        }>>;
        target: ZodOptional<ZodString>;
      }, $strict>>;
      model: ZodOptional<ZodString>;
      realtime: ZodOptional<ZodObject<{
        provider: ZodOptional<ZodString>;
        model: ZodOptional<ZodString>;
        voice: ZodOptional<ZodString>;
        instructions: ZodOptional<ZodString>;
        toolPolicy: ZodOptional<ZodEnum<{
          none: "none";
          owner: "owner";
          "safe-read-only": "safe-read-only";
        }>>;
        consultPolicy: ZodOptional<ZodEnum<{
          always: "always";
          auto: "auto";
        }>>;
        bootstrapContextFiles: ZodOptional<ZodArray<ZodEnum<{
          "IDENTITY.md": "IDENTITY.md";
          "USER.md": "USER.md";
          "SOUL.md": "SOUL.md";
        }>>>;
        bargeIn: ZodOptional<ZodBoolean>;
        minBargeInAudioEndMs: ZodOptional<ZodNumber>;
        debounceMs: ZodOptional<ZodNumber>;
        providers: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodRecord<ZodString, ZodUnknown>>>>;
      }, $strict>>;
      autoJoin: ZodOptional<ZodArray<ZodObject<{
        guildId: ZodString;
        channelId: ZodString;
      }, $strict>>>;
      followUsersEnabled: ZodOptional<ZodBoolean>;
      followUsers: ZodOptional<ZodArray<ZodString>>;
      allowedChannels: ZodOptional<ZodArray<ZodObject<{
        guildId: ZodString;
        channelId: ZodString;
      }, $strict>>>;
      daveEncryption: ZodOptional<ZodBoolean>;
      decryptionFailureTolerance: ZodOptional<ZodNumber>;
      connectTimeoutMs: ZodOptional<ZodNumber>;
      reconnectGraceMs: ZodOptional<ZodNumber>;
      captureSilenceGraceMs: ZodOptional<ZodNumber>;
      tts: ZodOptional<ZodOptional<ZodObject<{
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
        personas: ZodOptional<ZodRecord<ZodString, ZodObject<{
          label: ZodOptional<ZodString>;
          description: ZodOptional<ZodString>;
          provider: ZodOptional<ZodString>;
          fallbackPolicy: ZodOptional<ZodUnion<readonly [ZodLiteral<"preserve-persona">, ZodLiteral<"provider-defaults">, ZodLiteral<"fail">]>>;
          prompt: ZodOptional<ZodObject<{
            profile: ZodOptional<ZodString>;
            scene: ZodOptional<ZodString>;
            sampleContext: ZodOptional<ZodString>;
            style: ZodOptional<ZodString>;
            accent: ZodOptional<ZodString>;
            pacing: ZodOptional<ZodString>;
            constraints: ZodOptional<ZodArray<ZodString>>;
          }, $strict>>;
          providers: ZodOptional<ZodRecord<ZodString, ZodObject<{
            apiKey: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
              source: ZodLiteral<"env">;
              provider: ZodString;
              id: ZodString;
            }, $strict>, ZodObject<{
              source: ZodLiteral<"file">;
              provider: ZodString;
              id: ZodString;
            }, $strict>, ZodObject<{
              source: ZodLiteral<"exec">;
              provider: ZodString;
              id: ZodString;
            }, $strict>], "source">]>>;
          }, $catchall<ZodUnion<readonly [ZodString, ZodNumber, ZodBoolean, ZodNull, ZodArray<ZodUnknown>, ZodRecord<ZodString, ZodUnknown>]>>>>>;
        }, $strict>>>;
        summaryModel: ZodOptional<ZodString>;
        modelOverrides: ZodOptional<ZodObject<{
          enabled: ZodOptional<ZodBoolean>;
          allowText: ZodOptional<ZodBoolean>;
          allowProvider: ZodOptional<ZodBoolean>;
          allowVoice: ZodOptional<ZodBoolean>;
          allowModelId: ZodOptional<ZodBoolean>;
          allowVoiceSettings: ZodOptional<ZodBoolean>;
          allowNormalization: ZodOptional<ZodBoolean>;
          allowSeed: ZodOptional<ZodBoolean>;
        }, $strict>>;
        providers: ZodOptional<ZodRecord<ZodString, ZodObject<{
          apiKey: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
            source: ZodLiteral<"env">;
            provider: ZodString;
            id: ZodString;
          }, $strict>, ZodObject<{
            source: ZodLiteral<"file">;
            provider: ZodString;
            id: ZodString;
          }, $strict>, ZodObject<{
            source: ZodLiteral<"exec">;
            provider: ZodString;
            id: ZodString;
          }, $strict>], "source">]>>;
        }, $catchall<ZodUnion<readonly [ZodString, ZodNumber, ZodBoolean, ZodNull, ZodArray<ZodUnknown>, ZodRecord<ZodString, ZodUnknown>]>>>>>;
        prefsPath: ZodOptional<ZodString>;
        maxTextLength: ZodOptional<ZodNumber>;
        timeoutMs: ZodOptional<ZodNumber>;
      }, $strict>>>;
    }, $strict>>;
    pluralkit: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      token: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
        source: ZodLiteral<"env">;
        provider: ZodString;
        id: ZodString;
      }, $strict>, ZodObject<{
        source: ZodLiteral<"file">;
        provider: ZodString;
        id: ZodString;
      }, $strict>, ZodObject<{
        source: ZodLiteral<"exec">;
        provider: ZodString;
        id: ZodString;
      }, $strict>], "source">]>>;
    }, $strict>>;
    responsePrefix: ZodOptional<ZodString>;
    ackReaction: ZodOptional<ZodString>;
    ackReactionScope: ZodOptional<ZodEnum<{
      none: "none";
      off: "off";
      all: "all";
      direct: "direct";
      "group-mentions": "group-mentions";
      "group-all": "group-all";
    }>>;
    activity: ZodOptional<ZodString>;
    status: ZodOptional<ZodEnum<{
      idle: "idle";
      online: "online";
      dnd: "dnd";
      invisible: "invisible";
    }>>;
    autoPresence: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      intervalMs: ZodOptional<ZodNumber>;
      minUpdateIntervalMs: ZodOptional<ZodNumber>;
      healthyText: ZodOptional<ZodString>;
      degradedText: ZodOptional<ZodString>;
      exhaustedText: ZodOptional<ZodString>;
    }, $strict>>;
    activityType: ZodOptional<ZodUnion<readonly [ZodLiteral<0>, ZodLiteral<1>, ZodLiteral<2>, ZodLiteral<3>, ZodLiteral<4>, ZodLiteral<5>]>>;
    activityUrl: ZodOptional<ZodString>;
    inboundWorker: ZodOptional<ZodObject<{
      runTimeoutMs: ZodOptional<ZodNumber>;
    }, $strict>>;
    eventQueue: ZodOptional<ZodObject<{
      listenerTimeout: ZodOptional<ZodNumber>;
      maxQueueSize: ZodOptional<ZodNumber>;
      maxConcurrency: ZodOptional<ZodNumber>;
    }, $strict>>;
  }, $strict>>>>;
  defaultAccount: ZodOptional<ZodString>;
}, $strict>;
declare const GoogleChatConfigSchema: ZodObject<{
  name: ZodOptional<ZodString>;
  capabilities: ZodOptional<ZodArray<ZodString>>;
  enabled: ZodOptional<ZodBoolean>;
  configWrites: ZodOptional<ZodBoolean>;
  allowBots: ZodOptional<ZodBoolean>;
  botLoopProtection: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    maxEventsPerWindow: ZodOptional<ZodNumber>;
    windowSeconds: ZodOptional<ZodNumber>;
    cooldownSeconds: ZodOptional<ZodNumber>;
  }, $strict>>;
  dangerouslyAllowNameMatching: ZodOptional<ZodBoolean>;
  requireMention: ZodOptional<ZodBoolean>;
  groupPolicy: ZodDefault<ZodOptional<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    open: "open";
  }>>>;
  groupAllowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
  groups: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    requireMention: ZodOptional<ZodBoolean>;
    botLoopProtection: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      maxEventsPerWindow: ZodOptional<ZodNumber>;
      windowSeconds: ZodOptional<ZodNumber>;
      cooldownSeconds: ZodOptional<ZodNumber>;
    }, $strict>>;
    users: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    systemPrompt: ZodOptional<ZodString>;
  }, $strict>>>>;
  defaultTo: ZodOptional<ZodString>;
  serviceAccount: ZodOptional<ZodUnion<readonly [ZodString, ZodRecord<ZodString, ZodUnknown>, ZodDiscriminatedUnion<[ZodObject<{
    source: ZodLiteral<"env">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"file">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"exec">;
    provider: ZodString;
    id: ZodString;
  }, $strict>], "source">]>>;
  serviceAccountRef: ZodOptional<ZodDiscriminatedUnion<[ZodObject<{
    source: ZodLiteral<"env">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"file">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"exec">;
    provider: ZodString;
    id: ZodString;
  }, $strict>], "source">>;
  serviceAccountFile: ZodOptional<ZodString>;
  audienceType: ZodOptional<ZodEnum<{
    "app-url": "app-url";
    "project-number": "project-number";
  }>>;
  audience: ZodOptional<ZodString>;
  appPrincipal: ZodOptional<ZodString>;
  webhookPath: ZodOptional<ZodString>;
  webhookUrl: ZodOptional<ZodString>;
  botUser: ZodOptional<ZodString>;
  historyLimit: ZodOptional<ZodNumber>;
  dmHistoryLimit: ZodOptional<ZodNumber>;
  dms: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    historyLimit: ZodOptional<ZodNumber>;
  }, $strict>>>>;
  textChunkLimit: ZodOptional<ZodNumber>;
  chunkMode: ZodOptional<ZodEnum<{
    length: "length";
    newline: "newline";
  }>>;
  blockStreaming: ZodOptional<ZodBoolean>;
  blockStreamingCoalesce: ZodOptional<ZodObject<{
    minChars: ZodOptional<ZodNumber>;
    maxChars: ZodOptional<ZodNumber>;
    idleMs: ZodOptional<ZodNumber>;
  }, $strict>>;
  mediaMaxMb: ZodOptional<ZodNumber>;
  replyToMode: ZodOptional<ZodUnion<readonly [ZodLiteral<"off">, ZodLiteral<"first">, ZodLiteral<"all">, ZodLiteral<"batched">]>>;
  actions: ZodOptional<ZodObject<{
    reactions: ZodOptional<ZodBoolean>;
  }, $strict>>;
  dm: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    policy: ZodDefault<ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      pairing: "pairing";
      open: "open";
    }>>>;
    allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
  }, $strict>>;
  healthMonitor: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
  }, $strict>>;
  typingIndicator: ZodOptional<ZodEnum<{
    none: "none";
    message: "message";
    reaction: "reaction";
  }>>;
  responsePrefix: ZodOptional<ZodString>;
  accounts: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    name: ZodOptional<ZodString>;
    capabilities: ZodOptional<ZodArray<ZodString>>;
    enabled: ZodOptional<ZodBoolean>;
    configWrites: ZodOptional<ZodBoolean>;
    allowBots: ZodOptional<ZodBoolean>;
    botLoopProtection: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      maxEventsPerWindow: ZodOptional<ZodNumber>;
      windowSeconds: ZodOptional<ZodNumber>;
      cooldownSeconds: ZodOptional<ZodNumber>;
    }, $strict>>;
    dangerouslyAllowNameMatching: ZodOptional<ZodBoolean>;
    requireMention: ZodOptional<ZodBoolean>;
    groupPolicy: ZodDefault<ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      open: "open";
    }>>>;
    groupAllowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    groups: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      requireMention: ZodOptional<ZodBoolean>;
      botLoopProtection: ZodOptional<ZodObject<{
        enabled: ZodOptional<ZodBoolean>;
        maxEventsPerWindow: ZodOptional<ZodNumber>;
        windowSeconds: ZodOptional<ZodNumber>;
        cooldownSeconds: ZodOptional<ZodNumber>;
      }, $strict>>;
      users: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
      systemPrompt: ZodOptional<ZodString>;
    }, $strict>>>>;
    defaultTo: ZodOptional<ZodString>;
    serviceAccount: ZodOptional<ZodUnion<readonly [ZodString, ZodRecord<ZodString, ZodUnknown>, ZodDiscriminatedUnion<[ZodObject<{
      source: ZodLiteral<"env">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"file">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"exec">;
      provider: ZodString;
      id: ZodString;
    }, $strict>], "source">]>>;
    serviceAccountRef: ZodOptional<ZodDiscriminatedUnion<[ZodObject<{
      source: ZodLiteral<"env">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"file">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"exec">;
      provider: ZodString;
      id: ZodString;
    }, $strict>], "source">>;
    serviceAccountFile: ZodOptional<ZodString>;
    audienceType: ZodOptional<ZodEnum<{
      "app-url": "app-url";
      "project-number": "project-number";
    }>>;
    audience: ZodOptional<ZodString>;
    appPrincipal: ZodOptional<ZodString>;
    webhookPath: ZodOptional<ZodString>;
    webhookUrl: ZodOptional<ZodString>;
    botUser: ZodOptional<ZodString>;
    historyLimit: ZodOptional<ZodNumber>;
    dmHistoryLimit: ZodOptional<ZodNumber>;
    dms: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      historyLimit: ZodOptional<ZodNumber>;
    }, $strict>>>>;
    textChunkLimit: ZodOptional<ZodNumber>;
    chunkMode: ZodOptional<ZodEnum<{
      length: "length";
      newline: "newline";
    }>>;
    blockStreaming: ZodOptional<ZodBoolean>;
    blockStreamingCoalesce: ZodOptional<ZodObject<{
      minChars: ZodOptional<ZodNumber>;
      maxChars: ZodOptional<ZodNumber>;
      idleMs: ZodOptional<ZodNumber>;
    }, $strict>>;
    mediaMaxMb: ZodOptional<ZodNumber>;
    replyToMode: ZodOptional<ZodUnion<readonly [ZodLiteral<"off">, ZodLiteral<"first">, ZodLiteral<"all">, ZodLiteral<"batched">]>>;
    actions: ZodOptional<ZodObject<{
      reactions: ZodOptional<ZodBoolean>;
    }, $strict>>;
    dm: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      policy: ZodDefault<ZodOptional<ZodEnum<{
        disabled: "disabled";
        allowlist: "allowlist";
        pairing: "pairing";
        open: "open";
      }>>>;
      allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    }, $strict>>;
    healthMonitor: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
    }, $strict>>;
    typingIndicator: ZodOptional<ZodEnum<{
      none: "none";
      message: "message";
      reaction: "reaction";
    }>>;
    responsePrefix: ZodOptional<ZodString>;
  }, $strict>>>>;
  defaultAccount: ZodOptional<ZodString>;
}, $strict>;
declare const SlackConfigSchema: ZodObject<{
  name: ZodOptional<ZodString>;
  socketMode: ZodOptional<ZodObject<{
    clientPingTimeout: ZodOptional<ZodNumber>;
    serverPingTimeout: ZodOptional<ZodNumber>;
    pingPongLoggingEnabled: ZodOptional<ZodBoolean>;
  }, $strict>>;
  capabilities: ZodOptional<ZodUnion<readonly [ZodArray<ZodString>, ZodObject<{
    interactiveReplies: ZodOptional<ZodBoolean>;
  }, $strict>]>>;
  execApprovals: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"auto">]>>;
    approvers: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    agentFilter: ZodOptional<ZodArray<ZodString>>;
    sessionFilter: ZodOptional<ZodArray<ZodString>>;
    target: ZodOptional<ZodEnum<{
      channel: "channel";
      both: "both";
      dm: "dm";
    }>>;
  }, $strict>>;
  markdown: ZodOptional<ZodObject<{
    tables: ZodOptional<ZodEnum<{
      code: "code";
      off: "off";
      block: "block";
      bullets: "bullets";
    }>>;
  }, $strict>>;
  enabled: ZodOptional<ZodBoolean>;
  commands: ZodOptional<ZodObject<{
    native: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"auto">]>>;
    nativeSkills: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"auto">]>>;
  }, $strict>>;
  configWrites: ZodOptional<ZodBoolean>;
  botToken: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
    source: ZodLiteral<"env">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"file">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"exec">;
    provider: ZodString;
    id: ZodString;
  }, $strict>], "source">]>>;
  appToken: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
    source: ZodLiteral<"env">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"file">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"exec">;
    provider: ZodString;
    id: ZodString;
  }, $strict>], "source">]>>;
  userToken: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
    source: ZodLiteral<"env">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"file">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"exec">;
    provider: ZodString;
    id: ZodString;
  }, $strict>], "source">]>>;
  userTokenReadOnly: ZodDefault<ZodOptional<ZodBoolean>>;
  allowBots: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"mentions">]>>;
  botLoopProtection: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    maxEventsPerWindow: ZodOptional<ZodNumber>;
    windowSeconds: ZodOptional<ZodNumber>;
    cooldownSeconds: ZodOptional<ZodNumber>;
  }, $strict>>;
  dangerouslyAllowNameMatching: ZodOptional<ZodBoolean>;
  requireMention: ZodOptional<ZodBoolean>;
  historyLimit: ZodOptional<ZodNumber>;
  dmHistoryLimit: ZodOptional<ZodNumber>;
  dms: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    historyLimit: ZodOptional<ZodNumber>;
  }, $strict>>>>;
  textChunkLimit: ZodOptional<ZodNumber>;
  unfurlLinks: ZodOptional<ZodBoolean>;
  unfurlMedia: ZodOptional<ZodBoolean>;
  streaming: ZodOptional<ZodObject<{
    mode: ZodOptional<ZodEnum<{
      off: "off";
      progress: "progress";
      partial: "partial";
      block: "block";
    }>>;
    chunkMode: ZodOptional<ZodEnum<{
      length: "length";
      newline: "newline";
    }>>;
    preview: ZodOptional<ZodObject<{
      chunk: ZodOptional<ZodObject<{
        minChars: ZodOptional<ZodNumber>;
        maxChars: ZodOptional<ZodNumber>;
        breakPreference: ZodOptional<ZodUnion<readonly [ZodLiteral<"paragraph">, ZodLiteral<"newline">, ZodLiteral<"sentence">]>>;
      }, $strict>>;
      toolProgress: ZodOptional<ZodBoolean>;
      commandText: ZodOptional<ZodEnum<{
        status: "status";
        raw: "raw";
      }>>;
    }, $strict>>;
    progress: ZodOptional<ZodObject<{
      label: ZodOptional<ZodUnion<readonly [ZodString, ZodLiteral<false>]>>;
      labels: ZodOptional<ZodArray<ZodString>>;
      maxLines: ZodOptional<ZodNumber>;
      maxLineChars: ZodOptional<ZodNumber>;
      render: ZodOptional<ZodEnum<{
        text: "text";
        rich: "rich";
      }>>;
      toolProgress: ZodOptional<ZodBoolean>;
      commandText: ZodOptional<ZodEnum<{
        status: "status";
        raw: "raw";
      }>>;
    }, $strict>>;
    block: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      coalesce: ZodOptional<ZodObject<{
        minChars: ZodOptional<ZodNumber>;
        maxChars: ZodOptional<ZodNumber>;
        idleMs: ZodOptional<ZodNumber>;
      }, $strict>>;
    }, $strict>>;
    nativeTransport: ZodOptional<ZodBoolean>;
  }, $strict>>;
  mediaMaxMb: ZodOptional<ZodNumber>;
  reactionNotifications: ZodOptional<ZodEnum<{
    off: "off";
    all: "all";
    allowlist: "allowlist";
    own: "own";
  }>>;
  reactionAllowlist: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
  replyToMode: ZodOptional<ZodUnion<readonly [ZodLiteral<"off">, ZodLiteral<"first">, ZodLiteral<"all">, ZodLiteral<"batched">]>>;
  replyToModeByChatType: ZodOptional<ZodObject<{
    direct: ZodOptional<ZodUnion<readonly [ZodLiteral<"off">, ZodLiteral<"first">, ZodLiteral<"all">, ZodLiteral<"batched">]>>;
    group: ZodOptional<ZodUnion<readonly [ZodLiteral<"off">, ZodLiteral<"first">, ZodLiteral<"all">, ZodLiteral<"batched">]>>;
    channel: ZodOptional<ZodUnion<readonly [ZodLiteral<"off">, ZodLiteral<"first">, ZodLiteral<"all">, ZodLiteral<"batched">]>>;
  }, $strict>>;
  thread: ZodOptional<ZodObject<{
    historyScope: ZodOptional<ZodEnum<{
      channel: "channel";
      thread: "thread";
    }>>;
    inheritParent: ZodOptional<ZodBoolean>;
    initialHistoryLimit: ZodOptional<ZodNumber>;
    requireExplicitMention: ZodOptional<ZodBoolean>;
  }, $strict>>;
  actions: ZodOptional<ZodObject<{
    reactions: ZodOptional<ZodBoolean>;
    messages: ZodOptional<ZodBoolean>;
    pins: ZodOptional<ZodBoolean>;
    search: ZodOptional<ZodBoolean>;
    permissions: ZodOptional<ZodBoolean>;
    memberInfo: ZodOptional<ZodBoolean>;
    channelInfo: ZodOptional<ZodBoolean>;
    emojiList: ZodOptional<ZodBoolean>;
  }, $strict>>;
  slashCommand: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    name: ZodOptional<ZodString>;
    sessionPrefix: ZodOptional<ZodString>;
    ephemeral: ZodOptional<ZodBoolean>;
  }, $strict>>;
  dmPolicy: ZodOptional<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    pairing: "pairing";
    open: "open";
  }>>;
  allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
  defaultTo: ZodOptional<ZodString>;
  dm: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    policy: ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      pairing: "pairing";
      open: "open";
    }>>;
    allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    groupEnabled: ZodOptional<ZodBoolean>;
    groupChannels: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    replyToMode: ZodOptional<ZodUnion<readonly [ZodLiteral<"off">, ZodLiteral<"first">, ZodLiteral<"all">, ZodLiteral<"batched">]>>;
  }, $strict>>;
  channels: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    requireMention: ZodOptional<ZodBoolean>;
    tools: ZodOptional<ZodObject<{
      allow: ZodOptional<ZodArray<ZodString>>;
      alsoAllow: ZodOptional<ZodArray<ZodString>>;
      deny: ZodOptional<ZodArray<ZodString>>;
    }, $strict>>;
    toolsBySender: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      allow: ZodOptional<ZodArray<ZodString>>;
      alsoAllow: ZodOptional<ZodArray<ZodString>>;
      deny: ZodOptional<ZodArray<ZodString>>;
    }, $strict>>>>;
    allowBots: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"mentions">]>>;
    botLoopProtection: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      maxEventsPerWindow: ZodOptional<ZodNumber>;
      windowSeconds: ZodOptional<ZodNumber>;
      cooldownSeconds: ZodOptional<ZodNumber>;
    }, $strict>>;
    users: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    skills: ZodOptional<ZodArray<ZodString>>;
    systemPrompt: ZodOptional<ZodString>;
  }, $strict>>>>;
  heartbeat: ZodOptional<ZodObject<{
    showOk: ZodOptional<ZodBoolean>;
    showAlerts: ZodOptional<ZodBoolean>;
    useIndicator: ZodOptional<ZodBoolean>;
  }, $strict>>;
  healthMonitor: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
  }, $strict>>;
  responsePrefix: ZodOptional<ZodString>;
  ackReaction: ZodOptional<ZodString>;
  typingReaction: ZodOptional<ZodString>;
  mode: ZodDefault<ZodOptional<ZodEnum<{
    socket: "socket";
    http: "http";
  }>>>;
  signingSecret: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
    source: ZodLiteral<"env">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"file">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"exec">;
    provider: ZodString;
    id: ZodString;
  }, $strict>], "source">]>>;
  webhookPath: ZodDefault<ZodOptional<ZodString>>;
  groupPolicy: ZodDefault<ZodOptional<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    open: "open";
  }>>>;
  contextVisibility: ZodOptional<ZodEnum<{
    all: "all";
    allowlist: "allowlist";
    allowlist_quote: "allowlist_quote";
  }>>;
  accounts: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    name: ZodOptional<ZodString>;
    mode: ZodOptional<ZodEnum<{
      socket: "socket";
      http: "http";
    }>>;
    socketMode: ZodOptional<ZodObject<{
      clientPingTimeout: ZodOptional<ZodNumber>;
      serverPingTimeout: ZodOptional<ZodNumber>;
      pingPongLoggingEnabled: ZodOptional<ZodBoolean>;
    }, $strict>>;
    signingSecret: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
      source: ZodLiteral<"env">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"file">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"exec">;
      provider: ZodString;
      id: ZodString;
    }, $strict>], "source">]>>;
    webhookPath: ZodOptional<ZodString>;
    capabilities: ZodOptional<ZodUnion<readonly [ZodArray<ZodString>, ZodObject<{
      interactiveReplies: ZodOptional<ZodBoolean>;
    }, $strict>]>>;
    execApprovals: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"auto">]>>;
      approvers: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
      agentFilter: ZodOptional<ZodArray<ZodString>>;
      sessionFilter: ZodOptional<ZodArray<ZodString>>;
      target: ZodOptional<ZodEnum<{
        channel: "channel";
        both: "both";
        dm: "dm";
      }>>;
    }, $strict>>;
    markdown: ZodOptional<ZodObject<{
      tables: ZodOptional<ZodEnum<{
        code: "code";
        off: "off";
        block: "block";
        bullets: "bullets";
      }>>;
    }, $strict>>;
    enabled: ZodOptional<ZodBoolean>;
    commands: ZodOptional<ZodObject<{
      native: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"auto">]>>;
      nativeSkills: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"auto">]>>;
    }, $strict>>;
    configWrites: ZodOptional<ZodBoolean>;
    botToken: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
      source: ZodLiteral<"env">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"file">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"exec">;
      provider: ZodString;
      id: ZodString;
    }, $strict>], "source">]>>;
    appToken: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
      source: ZodLiteral<"env">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"file">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"exec">;
      provider: ZodString;
      id: ZodString;
    }, $strict>], "source">]>>;
    userToken: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
      source: ZodLiteral<"env">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"file">;
      provider: ZodString;
      id: ZodString;
    }, $strict>, ZodObject<{
      source: ZodLiteral<"exec">;
      provider: ZodString;
      id: ZodString;
    }, $strict>], "source">]>>;
    userTokenReadOnly: ZodDefault<ZodOptional<ZodBoolean>>;
    allowBots: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"mentions">]>>;
    botLoopProtection: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      maxEventsPerWindow: ZodOptional<ZodNumber>;
      windowSeconds: ZodOptional<ZodNumber>;
      cooldownSeconds: ZodOptional<ZodNumber>;
    }, $strict>>;
    dangerouslyAllowNameMatching: ZodOptional<ZodBoolean>;
    requireMention: ZodOptional<ZodBoolean>;
    groupPolicy: ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      open: "open";
    }>>;
    contextVisibility: ZodOptional<ZodEnum<{
      all: "all";
      allowlist: "allowlist";
      allowlist_quote: "allowlist_quote";
    }>>;
    historyLimit: ZodOptional<ZodNumber>;
    dmHistoryLimit: ZodOptional<ZodNumber>;
    dms: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      historyLimit: ZodOptional<ZodNumber>;
    }, $strict>>>>;
    textChunkLimit: ZodOptional<ZodNumber>;
    unfurlLinks: ZodOptional<ZodBoolean>;
    unfurlMedia: ZodOptional<ZodBoolean>;
    streaming: ZodOptional<ZodObject<{
      mode: ZodOptional<ZodEnum<{
        off: "off";
        progress: "progress";
        partial: "partial";
        block: "block";
      }>>;
      chunkMode: ZodOptional<ZodEnum<{
        length: "length";
        newline: "newline";
      }>>;
      preview: ZodOptional<ZodObject<{
        chunk: ZodOptional<ZodObject<{
          minChars: ZodOptional<ZodNumber>;
          maxChars: ZodOptional<ZodNumber>;
          breakPreference: ZodOptional<ZodUnion<readonly [ZodLiteral<"paragraph">, ZodLiteral<"newline">, ZodLiteral<"sentence">]>>;
        }, $strict>>;
        toolProgress: ZodOptional<ZodBoolean>;
        commandText: ZodOptional<ZodEnum<{
          status: "status";
          raw: "raw";
        }>>;
      }, $strict>>;
      progress: ZodOptional<ZodObject<{
        label: ZodOptional<ZodUnion<readonly [ZodString, ZodLiteral<false>]>>;
        labels: ZodOptional<ZodArray<ZodString>>;
        maxLines: ZodOptional<ZodNumber>;
        maxLineChars: ZodOptional<ZodNumber>;
        render: ZodOptional<ZodEnum<{
          text: "text";
          rich: "rich";
        }>>;
        toolProgress: ZodOptional<ZodBoolean>;
        commandText: ZodOptional<ZodEnum<{
          status: "status";
          raw: "raw";
        }>>;
      }, $strict>>;
      block: ZodOptional<ZodObject<{
        enabled: ZodOptional<ZodBoolean>;
        coalesce: ZodOptional<ZodObject<{
          minChars: ZodOptional<ZodNumber>;
          maxChars: ZodOptional<ZodNumber>;
          idleMs: ZodOptional<ZodNumber>;
        }, $strict>>;
      }, $strict>>;
      nativeTransport: ZodOptional<ZodBoolean>;
    }, $strict>>;
    mediaMaxMb: ZodOptional<ZodNumber>;
    reactionNotifications: ZodOptional<ZodEnum<{
      off: "off";
      all: "all";
      allowlist: "allowlist";
      own: "own";
    }>>;
    reactionAllowlist: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    replyToMode: ZodOptional<ZodUnion<readonly [ZodLiteral<"off">, ZodLiteral<"first">, ZodLiteral<"all">, ZodLiteral<"batched">]>>;
    replyToModeByChatType: ZodOptional<ZodObject<{
      direct: ZodOptional<ZodUnion<readonly [ZodLiteral<"off">, ZodLiteral<"first">, ZodLiteral<"all">, ZodLiteral<"batched">]>>;
      group: ZodOptional<ZodUnion<readonly [ZodLiteral<"off">, ZodLiteral<"first">, ZodLiteral<"all">, ZodLiteral<"batched">]>>;
      channel: ZodOptional<ZodUnion<readonly [ZodLiteral<"off">, ZodLiteral<"first">, ZodLiteral<"all">, ZodLiteral<"batched">]>>;
    }, $strict>>;
    thread: ZodOptional<ZodObject<{
      historyScope: ZodOptional<ZodEnum<{
        channel: "channel";
        thread: "thread";
      }>>;
      inheritParent: ZodOptional<ZodBoolean>;
      initialHistoryLimit: ZodOptional<ZodNumber>;
      requireExplicitMention: ZodOptional<ZodBoolean>;
    }, $strict>>;
    actions: ZodOptional<ZodObject<{
      reactions: ZodOptional<ZodBoolean>;
      messages: ZodOptional<ZodBoolean>;
      pins: ZodOptional<ZodBoolean>;
      search: ZodOptional<ZodBoolean>;
      permissions: ZodOptional<ZodBoolean>;
      memberInfo: ZodOptional<ZodBoolean>;
      channelInfo: ZodOptional<ZodBoolean>;
      emojiList: ZodOptional<ZodBoolean>;
    }, $strict>>;
    slashCommand: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      name: ZodOptional<ZodString>;
      sessionPrefix: ZodOptional<ZodString>;
      ephemeral: ZodOptional<ZodBoolean>;
    }, $strict>>;
    dmPolicy: ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      pairing: "pairing";
      open: "open";
    }>>;
    allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    defaultTo: ZodOptional<ZodString>;
    dm: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      policy: ZodOptional<ZodEnum<{
        disabled: "disabled";
        allowlist: "allowlist";
        pairing: "pairing";
        open: "open";
      }>>;
      allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
      groupEnabled: ZodOptional<ZodBoolean>;
      groupChannels: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
      replyToMode: ZodOptional<ZodUnion<readonly [ZodLiteral<"off">, ZodLiteral<"first">, ZodLiteral<"all">, ZodLiteral<"batched">]>>;
    }, $strict>>;
    channels: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      requireMention: ZodOptional<ZodBoolean>;
      tools: ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        alsoAllow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>;
      toolsBySender: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        alsoAllow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>>>;
      allowBots: ZodOptional<ZodUnion<readonly [ZodBoolean, ZodLiteral<"mentions">]>>;
      botLoopProtection: ZodOptional<ZodObject<{
        enabled: ZodOptional<ZodBoolean>;
        maxEventsPerWindow: ZodOptional<ZodNumber>;
        windowSeconds: ZodOptional<ZodNumber>;
        cooldownSeconds: ZodOptional<ZodNumber>;
      }, $strict>>;
      users: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
      skills: ZodOptional<ZodArray<ZodString>>;
      systemPrompt: ZodOptional<ZodString>;
    }, $strict>>>>;
    heartbeat: ZodOptional<ZodObject<{
      showOk: ZodOptional<ZodBoolean>;
      showAlerts: ZodOptional<ZodBoolean>;
      useIndicator: ZodOptional<ZodBoolean>;
    }, $strict>>;
    healthMonitor: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
    }, $strict>>;
    responsePrefix: ZodOptional<ZodString>;
    ackReaction: ZodOptional<ZodString>;
    typingReaction: ZodOptional<ZodString>;
  }, $strict>>>>;
  defaultAccount: ZodOptional<ZodString>;
}, $strict>;
declare const SignalConfigSchema: ZodObject<{
  name: ZodOptional<ZodString>;
  capabilities: ZodOptional<ZodArray<ZodString>>;
  markdown: ZodOptional<ZodObject<{
    tables: ZodOptional<ZodEnum<{
      code: "code";
      off: "off";
      block: "block";
      bullets: "bullets";
    }>>;
  }, $strict>>;
  enabled: ZodOptional<ZodBoolean>;
  configWrites: ZodOptional<ZodBoolean>;
  account: ZodOptional<ZodString>;
  accountUuid: ZodOptional<ZodString>;
  httpUrl: ZodOptional<ZodString>;
  httpHost: ZodOptional<ZodString>;
  httpPort: ZodOptional<ZodNumber>;
  cliPath: ZodOptional<ZodString>;
  autoStart: ZodOptional<ZodBoolean>;
  startupTimeoutMs: ZodOptional<ZodNumber>;
  receiveMode: ZodOptional<ZodUnion<readonly [ZodLiteral<"on-start">, ZodLiteral<"manual">]>>;
  ignoreAttachments: ZodOptional<ZodBoolean>;
  ignoreStories: ZodOptional<ZodBoolean>;
  sendReadReceipts: ZodOptional<ZodBoolean>;
  dmPolicy: ZodDefault<ZodOptional<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    pairing: "pairing";
    open: "open";
  }>>>;
  allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
  defaultTo: ZodOptional<ZodString>;
  groupAllowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
  groupPolicy: ZodDefault<ZodOptional<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    open: "open";
  }>>>;
  contextVisibility: ZodOptional<ZodEnum<{
    all: "all";
    allowlist: "allowlist";
    allowlist_quote: "allowlist_quote";
  }>>;
  groups: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    requireMention: ZodOptional<ZodBoolean>;
    ingest: ZodOptional<ZodBoolean>;
    tools: ZodOptional<ZodObject<{
      allow: ZodOptional<ZodArray<ZodString>>;
      alsoAllow: ZodOptional<ZodArray<ZodString>>;
      deny: ZodOptional<ZodArray<ZodString>>;
    }, $strict>>;
    toolsBySender: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      allow: ZodOptional<ZodArray<ZodString>>;
      alsoAllow: ZodOptional<ZodArray<ZodString>>;
      deny: ZodOptional<ZodArray<ZodString>>;
    }, $strict>>>>;
  }, $strict>>>>;
  historyLimit: ZodOptional<ZodNumber>;
  dmHistoryLimit: ZodOptional<ZodNumber>;
  dms: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    historyLimit: ZodOptional<ZodNumber>;
  }, $strict>>>>;
  textChunkLimit: ZodOptional<ZodNumber>;
  chunkMode: ZodOptional<ZodEnum<{
    length: "length";
    newline: "newline";
  }>>;
  blockStreaming: ZodOptional<ZodBoolean>;
  blockStreamingCoalesce: ZodOptional<ZodObject<{
    minChars: ZodOptional<ZodNumber>;
    maxChars: ZodOptional<ZodNumber>;
    idleMs: ZodOptional<ZodNumber>;
  }, $strict>>;
  mediaMaxMb: ZodOptional<ZodNumber>;
  reactionNotifications: ZodOptional<ZodEnum<{
    off: "off";
    all: "all";
    allowlist: "allowlist";
    own: "own";
  }>>;
  reactionAllowlist: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
  actions: ZodOptional<ZodObject<{
    reactions: ZodOptional<ZodBoolean>;
  }, $strict>>;
  reactionLevel: ZodOptional<ZodEnum<{
    off: "off";
    minimal: "minimal";
    extensive: "extensive";
    ack: "ack";
  }>>;
  heartbeat: ZodOptional<ZodObject<{
    showOk: ZodOptional<ZodBoolean>;
    showAlerts: ZodOptional<ZodBoolean>;
    useIndicator: ZodOptional<ZodBoolean>;
  }, $strict>>;
  healthMonitor: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
  }, $strict>>;
  responsePrefix: ZodOptional<ZodString>;
  apiMode: ZodOptional<ZodEnum<{
    native: "native";
    auto: "auto";
    container: "container";
  }>>;
  accounts: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    name: ZodOptional<ZodString>;
    capabilities: ZodOptional<ZodArray<ZodString>>;
    markdown: ZodOptional<ZodObject<{
      tables: ZodOptional<ZodEnum<{
        code: "code";
        off: "off";
        block: "block";
        bullets: "bullets";
      }>>;
    }, $strict>>;
    enabled: ZodOptional<ZodBoolean>;
    configWrites: ZodOptional<ZodBoolean>;
    account: ZodOptional<ZodString>;
    accountUuid: ZodOptional<ZodString>;
    httpUrl: ZodOptional<ZodString>;
    httpHost: ZodOptional<ZodString>;
    httpPort: ZodOptional<ZodNumber>;
    cliPath: ZodOptional<ZodString>;
    autoStart: ZodOptional<ZodBoolean>;
    startupTimeoutMs: ZodOptional<ZodNumber>;
    receiveMode: ZodOptional<ZodUnion<readonly [ZodLiteral<"on-start">, ZodLiteral<"manual">]>>;
    ignoreAttachments: ZodOptional<ZodBoolean>;
    ignoreStories: ZodOptional<ZodBoolean>;
    sendReadReceipts: ZodOptional<ZodBoolean>;
    dmPolicy: ZodDefault<ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      pairing: "pairing";
      open: "open";
    }>>>;
    allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    defaultTo: ZodOptional<ZodString>;
    groupAllowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    groupPolicy: ZodDefault<ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      open: "open";
    }>>>;
    contextVisibility: ZodOptional<ZodEnum<{
      all: "all";
      allowlist: "allowlist";
      allowlist_quote: "allowlist_quote";
    }>>;
    groups: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      requireMention: ZodOptional<ZodBoolean>;
      ingest: ZodOptional<ZodBoolean>;
      tools: ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        alsoAllow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>;
      toolsBySender: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        alsoAllow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>>>;
    }, $strict>>>>;
    historyLimit: ZodOptional<ZodNumber>;
    dmHistoryLimit: ZodOptional<ZodNumber>;
    dms: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      historyLimit: ZodOptional<ZodNumber>;
    }, $strict>>>>;
    textChunkLimit: ZodOptional<ZodNumber>;
    chunkMode: ZodOptional<ZodEnum<{
      length: "length";
      newline: "newline";
    }>>;
    blockStreaming: ZodOptional<ZodBoolean>;
    blockStreamingCoalesce: ZodOptional<ZodObject<{
      minChars: ZodOptional<ZodNumber>;
      maxChars: ZodOptional<ZodNumber>;
      idleMs: ZodOptional<ZodNumber>;
    }, $strict>>;
    mediaMaxMb: ZodOptional<ZodNumber>;
    reactionNotifications: ZodOptional<ZodEnum<{
      off: "off";
      all: "all";
      allowlist: "allowlist";
      own: "own";
    }>>;
    reactionAllowlist: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    actions: ZodOptional<ZodObject<{
      reactions: ZodOptional<ZodBoolean>;
    }, $strict>>;
    reactionLevel: ZodOptional<ZodEnum<{
      off: "off";
      minimal: "minimal";
      extensive: "extensive";
      ack: "ack";
    }>>;
    heartbeat: ZodOptional<ZodObject<{
      showOk: ZodOptional<ZodBoolean>;
      showAlerts: ZodOptional<ZodBoolean>;
      useIndicator: ZodOptional<ZodBoolean>;
    }, $strict>>;
    healthMonitor: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
    }, $strict>>;
    responsePrefix: ZodOptional<ZodString>;
  }, $strict>>>>;
  defaultAccount: ZodOptional<ZodString>;
}, $strict>;
declare const IMessageConfigSchema: ZodObject<{
  name: ZodOptional<ZodString>;
  capabilities: ZodOptional<ZodArray<ZodString>>;
  markdown: ZodOptional<ZodObject<{
    tables: ZodOptional<ZodEnum<{
      code: "code";
      off: "off";
      block: "block";
      bullets: "bullets";
    }>>;
  }, $strict>>;
  enabled: ZodOptional<ZodBoolean>;
  configWrites: ZodOptional<ZodBoolean>;
  cliPath: ZodOptional<ZodString>;
  dbPath: ZodOptional<ZodString>;
  remoteHost: ZodOptional<ZodString>;
  actions: ZodOptional<ZodObject<{
    reactions: ZodOptional<ZodBoolean>;
    edit: ZodOptional<ZodBoolean>;
    unsend: ZodOptional<ZodBoolean>;
    reply: ZodOptional<ZodBoolean>;
    sendWithEffect: ZodOptional<ZodBoolean>;
    renameGroup: ZodOptional<ZodBoolean>;
    setGroupIcon: ZodOptional<ZodBoolean>;
    addParticipant: ZodOptional<ZodBoolean>;
    removeParticipant: ZodOptional<ZodBoolean>;
    leaveGroup: ZodOptional<ZodBoolean>;
    sendAttachment: ZodOptional<ZodBoolean>;
  }, $strict>>;
  service: ZodOptional<ZodUnion<readonly [ZodLiteral<"imessage">, ZodLiteral<"sms">, ZodLiteral<"auto">]>>;
  region: ZodOptional<ZodString>;
  dmPolicy: ZodDefault<ZodOptional<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    pairing: "pairing";
    open: "open";
  }>>>;
  allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
  defaultTo: ZodOptional<ZodString>;
  groupAllowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
  groupPolicy: ZodDefault<ZodOptional<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    open: "open";
  }>>>;
  contextVisibility: ZodOptional<ZodEnum<{
    all: "all";
    allowlist: "allowlist";
    allowlist_quote: "allowlist_quote";
  }>>;
  historyLimit: ZodOptional<ZodNumber>;
  dmHistoryLimit: ZodOptional<ZodNumber>;
  dms: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    historyLimit: ZodOptional<ZodNumber>;
  }, $strict>>>>;
  includeAttachments: ZodOptional<ZodBoolean>;
  attachmentRoots: ZodOptional<ZodArray<ZodString>>;
  remoteAttachmentRoots: ZodOptional<ZodArray<ZodString>>;
  mediaMaxMb: ZodOptional<ZodNumber>;
  probeTimeoutMs: ZodOptional<ZodNumber>;
  textChunkLimit: ZodOptional<ZodNumber>;
  chunkMode: ZodOptional<ZodEnum<{
    length: "length";
    newline: "newline";
  }>>;
  blockStreaming: ZodOptional<ZodBoolean>;
  blockStreamingCoalesce: ZodOptional<ZodObject<{
    minChars: ZodOptional<ZodNumber>;
    maxChars: ZodOptional<ZodNumber>;
    idleMs: ZodOptional<ZodNumber>;
  }, $strict>>;
  sendReadReceipts: ZodOptional<ZodBoolean>;
  reactionNotifications: ZodOptional<ZodEnum<{
    off: "off";
    all: "all";
    own: "own";
  }>>;
  coalesceSameSenderDms: ZodOptional<ZodBoolean>;
  groups: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    requireMention: ZodOptional<ZodBoolean>;
    tools: ZodOptional<ZodObject<{
      allow: ZodOptional<ZodArray<ZodString>>;
      alsoAllow: ZodOptional<ZodArray<ZodString>>;
      deny: ZodOptional<ZodArray<ZodString>>;
    }, $strict>>;
    toolsBySender: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      allow: ZodOptional<ZodArray<ZodString>>;
      alsoAllow: ZodOptional<ZodArray<ZodString>>;
      deny: ZodOptional<ZodArray<ZodString>>;
    }, $strict>>>>;
    systemPrompt: ZodOptional<ZodString>;
  }, $strict>>>>;
  catchup: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    maxAgeMinutes: ZodOptional<ZodNumber>;
    perRunLimit: ZodOptional<ZodNumber>;
    firstRunLookbackMinutes: ZodOptional<ZodNumber>;
    maxFailureRetries: ZodOptional<ZodNumber>;
  }, $strict>>;
  heartbeat: ZodOptional<ZodObject<{
    showOk: ZodOptional<ZodBoolean>;
    showAlerts: ZodOptional<ZodBoolean>;
    useIndicator: ZodOptional<ZodBoolean>;
  }, $strict>>;
  healthMonitor: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
  }, $strict>>;
  responsePrefix: ZodOptional<ZodString>;
  accounts: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    name: ZodOptional<ZodString>;
    capabilities: ZodOptional<ZodArray<ZodString>>;
    markdown: ZodOptional<ZodObject<{
      tables: ZodOptional<ZodEnum<{
        code: "code";
        off: "off";
        block: "block";
        bullets: "bullets";
      }>>;
    }, $strict>>;
    enabled: ZodOptional<ZodBoolean>;
    configWrites: ZodOptional<ZodBoolean>;
    cliPath: ZodOptional<ZodString>;
    dbPath: ZodOptional<ZodString>;
    remoteHost: ZodOptional<ZodString>;
    actions: ZodOptional<ZodObject<{
      reactions: ZodOptional<ZodBoolean>;
      edit: ZodOptional<ZodBoolean>;
      unsend: ZodOptional<ZodBoolean>;
      reply: ZodOptional<ZodBoolean>;
      sendWithEffect: ZodOptional<ZodBoolean>;
      renameGroup: ZodOptional<ZodBoolean>;
      setGroupIcon: ZodOptional<ZodBoolean>;
      addParticipant: ZodOptional<ZodBoolean>;
      removeParticipant: ZodOptional<ZodBoolean>;
      leaveGroup: ZodOptional<ZodBoolean>;
      sendAttachment: ZodOptional<ZodBoolean>;
    }, $strict>>;
    service: ZodOptional<ZodUnion<readonly [ZodLiteral<"imessage">, ZodLiteral<"sms">, ZodLiteral<"auto">]>>;
    region: ZodOptional<ZodString>;
    dmPolicy: ZodDefault<ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      pairing: "pairing";
      open: "open";
    }>>>;
    allowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    defaultTo: ZodOptional<ZodString>;
    groupAllowFrom: ZodOptional<ZodArray<ZodUnion<readonly [ZodString, ZodNumber]>>>;
    groupPolicy: ZodDefault<ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      open: "open";
    }>>>;
    contextVisibility: ZodOptional<ZodEnum<{
      all: "all";
      allowlist: "allowlist";
      allowlist_quote: "allowlist_quote";
    }>>;
    historyLimit: ZodOptional<ZodNumber>;
    dmHistoryLimit: ZodOptional<ZodNumber>;
    dms: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      historyLimit: ZodOptional<ZodNumber>;
    }, $strict>>>>;
    includeAttachments: ZodOptional<ZodBoolean>;
    attachmentRoots: ZodOptional<ZodArray<ZodString>>;
    remoteAttachmentRoots: ZodOptional<ZodArray<ZodString>>;
    mediaMaxMb: ZodOptional<ZodNumber>;
    probeTimeoutMs: ZodOptional<ZodNumber>;
    textChunkLimit: ZodOptional<ZodNumber>;
    chunkMode: ZodOptional<ZodEnum<{
      length: "length";
      newline: "newline";
    }>>;
    blockStreaming: ZodOptional<ZodBoolean>;
    blockStreamingCoalesce: ZodOptional<ZodObject<{
      minChars: ZodOptional<ZodNumber>;
      maxChars: ZodOptional<ZodNumber>;
      idleMs: ZodOptional<ZodNumber>;
    }, $strict>>;
    sendReadReceipts: ZodOptional<ZodBoolean>;
    reactionNotifications: ZodOptional<ZodEnum<{
      off: "off";
      all: "all";
      own: "own";
    }>>;
    coalesceSameSenderDms: ZodOptional<ZodBoolean>;
    groups: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      requireMention: ZodOptional<ZodBoolean>;
      tools: ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        alsoAllow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>;
      toolsBySender: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        alsoAllow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>>>;
      systemPrompt: ZodOptional<ZodString>;
    }, $strict>>>>;
    catchup: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      maxAgeMinutes: ZodOptional<ZodNumber>;
      perRunLimit: ZodOptional<ZodNumber>;
      firstRunLookbackMinutes: ZodOptional<ZodNumber>;
      maxFailureRetries: ZodOptional<ZodNumber>;
    }, $strict>>;
    heartbeat: ZodOptional<ZodObject<{
      showOk: ZodOptional<ZodBoolean>;
      showAlerts: ZodOptional<ZodBoolean>;
      useIndicator: ZodOptional<ZodBoolean>;
    }, $strict>>;
    healthMonitor: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
    }, $strict>>;
    responsePrefix: ZodOptional<ZodString>;
  }, $strict>>>>;
  defaultAccount: ZodOptional<ZodString>;
}, $strict>;
declare const MSTeamsConfigSchema: ZodObject<{
  enabled: ZodOptional<ZodBoolean>;
  capabilities: ZodOptional<ZodArray<ZodString>>;
  dangerouslyAllowNameMatching: ZodOptional<ZodBoolean>;
  markdown: ZodOptional<ZodObject<{
    tables: ZodOptional<ZodEnum<{
      code: "code";
      off: "off";
      block: "block";
      bullets: "bullets";
    }>>;
  }, $strict>>;
  configWrites: ZodOptional<ZodBoolean>;
  appId: ZodOptional<ZodString>;
  appPassword: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
    source: ZodLiteral<"env">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"file">;
    provider: ZodString;
    id: ZodString;
  }, $strict>, ZodObject<{
    source: ZodLiteral<"exec">;
    provider: ZodString;
    id: ZodString;
  }, $strict>], "source">]>>;
  tenantId: ZodOptional<ZodString>;
  authType: ZodOptional<ZodEnum<{
    secret: "secret";
    federated: "federated";
  }>>;
  certificatePath: ZodOptional<ZodString>;
  certificateThumbprint: ZodOptional<ZodString>;
  useManagedIdentity: ZodOptional<ZodBoolean>;
  managedIdentityClientId: ZodOptional<ZodString>;
  webhook: ZodOptional<ZodObject<{
    port: ZodOptional<ZodNumber>;
    path: ZodOptional<ZodString>;
  }, $strict>>;
  dmPolicy: ZodDefault<ZodOptional<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    pairing: "pairing";
    open: "open";
  }>>>;
  allowFrom: ZodOptional<ZodArray<ZodString>>;
  defaultTo: ZodOptional<ZodString>;
  groupAllowFrom: ZodOptional<ZodArray<ZodString>>;
  groupPolicy: ZodDefault<ZodOptional<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    open: "open";
  }>>>;
  contextVisibility: ZodOptional<ZodEnum<{
    all: "all";
    allowlist: "allowlist";
    allowlist_quote: "allowlist_quote";
  }>>;
  textChunkLimit: ZodOptional<ZodNumber>;
  chunkMode: ZodOptional<ZodEnum<{
    length: "length";
    newline: "newline";
  }>>;
  streaming: ZodOptional<ZodObject<{
    mode: ZodOptional<ZodEnum<{
      off: "off";
      progress: "progress";
      partial: "partial";
      block: "block";
    }>>;
    chunkMode: ZodOptional<ZodEnum<{
      length: "length";
      newline: "newline";
    }>>;
    preview: ZodOptional<ZodObject<{
      chunk: ZodOptional<ZodObject<{
        minChars: ZodOptional<ZodNumber>;
        maxChars: ZodOptional<ZodNumber>;
        breakPreference: ZodOptional<ZodUnion<readonly [ZodLiteral<"paragraph">, ZodLiteral<"newline">, ZodLiteral<"sentence">]>>;
      }, $strict>>;
      toolProgress: ZodOptional<ZodBoolean>;
      commandText: ZodOptional<ZodEnum<{
        status: "status";
        raw: "raw";
      }>>;
    }, $strict>>;
    progress: ZodOptional<ZodObject<{
      label: ZodOptional<ZodUnion<readonly [ZodString, ZodLiteral<false>]>>;
      labels: ZodOptional<ZodArray<ZodString>>;
      maxLines: ZodOptional<ZodNumber>;
      maxLineChars: ZodOptional<ZodNumber>;
      render: ZodOptional<ZodEnum<{
        text: "text";
        rich: "rich";
      }>>;
      toolProgress: ZodOptional<ZodBoolean>;
      commandText: ZodOptional<ZodEnum<{
        status: "status";
        raw: "raw";
      }>>;
    }, $strict>>;
    block: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      coalesce: ZodOptional<ZodObject<{
        minChars: ZodOptional<ZodNumber>;
        maxChars: ZodOptional<ZodNumber>;
        idleMs: ZodOptional<ZodNumber>;
      }, $strict>>;
    }, $strict>>;
  }, $strict>>;
  typingIndicator: ZodOptional<ZodBoolean>;
  blockStreaming: ZodOptional<ZodBoolean>;
  blockStreamingCoalesce: ZodOptional<ZodObject<{
    minChars: ZodOptional<ZodNumber>;
    maxChars: ZodOptional<ZodNumber>;
    idleMs: ZodOptional<ZodNumber>;
  }, $strict>>;
  mediaAllowHosts: ZodOptional<ZodArray<ZodString>>;
  mediaAuthAllowHosts: ZodOptional<ZodArray<ZodString>>;
  requireMention: ZodOptional<ZodBoolean>;
  historyLimit: ZodOptional<ZodNumber>;
  dmHistoryLimit: ZodOptional<ZodNumber>;
  dms: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    historyLimit: ZodOptional<ZodNumber>;
  }, $strict>>>>;
  replyStyle: ZodOptional<ZodEnum<{
    thread: "thread";
    "top-level": "top-level";
  }>>;
  teams: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    requireMention: ZodOptional<ZodBoolean>;
    tools: ZodOptional<ZodObject<{
      allow: ZodOptional<ZodArray<ZodString>>;
      alsoAllow: ZodOptional<ZodArray<ZodString>>;
      deny: ZodOptional<ZodArray<ZodString>>;
    }, $strict>>;
    toolsBySender: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      allow: ZodOptional<ZodArray<ZodString>>;
      alsoAllow: ZodOptional<ZodArray<ZodString>>;
      deny: ZodOptional<ZodArray<ZodString>>;
    }, $strict>>>>;
    replyStyle: ZodOptional<ZodEnum<{
      thread: "thread";
      "top-level": "top-level";
    }>>;
    channels: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      requireMention: ZodOptional<ZodBoolean>;
      tools: ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        alsoAllow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>;
      toolsBySender: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        alsoAllow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>>>;
      replyStyle: ZodOptional<ZodEnum<{
        thread: "thread";
        "top-level": "top-level";
      }>>;
    }, $strict>>>>;
  }, $strict>>>>;
  mediaMaxMb: ZodOptional<ZodNumber>;
  sharePointSiteId: ZodOptional<ZodString>;
  heartbeat: ZodOptional<ZodObject<{
    showOk: ZodOptional<ZodBoolean>;
    showAlerts: ZodOptional<ZodBoolean>;
    useIndicator: ZodOptional<ZodBoolean>;
  }, $strict>>;
  healthMonitor: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
  }, $strict>>;
  responsePrefix: ZodOptional<ZodString>;
  welcomeCard: ZodOptional<ZodBoolean>;
  promptStarters: ZodOptional<ZodArray<ZodString>>;
  groupWelcomeCard: ZodOptional<ZodBoolean>;
  feedbackEnabled: ZodOptional<ZodBoolean>;
  feedbackReflection: ZodOptional<ZodBoolean>;
  feedbackReflectionCooldownMs: ZodOptional<ZodNumber>;
  delegatedAuth: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    scopes: ZodOptional<ZodArray<ZodString>>;
  }, $strict>>;
  sso: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
    connectionName: ZodOptional<ZodString>;
  }, $strict>>;
}, $strict>;
//#endregion
//#region src/config/zod-schema.providers-whatsapp.d.ts
declare const WhatsAppConfigSchema: ZodPreprocess<ZodObject<{
  accounts: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodPreprocess<ZodObject<{
    name: ZodOptional<ZodString>;
    enabled: ZodOptional<ZodBoolean>;
    authDir: ZodOptional<ZodString>;
    mediaMaxMb: ZodOptional<ZodNumber>;
    capabilities: ZodOptional<ZodArray<ZodString>>;
    markdown: ZodOptional<ZodObject<{
      tables: ZodOptional<ZodEnum<{
        code: "code";
        off: "off";
        block: "block";
        bullets: "bullets";
      }>>;
    }, $strict>>;
    configWrites: ZodOptional<ZodBoolean>;
    sendReadReceipts: ZodOptional<ZodBoolean>;
    messagePrefix: ZodOptional<ZodString>;
    responsePrefix: ZodOptional<ZodString>;
    dmPolicy: ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      pairing: "pairing";
      open: "open";
    }>> | ZodDefault<ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      pairing: "pairing";
      open: "open";
    }>>>;
    selfChatMode: ZodOptional<ZodBoolean>;
    allowFrom: ZodOptional<ZodArray<ZodString>>;
    defaultTo: ZodOptional<ZodString>;
    groupAllowFrom: ZodOptional<ZodArray<ZodString>>;
    groupPolicy: ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      open: "open";
    }>> | ZodDefault<ZodOptional<ZodEnum<{
      disabled: "disabled";
      allowlist: "allowlist";
      open: "open";
    }>>>;
    contextVisibility: ZodOptional<ZodEnum<{
      all: "all";
      allowlist: "allowlist";
      allowlist_quote: "allowlist_quote";
    }>>;
    historyLimit: ZodOptional<ZodNumber>;
    dmHistoryLimit: ZodOptional<ZodNumber>;
    dms: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      historyLimit: ZodOptional<ZodNumber>;
    }, $strict>>>>;
    textChunkLimit: ZodOptional<ZodNumber>;
    chunkMode: ZodOptional<ZodEnum<{
      length: "length";
      newline: "newline";
    }>>;
    blockStreaming: ZodOptional<ZodBoolean>;
    blockStreamingCoalesce: ZodOptional<ZodObject<{
      minChars: ZodOptional<ZodNumber>;
      maxChars: ZodOptional<ZodNumber>;
      idleMs: ZodOptional<ZodNumber>;
    }, $strict>>;
    groups: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      requireMention: ZodOptional<ZodBoolean>;
      tools: ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        alsoAllow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>;
      toolsBySender: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
        allow: ZodOptional<ZodArray<ZodString>>;
        alsoAllow: ZodOptional<ZodArray<ZodString>>;
        deny: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>>>;
      systemPrompt: ZodOptional<ZodString>;
    }, $strict>>>>;
    direct: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      systemPrompt: ZodOptional<ZodString>;
    }, $strict>>>>;
    ackReaction: ZodOptional<ZodObject<{
      emoji: ZodOptional<ZodString>;
      direct: ZodDefault<ZodOptional<ZodBoolean>>;
      group: ZodDefault<ZodOptional<ZodEnum<{
        always: "always";
        never: "never";
        mentions: "mentions";
      }>>>;
    }, $strict>>;
    reactionLevel: ZodOptional<ZodEnum<{
      off: "off";
      minimal: "minimal";
      extensive: "extensive";
      ack: "ack";
    }>>;
    debounceMs: ZodOptional<ZodNumber> | ZodDefault<ZodOptional<ZodNumber>>;
    replyToMode: ZodOptional<ZodUnion<readonly [ZodLiteral<"off">, ZodLiteral<"first">, ZodLiteral<"all">, ZodLiteral<"batched">]>>;
    heartbeat: ZodOptional<ZodObject<{
      showOk: ZodOptional<ZodBoolean>;
      showAlerts: ZodOptional<ZodBoolean>;
      useIndicator: ZodOptional<ZodBoolean>;
    }, $strict>>;
    healthMonitor: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
    }, $strict>>;
  }, $strict>>>>>;
  defaultAccount: ZodOptional<ZodString>;
  mediaMaxMb: ZodDefault<ZodOptional<ZodNumber>>;
  actions: ZodOptional<ZodObject<{
    reactions: ZodOptional<ZodBoolean>;
    sendMessage: ZodOptional<ZodBoolean>;
    polls: ZodOptional<ZodBoolean>;
  }, $strict>>;
  enabled: ZodOptional<ZodBoolean>;
  capabilities: ZodOptional<ZodArray<ZodString>>;
  markdown: ZodOptional<ZodObject<{
    tables: ZodOptional<ZodEnum<{
      code: "code";
      off: "off";
      block: "block";
      bullets: "bullets";
    }>>;
  }, $strict>>;
  configWrites: ZodOptional<ZodBoolean>;
  sendReadReceipts: ZodOptional<ZodBoolean>;
  messagePrefix: ZodOptional<ZodString>;
  responsePrefix: ZodOptional<ZodString>;
  dmPolicy: ZodOptional<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    pairing: "pairing";
    open: "open";
  }>> | ZodDefault<ZodOptional<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    pairing: "pairing";
    open: "open";
  }>>>;
  selfChatMode: ZodOptional<ZodBoolean>;
  allowFrom: ZodOptional<ZodArray<ZodString>>;
  defaultTo: ZodOptional<ZodString>;
  groupAllowFrom: ZodOptional<ZodArray<ZodString>>;
  groupPolicy: ZodOptional<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    open: "open";
  }>> | ZodDefault<ZodOptional<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    open: "open";
  }>>>;
  contextVisibility: ZodOptional<ZodEnum<{
    all: "all";
    allowlist: "allowlist";
    allowlist_quote: "allowlist_quote";
  }>>;
  historyLimit: ZodOptional<ZodNumber>;
  dmHistoryLimit: ZodOptional<ZodNumber>;
  dms: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    historyLimit: ZodOptional<ZodNumber>;
  }, $strict>>>>;
  textChunkLimit: ZodOptional<ZodNumber>;
  chunkMode: ZodOptional<ZodEnum<{
    length: "length";
    newline: "newline";
  }>>;
  blockStreaming: ZodOptional<ZodBoolean>;
  blockStreamingCoalesce: ZodOptional<ZodObject<{
    minChars: ZodOptional<ZodNumber>;
    maxChars: ZodOptional<ZodNumber>;
    idleMs: ZodOptional<ZodNumber>;
  }, $strict>>;
  groups: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    requireMention: ZodOptional<ZodBoolean>;
    tools: ZodOptional<ZodObject<{
      allow: ZodOptional<ZodArray<ZodString>>;
      alsoAllow: ZodOptional<ZodArray<ZodString>>;
      deny: ZodOptional<ZodArray<ZodString>>;
    }, $strict>>;
    toolsBySender: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
      allow: ZodOptional<ZodArray<ZodString>>;
      alsoAllow: ZodOptional<ZodArray<ZodString>>;
      deny: ZodOptional<ZodArray<ZodString>>;
    }, $strict>>>>;
    systemPrompt: ZodOptional<ZodString>;
  }, $strict>>>>;
  direct: ZodOptional<ZodRecord<ZodString, ZodOptional<ZodObject<{
    systemPrompt: ZodOptional<ZodString>;
  }, $strict>>>>;
  ackReaction: ZodOptional<ZodObject<{
    emoji: ZodOptional<ZodString>;
    direct: ZodDefault<ZodOptional<ZodBoolean>>;
    group: ZodDefault<ZodOptional<ZodEnum<{
      always: "always";
      never: "never";
      mentions: "mentions";
    }>>>;
  }, $strict>>;
  reactionLevel: ZodOptional<ZodEnum<{
    off: "off";
    minimal: "minimal";
    extensive: "extensive";
    ack: "ack";
  }>>;
  debounceMs: ZodOptional<ZodNumber> | ZodDefault<ZodOptional<ZodNumber>>;
  replyToMode: ZodOptional<ZodUnion<readonly [ZodLiteral<"off">, ZodLiteral<"first">, ZodLiteral<"all">, ZodLiteral<"batched">]>>;
  heartbeat: ZodOptional<ZodObject<{
    showOk: ZodOptional<ZodBoolean>;
    showAlerts: ZodOptional<ZodBoolean>;
    useIndicator: ZodOptional<ZodBoolean>;
  }, $strict>>;
  healthMonitor: ZodOptional<ZodObject<{
    enabled: ZodOptional<ZodBoolean>;
  }, $strict>>;
}, $strict>>;
//#endregion
export { MSTeamsConfigSchema as a, TelegramConfigSchema as c, IMessageConfigSchema as i, DiscordConfigSchema as n, SignalConfigSchema as o, GoogleChatConfigSchema as r, SlackConfigSchema as s, WhatsAppConfigSchema as t };