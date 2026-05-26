import * as _$typebox from "typebox";
import { Static, TSchema } from "typebox";

//#region src/gateway/protocol/version.d.ts
declare const PROTOCOL_VERSION: 4;
declare const MIN_CLIENT_PROTOCOL_VERSION: 4;
declare const MIN_PROBE_PROTOCOL_VERSION: 4;
//#endregion
//#region src/gateway/protocol/schema/protocol-schemas.d.ts
declare const ProtocolSchemas: {
  ConnectParams: _$typebox.TObject<{
    minProtocol: _$typebox.TInteger;
    maxProtocol: _$typebox.TInteger;
    client: _$typebox.TObject<{
      id: _$typebox.TEnum<["webchat-ui", "openclaw-control-ui", "openclaw-tui", "webchat", "cli", "gateway-client", "openclaw-macos", "openclaw-ios", "openclaw-android", "node-host", "test", "fingerprint", "openclaw-probe"]>;
      displayName: _$typebox.TOptional<_$typebox.TString>;
      version: _$typebox.TString;
      platform: _$typebox.TString;
      deviceFamily: _$typebox.TOptional<_$typebox.TString>;
      modelIdentifier: _$typebox.TOptional<_$typebox.TString>;
      mode: _$typebox.TEnum<["webchat", "cli", "test", "probe", "ui", "backend", "node"]>;
      instanceId: _$typebox.TOptional<_$typebox.TString>;
    }>;
    caps: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    commands: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    permissions: _$typebox.TOptional<_$typebox.TRecord<"^.*$", _$typebox.TBoolean>>;
    pathEnv: _$typebox.TOptional<_$typebox.TString>;
    role: _$typebox.TOptional<_$typebox.TString>;
    scopes: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    device: _$typebox.TOptional<_$typebox.TObject<{
      id: _$typebox.TString;
      publicKey: _$typebox.TString;
      signature: _$typebox.TString;
      signedAt: _$typebox.TInteger;
      nonce: _$typebox.TString;
    }>>;
    auth: _$typebox.TOptional<_$typebox.TObject<{
      token: _$typebox.TOptional<_$typebox.TString>;
      bootstrapToken: _$typebox.TOptional<_$typebox.TString>;
      deviceToken: _$typebox.TOptional<_$typebox.TString>;
      password: _$typebox.TOptional<_$typebox.TString>;
    }>>;
    locale: _$typebox.TOptional<_$typebox.TString>;
    userAgent: _$typebox.TOptional<_$typebox.TString>;
  }>;
  HelloOk: _$typebox.TObject<{
    type: _$typebox.TLiteral<"hello-ok">;
    protocol: _$typebox.TInteger;
    server: _$typebox.TObject<{
      version: _$typebox.TString;
      connId: _$typebox.TString;
    }>;
    features: _$typebox.TObject<{
      methods: _$typebox.TArray<_$typebox.TString>;
      events: _$typebox.TArray<_$typebox.TString>;
    }>;
    snapshot: _$typebox.TObject<{
      presence: _$typebox.TArray<_$typebox.TObject<{
        host: _$typebox.TOptional<_$typebox.TString>;
        ip: _$typebox.TOptional<_$typebox.TString>;
        version: _$typebox.TOptional<_$typebox.TString>;
        platform: _$typebox.TOptional<_$typebox.TString>;
        deviceFamily: _$typebox.TOptional<_$typebox.TString>;
        modelIdentifier: _$typebox.TOptional<_$typebox.TString>;
        mode: _$typebox.TOptional<_$typebox.TString>;
        lastInputSeconds: _$typebox.TOptional<_$typebox.TInteger>;
        reason: _$typebox.TOptional<_$typebox.TString>;
        tags: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
        text: _$typebox.TOptional<_$typebox.TString>;
        ts: _$typebox.TInteger;
        deviceId: _$typebox.TOptional<_$typebox.TString>;
        roles: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
        scopes: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
        instanceId: _$typebox.TOptional<_$typebox.TString>;
      }>>;
      health: _$typebox.TAny;
      stateVersion: _$typebox.TObject<{
        presence: _$typebox.TInteger;
        health: _$typebox.TInteger;
      }>;
      uptimeMs: _$typebox.TInteger;
      configPath: _$typebox.TOptional<_$typebox.TString>;
      stateDir: _$typebox.TOptional<_$typebox.TString>;
      sessionDefaults: _$typebox.TOptional<_$typebox.TObject<{
        defaultAgentId: _$typebox.TString;
        mainKey: _$typebox.TString;
        mainSessionKey: _$typebox.TString;
        scope: _$typebox.TOptional<_$typebox.TString>;
      }>>;
      authMode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"none">, _$typebox.TLiteral<"token">, _$typebox.TLiteral<"password">, _$typebox.TLiteral<"trusted-proxy">]>>;
      updateAvailable: _$typebox.TOptional<_$typebox.TObject<{
        currentVersion: _$typebox.TString;
        latestVersion: _$typebox.TString;
        channel: _$typebox.TString;
      }>>;
    }>;
    pluginSurfaceUrls: _$typebox.TOptional<_$typebox.TRecord<"^.*$", _$typebox.TString>>;
    auth: _$typebox.TObject<{
      deviceToken: _$typebox.TOptional<_$typebox.TString>;
      role: _$typebox.TString;
      scopes: _$typebox.TArray<_$typebox.TString>;
      issuedAtMs: _$typebox.TOptional<_$typebox.TInteger>;
      deviceTokens: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
        deviceToken: _$typebox.TString;
        role: _$typebox.TString;
        scopes: _$typebox.TArray<_$typebox.TString>;
        issuedAtMs: _$typebox.TInteger;
      }>>>;
    }>;
    policy: _$typebox.TObject<{
      maxPayload: _$typebox.TInteger;
      maxBufferedBytes: _$typebox.TInteger;
      tickIntervalMs: _$typebox.TInteger;
    }>;
  }>;
  RequestFrame: _$typebox.TObject<{
    type: _$typebox.TLiteral<"req">;
    id: _$typebox.TString;
    method: _$typebox.TString;
    params: _$typebox.TOptional<_$typebox.TUnknown>;
  }>;
  ResponseFrame: _$typebox.TObject<{
    type: _$typebox.TLiteral<"res">;
    id: _$typebox.TString;
    ok: _$typebox.TBoolean;
    payload: _$typebox.TOptional<_$typebox.TUnknown>;
    error: _$typebox.TOptional<_$typebox.TObject<{
      code: _$typebox.TString;
      message: _$typebox.TString;
      details: _$typebox.TOptional<_$typebox.TUnknown>;
      retryable: _$typebox.TOptional<_$typebox.TBoolean>;
      retryAfterMs: _$typebox.TOptional<_$typebox.TInteger>;
    }>>;
  }>;
  EventFrame: _$typebox.TObject<{
    type: _$typebox.TLiteral<"event">;
    event: _$typebox.TString;
    payload: _$typebox.TOptional<_$typebox.TUnknown>;
    seq: _$typebox.TOptional<_$typebox.TInteger>;
    stateVersion: _$typebox.TOptional<_$typebox.TObject<{
      presence: _$typebox.TInteger;
      health: _$typebox.TInteger;
    }>>;
  }>;
  GatewayFrame: _$typebox.TUnion<[_$typebox.TObject<{
    type: _$typebox.TLiteral<"req">;
    id: _$typebox.TString;
    method: _$typebox.TString;
    params: _$typebox.TOptional<_$typebox.TUnknown>;
  }>, _$typebox.TObject<{
    type: _$typebox.TLiteral<"res">;
    id: _$typebox.TString;
    ok: _$typebox.TBoolean;
    payload: _$typebox.TOptional<_$typebox.TUnknown>;
    error: _$typebox.TOptional<_$typebox.TObject<{
      code: _$typebox.TString;
      message: _$typebox.TString;
      details: _$typebox.TOptional<_$typebox.TUnknown>;
      retryable: _$typebox.TOptional<_$typebox.TBoolean>;
      retryAfterMs: _$typebox.TOptional<_$typebox.TInteger>;
    }>>;
  }>, _$typebox.TObject<{
    type: _$typebox.TLiteral<"event">;
    event: _$typebox.TString;
    payload: _$typebox.TOptional<_$typebox.TUnknown>;
    seq: _$typebox.TOptional<_$typebox.TInteger>;
    stateVersion: _$typebox.TOptional<_$typebox.TObject<{
      presence: _$typebox.TInteger;
      health: _$typebox.TInteger;
    }>>;
  }>]>;
  PresenceEntry: _$typebox.TObject<{
    host: _$typebox.TOptional<_$typebox.TString>;
    ip: _$typebox.TOptional<_$typebox.TString>;
    version: _$typebox.TOptional<_$typebox.TString>;
    platform: _$typebox.TOptional<_$typebox.TString>;
    deviceFamily: _$typebox.TOptional<_$typebox.TString>;
    modelIdentifier: _$typebox.TOptional<_$typebox.TString>;
    mode: _$typebox.TOptional<_$typebox.TString>;
    lastInputSeconds: _$typebox.TOptional<_$typebox.TInteger>;
    reason: _$typebox.TOptional<_$typebox.TString>;
    tags: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    text: _$typebox.TOptional<_$typebox.TString>;
    ts: _$typebox.TInteger;
    deviceId: _$typebox.TOptional<_$typebox.TString>;
    roles: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    scopes: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    instanceId: _$typebox.TOptional<_$typebox.TString>;
  }>;
  StateVersion: _$typebox.TObject<{
    presence: _$typebox.TInteger;
    health: _$typebox.TInteger;
  }>;
  Snapshot: _$typebox.TObject<{
    presence: _$typebox.TArray<_$typebox.TObject<{
      host: _$typebox.TOptional<_$typebox.TString>;
      ip: _$typebox.TOptional<_$typebox.TString>;
      version: _$typebox.TOptional<_$typebox.TString>;
      platform: _$typebox.TOptional<_$typebox.TString>;
      deviceFamily: _$typebox.TOptional<_$typebox.TString>;
      modelIdentifier: _$typebox.TOptional<_$typebox.TString>;
      mode: _$typebox.TOptional<_$typebox.TString>;
      lastInputSeconds: _$typebox.TOptional<_$typebox.TInteger>;
      reason: _$typebox.TOptional<_$typebox.TString>;
      tags: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
      text: _$typebox.TOptional<_$typebox.TString>;
      ts: _$typebox.TInteger;
      deviceId: _$typebox.TOptional<_$typebox.TString>;
      roles: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
      scopes: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
      instanceId: _$typebox.TOptional<_$typebox.TString>;
    }>>;
    health: _$typebox.TAny;
    stateVersion: _$typebox.TObject<{
      presence: _$typebox.TInteger;
      health: _$typebox.TInteger;
    }>;
    uptimeMs: _$typebox.TInteger;
    configPath: _$typebox.TOptional<_$typebox.TString>;
    stateDir: _$typebox.TOptional<_$typebox.TString>;
    sessionDefaults: _$typebox.TOptional<_$typebox.TObject<{
      defaultAgentId: _$typebox.TString;
      mainKey: _$typebox.TString;
      mainSessionKey: _$typebox.TString;
      scope: _$typebox.TOptional<_$typebox.TString>;
    }>>;
    authMode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"none">, _$typebox.TLiteral<"token">, _$typebox.TLiteral<"password">, _$typebox.TLiteral<"trusted-proxy">]>>;
    updateAvailable: _$typebox.TOptional<_$typebox.TObject<{
      currentVersion: _$typebox.TString;
      latestVersion: _$typebox.TString;
      channel: _$typebox.TString;
    }>>;
  }>;
  ErrorShape: _$typebox.TObject<{
    code: _$typebox.TString;
    message: _$typebox.TString;
    details: _$typebox.TOptional<_$typebox.TUnknown>;
    retryable: _$typebox.TOptional<_$typebox.TBoolean>;
    retryAfterMs: _$typebox.TOptional<_$typebox.TInteger>;
  }>;
  EnvironmentStatus: _$typebox.TString;
  EnvironmentSummary: _$typebox.TObject<{
    id: _$typebox.TString;
    type: _$typebox.TString;
    label: _$typebox.TOptional<_$typebox.TString>;
    status: _$typebox.TString;
    capabilities: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
  }>;
  EnvironmentsListParams: _$typebox.TObject<{}>;
  EnvironmentsListResult: _$typebox.TObject<{
    environments: _$typebox.TArray<_$typebox.TObject<{
      id: _$typebox.TString;
      type: _$typebox.TString;
      label: _$typebox.TOptional<_$typebox.TString>;
      status: _$typebox.TString;
      capabilities: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    }>>;
  }>;
  EnvironmentsStatusParams: _$typebox.TObject<{
    environmentId: _$typebox.TString;
  }>;
  EnvironmentsStatusResult: _$typebox.TObject<{
    id: _$typebox.TString;
    type: _$typebox.TString;
    label: _$typebox.TOptional<_$typebox.TString>;
    status: _$typebox.TString;
    capabilities: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
  }>;
  AgentEvent: _$typebox.TObject<{
    runId: _$typebox.TString;
    seq: _$typebox.TInteger;
    stream: _$typebox.TString;
    ts: _$typebox.TInteger;
    spawnedBy: _$typebox.TOptional<_$typebox.TString>;
    data: _$typebox.TRecord<"^.*$", _$typebox.TUnknown>;
  }>;
  MessageActionParams: _$typebox.TObject<{
    channel: _$typebox.TString;
    action: _$typebox.TString;
    params: _$typebox.TRecord<"^.*$", _$typebox.TUnknown>;
    accountId: _$typebox.TOptional<_$typebox.TString>;
    requesterSenderId: _$typebox.TOptional<_$typebox.TString>;
    senderIsOwner: _$typebox.TOptional<_$typebox.TBoolean>;
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    sessionId: _$typebox.TOptional<_$typebox.TString>;
    agentId: _$typebox.TOptional<_$typebox.TString>;
    toolContext: _$typebox.TOptional<_$typebox.TObject<{
      currentChannelId: _$typebox.TOptional<_$typebox.TString>;
      currentGraphChannelId: _$typebox.TOptional<_$typebox.TString>;
      currentChannelProvider: _$typebox.TOptional<_$typebox.TString>;
      currentThreadTs: _$typebox.TOptional<_$typebox.TString>;
      currentMessageId: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNumber]>>;
      replyToMode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"off">, _$typebox.TLiteral<"first">, _$typebox.TLiteral<"all">, _$typebox.TLiteral<"batched">]>>;
      hasRepliedRef: _$typebox.TOptional<_$typebox.TObject<{
        value: _$typebox.TBoolean;
      }>>;
      skipCrossContextDecoration: _$typebox.TOptional<_$typebox.TBoolean>;
    }>>;
    idempotencyKey: _$typebox.TString;
  }>;
  SendParams: _$typebox.TObject<{
    to: _$typebox.TString;
    message: _$typebox.TOptional<_$typebox.TString>;
    mediaUrl: _$typebox.TOptional<_$typebox.TString>;
    mediaUrls: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    asVoice: _$typebox.TOptional<_$typebox.TBoolean>;
    gifPlayback: _$typebox.TOptional<_$typebox.TBoolean>;
    channel: _$typebox.TOptional<_$typebox.TString>;
    accountId: _$typebox.TOptional<_$typebox.TString>;
    agentId: _$typebox.TOptional<_$typebox.TString>;
    replyToId: _$typebox.TOptional<_$typebox.TString>;
    threadId: _$typebox.TOptional<_$typebox.TString>;
    forceDocument: _$typebox.TOptional<_$typebox.TBoolean>;
    silent: _$typebox.TOptional<_$typebox.TBoolean>;
    parseMode: _$typebox.TOptional<_$typebox.TLiteral<"HTML">>;
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    idempotencyKey: _$typebox.TString;
  }>;
  PollParams: _$typebox.TObject<{
    to: _$typebox.TString;
    question: _$typebox.TString;
    options: _$typebox.TArray<_$typebox.TString>;
    maxSelections: _$typebox.TOptional<_$typebox.TInteger>;
    durationSeconds: _$typebox.TOptional<_$typebox.TInteger>;
    durationHours: _$typebox.TOptional<_$typebox.TInteger>;
    silent: _$typebox.TOptional<_$typebox.TBoolean>;
    isAnonymous: _$typebox.TOptional<_$typebox.TBoolean>;
    threadId: _$typebox.TOptional<_$typebox.TString>;
    channel: _$typebox.TOptional<_$typebox.TString>;
    accountId: _$typebox.TOptional<_$typebox.TString>;
    idempotencyKey: _$typebox.TString;
  }>;
  AgentParams: _$typebox.TObject<{
    message: _$typebox.TString;
    agentId: _$typebox.TOptional<_$typebox.TString>;
    provider: _$typebox.TOptional<_$typebox.TString>;
    model: _$typebox.TOptional<_$typebox.TString>;
    to: _$typebox.TOptional<_$typebox.TString>;
    replyTo: _$typebox.TOptional<_$typebox.TString>;
    sessionId: _$typebox.TOptional<_$typebox.TString>;
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    thinking: _$typebox.TOptional<_$typebox.TString>;
    deliver: _$typebox.TOptional<_$typebox.TBoolean>;
    attachments: _$typebox.TOptional<_$typebox.TArray<_$typebox.TUnknown>>;
    channel: _$typebox.TOptional<_$typebox.TString>;
    replyChannel: _$typebox.TOptional<_$typebox.TString>;
    accountId: _$typebox.TOptional<_$typebox.TString>;
    replyAccountId: _$typebox.TOptional<_$typebox.TString>;
    threadId: _$typebox.TOptional<_$typebox.TString>;
    groupId: _$typebox.TOptional<_$typebox.TString>;
    groupChannel: _$typebox.TOptional<_$typebox.TString>;
    groupSpace: _$typebox.TOptional<_$typebox.TString>;
    timeout: _$typebox.TOptional<_$typebox.TInteger>;
    bestEffortDeliver: _$typebox.TOptional<_$typebox.TBoolean>;
    lane: _$typebox.TOptional<_$typebox.TString>;
    cleanupBundleMcpOnRunEnd: _$typebox.TOptional<_$typebox.TBoolean>;
    modelRun: _$typebox.TOptional<_$typebox.TBoolean>;
    promptMode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"full">, _$typebox.TLiteral<"minimal">, _$typebox.TLiteral<"none">]>>;
    extraSystemPrompt: _$typebox.TOptional<_$typebox.TString>;
    bootstrapContextMode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"full">, _$typebox.TLiteral<"lightweight">]>>;
    bootstrapContextRunKind: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"default">, _$typebox.TLiteral<"heartbeat">, _$typebox.TLiteral<"cron">]>>;
    acpTurnSource: _$typebox.TOptional<_$typebox.TLiteral<"manual_spawn">>;
    internalRuntimeHandoffId: _$typebox.TOptional<_$typebox.TString>;
    internalEvents: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
      type: _$typebox.TLiteral<"task_completion">;
      source: _$typebox.TString;
      childSessionKey: _$typebox.TString;
      childSessionId: _$typebox.TOptional<_$typebox.TString>;
      announceType: _$typebox.TString;
      taskLabel: _$typebox.TString;
      status: _$typebox.TString;
      statusLabel: _$typebox.TString;
      result: _$typebox.TString;
      mediaUrls: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
      statsLine: _$typebox.TOptional<_$typebox.TString>;
      replyInstruction: _$typebox.TString;
    }>>>;
    inputProvenance: _$typebox.TOptional<_$typebox.TObject<{
      kind: _$typebox.TString;
      originSessionId: _$typebox.TOptional<_$typebox.TString>;
      sourceSessionKey: _$typebox.TOptional<_$typebox.TString>;
      sourceChannel: _$typebox.TOptional<_$typebox.TString>;
      sourceTool: _$typebox.TOptional<_$typebox.TString>;
    }>>;
    voiceWakeTrigger: _$typebox.TOptional<_$typebox.TString>;
    idempotencyKey: _$typebox.TString;
    label: _$typebox.TOptional<_$typebox.TString>;
  }>;
  AgentIdentityParams: _$typebox.TObject<{
    agentId: _$typebox.TOptional<_$typebox.TString>;
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
  }>;
  AgentIdentityResult: _$typebox.TObject<{
    agentId: _$typebox.TString;
    name: _$typebox.TOptional<_$typebox.TString>;
    avatar: _$typebox.TOptional<_$typebox.TString>;
    avatarSource: _$typebox.TOptional<_$typebox.TString>;
    avatarStatus: _$typebox.TOptional<_$typebox.TString>;
    avatarReason: _$typebox.TOptional<_$typebox.TString>;
    emoji: _$typebox.TOptional<_$typebox.TString>;
  }>;
  AgentWaitParams: _$typebox.TObject<{
    runId: _$typebox.TString;
    timeoutMs: _$typebox.TOptional<_$typebox.TInteger>;
  }>;
  WakeParams: _$typebox.TObject<{
    mode: _$typebox.TUnion<[_$typebox.TLiteral<"now">, _$typebox.TLiteral<"next-heartbeat">]>;
    text: _$typebox.TString;
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
  }>;
  NodePairRequestParams: _$typebox.TObject<{
    nodeId: _$typebox.TString;
    displayName: _$typebox.TOptional<_$typebox.TString>;
    platform: _$typebox.TOptional<_$typebox.TString>;
    version: _$typebox.TOptional<_$typebox.TString>;
    coreVersion: _$typebox.TOptional<_$typebox.TString>;
    uiVersion: _$typebox.TOptional<_$typebox.TString>;
    deviceFamily: _$typebox.TOptional<_$typebox.TString>;
    modelIdentifier: _$typebox.TOptional<_$typebox.TString>;
    caps: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    commands: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    remoteIp: _$typebox.TOptional<_$typebox.TString>;
    silent: _$typebox.TOptional<_$typebox.TBoolean>;
  }>;
  NodePairListParams: _$typebox.TObject<{}>;
  NodePairApproveParams: _$typebox.TObject<{
    requestId: _$typebox.TString;
  }>;
  NodePairRejectParams: _$typebox.TObject<{
    requestId: _$typebox.TString;
  }>;
  NodePairRemoveParams: _$typebox.TObject<{
    nodeId: _$typebox.TString;
  }>;
  NodePairVerifyParams: _$typebox.TObject<{
    nodeId: _$typebox.TString;
    token: _$typebox.TString;
  }>;
  NodeRenameParams: _$typebox.TObject<{
    nodeId: _$typebox.TString;
    displayName: _$typebox.TString;
  }>;
  NodeListParams: _$typebox.TObject<{}>;
  NodePendingAckParams: _$typebox.TObject<{
    ids: _$typebox.TArray<_$typebox.TString>;
  }>;
  NodeDescribeParams: _$typebox.TObject<{
    nodeId: _$typebox.TString;
  }>;
  NodeInvokeParams: _$typebox.TObject<{
    nodeId: _$typebox.TString;
    command: _$typebox.TString;
    params: _$typebox.TOptional<_$typebox.TUnknown>;
    timeoutMs: _$typebox.TOptional<_$typebox.TInteger>;
    idempotencyKey: _$typebox.TString;
  }>;
  NodeInvokeResultParams: _$typebox.TObject<{
    id: _$typebox.TString;
    nodeId: _$typebox.TString;
    ok: _$typebox.TBoolean;
    payload: _$typebox.TOptional<_$typebox.TUnknown>;
    payloadJSON: _$typebox.TOptional<_$typebox.TString>;
    error: _$typebox.TOptional<_$typebox.TObject<{
      code: _$typebox.TOptional<_$typebox.TString>;
      message: _$typebox.TOptional<_$typebox.TString>;
    }>>;
  }>;
  NodeEventParams: _$typebox.TObject<{
    event: _$typebox.TString;
    payload: _$typebox.TOptional<_$typebox.TUnknown>;
    payloadJSON: _$typebox.TOptional<_$typebox.TString>;
  }>;
  NodeEventResult: _$typebox.TObject<{
    ok: _$typebox.TBoolean;
    event: _$typebox.TString;
    handled: _$typebox.TBoolean;
    reason: _$typebox.TOptional<_$typebox.TString>;
  }>;
  NodePresenceAlivePayload: _$typebox.TObject<{
    trigger: _$typebox.TString;
    sentAtMs: _$typebox.TOptional<_$typebox.TInteger>;
    displayName: _$typebox.TOptional<_$typebox.TString>;
    version: _$typebox.TOptional<_$typebox.TString>;
    platform: _$typebox.TOptional<_$typebox.TString>;
    deviceFamily: _$typebox.TOptional<_$typebox.TString>;
    modelIdentifier: _$typebox.TOptional<_$typebox.TString>;
    pushTransport: _$typebox.TOptional<_$typebox.TString>;
  }>;
  NodePresenceAliveReason: _$typebox.TString;
  NodePendingDrainParams: _$typebox.TObject<{
    maxItems: _$typebox.TOptional<_$typebox.TInteger>;
  }>;
  NodePendingDrainResult: _$typebox.TObject<{
    nodeId: _$typebox.TString;
    revision: _$typebox.TInteger;
    items: _$typebox.TArray<_$typebox.TObject<{
      id: _$typebox.TString;
      type: _$typebox.TString;
      priority: _$typebox.TString;
      createdAtMs: _$typebox.TInteger;
      expiresAtMs: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TInteger, _$typebox.TNull]>>;
      payload: _$typebox.TOptional<_$typebox.TRecord<"^.*$", _$typebox.TUnknown>>;
    }>>;
    hasMore: _$typebox.TBoolean;
  }>;
  NodePendingEnqueueParams: _$typebox.TObject<{
    nodeId: _$typebox.TString;
    type: _$typebox.TString;
    priority: _$typebox.TOptional<_$typebox.TString>;
    expiresInMs: _$typebox.TOptional<_$typebox.TInteger>;
    wake: _$typebox.TOptional<_$typebox.TBoolean>;
  }>;
  NodePendingEnqueueResult: _$typebox.TObject<{
    nodeId: _$typebox.TString;
    revision: _$typebox.TInteger;
    queued: _$typebox.TObject<{
      id: _$typebox.TString;
      type: _$typebox.TString;
      priority: _$typebox.TString;
      createdAtMs: _$typebox.TInteger;
      expiresAtMs: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TInteger, _$typebox.TNull]>>;
      payload: _$typebox.TOptional<_$typebox.TRecord<"^.*$", _$typebox.TUnknown>>;
    }>;
    wakeTriggered: _$typebox.TBoolean;
  }>;
  NodeInvokeRequestEvent: _$typebox.TObject<{
    id: _$typebox.TString;
    nodeId: _$typebox.TString;
    command: _$typebox.TString;
    paramsJSON: _$typebox.TOptional<_$typebox.TString>;
    timeoutMs: _$typebox.TOptional<_$typebox.TInteger>;
    idempotencyKey: _$typebox.TOptional<_$typebox.TString>;
  }>;
  PushTestParams: _$typebox.TObject<{
    nodeId: _$typebox.TString;
    title: _$typebox.TOptional<_$typebox.TString>;
    body: _$typebox.TOptional<_$typebox.TString>;
    environment: _$typebox.TOptional<_$typebox.TString>;
  }>;
  PushTestResult: _$typebox.TObject<{
    ok: _$typebox.TBoolean;
    status: _$typebox.TInteger;
    apnsId: _$typebox.TOptional<_$typebox.TString>;
    reason: _$typebox.TOptional<_$typebox.TString>;
    tokenSuffix: _$typebox.TString;
    topic: _$typebox.TString;
    environment: _$typebox.TString;
    transport: _$typebox.TString;
  }>;
  SecretsReloadParams: _$typebox.TObject<{}>;
  SecretsResolveParams: _$typebox.TObject<{
    commandName: _$typebox.TString;
    targetIds: _$typebox.TArray<_$typebox.TString>;
  }>;
  SecretsResolveAssignment: _$typebox.TObject<{
    path: _$typebox.TOptional<_$typebox.TString>;
    pathSegments: _$typebox.TArray<_$typebox.TString>;
    value: _$typebox.TUnknown;
  }>;
  SecretsResolveResult: _$typebox.TObject<{
    ok: _$typebox.TOptional<_$typebox.TBoolean>;
    assignments: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
      path: _$typebox.TOptional<_$typebox.TString>;
      pathSegments: _$typebox.TArray<_$typebox.TString>;
      value: _$typebox.TUnknown;
    }>>>;
    diagnostics: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    inactiveRefPaths: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
  }>;
  SessionsListParams: _$typebox.TObject<{
    limit: _$typebox.TOptional<_$typebox.TInteger>;
    activeMinutes: _$typebox.TOptional<_$typebox.TInteger>;
    includeGlobal: _$typebox.TOptional<_$typebox.TBoolean>;
    includeUnknown: _$typebox.TOptional<_$typebox.TBoolean>;
    configuredAgentsOnly: _$typebox.TOptional<_$typebox.TBoolean>;
    includeDerivedTitles: _$typebox.TOptional<_$typebox.TBoolean>;
    includeLastMessage: _$typebox.TOptional<_$typebox.TBoolean>;
    label: _$typebox.TOptional<_$typebox.TString>;
    spawnedBy: _$typebox.TOptional<_$typebox.TString>;
    agentId: _$typebox.TOptional<_$typebox.TString>;
    search: _$typebox.TOptional<_$typebox.TString>;
  }>;
  SessionsCleanupParams: _$typebox.TObject<{
    agent: _$typebox.TOptional<_$typebox.TString>;
    allAgents: _$typebox.TOptional<_$typebox.TBoolean>;
    enforce: _$typebox.TOptional<_$typebox.TBoolean>;
    activeKey: _$typebox.TOptional<_$typebox.TString>;
    fixMissing: _$typebox.TOptional<_$typebox.TBoolean>;
    fixDmScope: _$typebox.TOptional<_$typebox.TBoolean>;
  }>;
  SessionsPreviewParams: _$typebox.TObject<{
    keys: _$typebox.TArray<_$typebox.TString>;
    limit: _$typebox.TOptional<_$typebox.TInteger>;
    maxChars: _$typebox.TOptional<_$typebox.TInteger>;
  }>;
  SessionsDescribeParams: _$typebox.TObject<{
    key: _$typebox.TString;
    includeDerivedTitles: _$typebox.TOptional<_$typebox.TBoolean>;
    includeLastMessage: _$typebox.TOptional<_$typebox.TBoolean>;
  }>;
  SessionsResolveParams: _$typebox.TObject<{
    key: _$typebox.TOptional<_$typebox.TString>;
    sessionId: _$typebox.TOptional<_$typebox.TString>;
    label: _$typebox.TOptional<_$typebox.TString>;
    agentId: _$typebox.TOptional<_$typebox.TString>;
    spawnedBy: _$typebox.TOptional<_$typebox.TString>;
    includeGlobal: _$typebox.TOptional<_$typebox.TBoolean>;
    includeUnknown: _$typebox.TOptional<_$typebox.TBoolean>;
  }>;
  SessionCompactionCheckpoint: _$typebox.TObject<{
    checkpointId: _$typebox.TString;
    sessionKey: _$typebox.TString;
    sessionId: _$typebox.TString;
    createdAt: _$typebox.TInteger;
    reason: _$typebox.TUnion<[_$typebox.TLiteral<"manual">, _$typebox.TLiteral<"auto-threshold">, _$typebox.TLiteral<"overflow-retry">, _$typebox.TLiteral<"timeout-retry">]>;
    tokensBefore: _$typebox.TOptional<_$typebox.TInteger>;
    tokensAfter: _$typebox.TOptional<_$typebox.TInteger>;
    summary: _$typebox.TOptional<_$typebox.TString>;
    firstKeptEntryId: _$typebox.TOptional<_$typebox.TString>;
    preCompaction: _$typebox.TObject<{
      sessionId: _$typebox.TString;
      sessionFile: _$typebox.TOptional<_$typebox.TString>;
      leafId: _$typebox.TOptional<_$typebox.TString>;
      entryId: _$typebox.TOptional<_$typebox.TString>;
    }>;
    postCompaction: _$typebox.TObject<{
      sessionId: _$typebox.TString;
      sessionFile: _$typebox.TOptional<_$typebox.TString>;
      leafId: _$typebox.TOptional<_$typebox.TString>;
      entryId: _$typebox.TOptional<_$typebox.TString>;
    }>;
  }>;
  SessionsCompactionListParams: _$typebox.TObject<{
    key: _$typebox.TString;
  }>;
  SessionsCompactionGetParams: _$typebox.TObject<{
    key: _$typebox.TString;
    checkpointId: _$typebox.TString;
  }>;
  SessionsCompactionBranchParams: _$typebox.TObject<{
    key: _$typebox.TString;
    checkpointId: _$typebox.TString;
  }>;
  SessionsCompactionRestoreParams: _$typebox.TObject<{
    key: _$typebox.TString;
    checkpointId: _$typebox.TString;
  }>;
  SessionsCompactionListResult: _$typebox.TObject<{
    ok: _$typebox.TLiteral<true>;
    key: _$typebox.TString;
    checkpoints: _$typebox.TArray<_$typebox.TObject<{
      checkpointId: _$typebox.TString;
      sessionKey: _$typebox.TString;
      sessionId: _$typebox.TString;
      createdAt: _$typebox.TInteger;
      reason: _$typebox.TUnion<[_$typebox.TLiteral<"manual">, _$typebox.TLiteral<"auto-threshold">, _$typebox.TLiteral<"overflow-retry">, _$typebox.TLiteral<"timeout-retry">]>;
      tokensBefore: _$typebox.TOptional<_$typebox.TInteger>;
      tokensAfter: _$typebox.TOptional<_$typebox.TInteger>;
      summary: _$typebox.TOptional<_$typebox.TString>;
      firstKeptEntryId: _$typebox.TOptional<_$typebox.TString>;
      preCompaction: _$typebox.TObject<{
        sessionId: _$typebox.TString;
        sessionFile: _$typebox.TOptional<_$typebox.TString>;
        leafId: _$typebox.TOptional<_$typebox.TString>;
        entryId: _$typebox.TOptional<_$typebox.TString>;
      }>;
      postCompaction: _$typebox.TObject<{
        sessionId: _$typebox.TString;
        sessionFile: _$typebox.TOptional<_$typebox.TString>;
        leafId: _$typebox.TOptional<_$typebox.TString>;
        entryId: _$typebox.TOptional<_$typebox.TString>;
      }>;
    }>>;
  }>;
  SessionsCompactionGetResult: _$typebox.TObject<{
    ok: _$typebox.TLiteral<true>;
    key: _$typebox.TString;
    checkpoint: _$typebox.TObject<{
      checkpointId: _$typebox.TString;
      sessionKey: _$typebox.TString;
      sessionId: _$typebox.TString;
      createdAt: _$typebox.TInteger;
      reason: _$typebox.TUnion<[_$typebox.TLiteral<"manual">, _$typebox.TLiteral<"auto-threshold">, _$typebox.TLiteral<"overflow-retry">, _$typebox.TLiteral<"timeout-retry">]>;
      tokensBefore: _$typebox.TOptional<_$typebox.TInteger>;
      tokensAfter: _$typebox.TOptional<_$typebox.TInteger>;
      summary: _$typebox.TOptional<_$typebox.TString>;
      firstKeptEntryId: _$typebox.TOptional<_$typebox.TString>;
      preCompaction: _$typebox.TObject<{
        sessionId: _$typebox.TString;
        sessionFile: _$typebox.TOptional<_$typebox.TString>;
        leafId: _$typebox.TOptional<_$typebox.TString>;
        entryId: _$typebox.TOptional<_$typebox.TString>;
      }>;
      postCompaction: _$typebox.TObject<{
        sessionId: _$typebox.TString;
        sessionFile: _$typebox.TOptional<_$typebox.TString>;
        leafId: _$typebox.TOptional<_$typebox.TString>;
        entryId: _$typebox.TOptional<_$typebox.TString>;
      }>;
    }>;
  }>;
  SessionsCompactionBranchResult: _$typebox.TObject<{
    ok: _$typebox.TLiteral<true>;
    sourceKey: _$typebox.TString;
    key: _$typebox.TString;
    sessionId: _$typebox.TString;
    checkpoint: _$typebox.TObject<{
      checkpointId: _$typebox.TString;
      sessionKey: _$typebox.TString;
      sessionId: _$typebox.TString;
      createdAt: _$typebox.TInteger;
      reason: _$typebox.TUnion<[_$typebox.TLiteral<"manual">, _$typebox.TLiteral<"auto-threshold">, _$typebox.TLiteral<"overflow-retry">, _$typebox.TLiteral<"timeout-retry">]>;
      tokensBefore: _$typebox.TOptional<_$typebox.TInteger>;
      tokensAfter: _$typebox.TOptional<_$typebox.TInteger>;
      summary: _$typebox.TOptional<_$typebox.TString>;
      firstKeptEntryId: _$typebox.TOptional<_$typebox.TString>;
      preCompaction: _$typebox.TObject<{
        sessionId: _$typebox.TString;
        sessionFile: _$typebox.TOptional<_$typebox.TString>;
        leafId: _$typebox.TOptional<_$typebox.TString>;
        entryId: _$typebox.TOptional<_$typebox.TString>;
      }>;
      postCompaction: _$typebox.TObject<{
        sessionId: _$typebox.TString;
        sessionFile: _$typebox.TOptional<_$typebox.TString>;
        leafId: _$typebox.TOptional<_$typebox.TString>;
        entryId: _$typebox.TOptional<_$typebox.TString>;
      }>;
    }>;
    entry: _$typebox.TObject<{
      sessionId: _$typebox.TString;
      updatedAt: _$typebox.TInteger;
    }>;
  }>;
  SessionsCompactionRestoreResult: _$typebox.TObject<{
    ok: _$typebox.TLiteral<true>;
    key: _$typebox.TString;
    sessionId: _$typebox.TString;
    checkpoint: _$typebox.TObject<{
      checkpointId: _$typebox.TString;
      sessionKey: _$typebox.TString;
      sessionId: _$typebox.TString;
      createdAt: _$typebox.TInteger;
      reason: _$typebox.TUnion<[_$typebox.TLiteral<"manual">, _$typebox.TLiteral<"auto-threshold">, _$typebox.TLiteral<"overflow-retry">, _$typebox.TLiteral<"timeout-retry">]>;
      tokensBefore: _$typebox.TOptional<_$typebox.TInteger>;
      tokensAfter: _$typebox.TOptional<_$typebox.TInteger>;
      summary: _$typebox.TOptional<_$typebox.TString>;
      firstKeptEntryId: _$typebox.TOptional<_$typebox.TString>;
      preCompaction: _$typebox.TObject<{
        sessionId: _$typebox.TString;
        sessionFile: _$typebox.TOptional<_$typebox.TString>;
        leafId: _$typebox.TOptional<_$typebox.TString>;
        entryId: _$typebox.TOptional<_$typebox.TString>;
      }>;
      postCompaction: _$typebox.TObject<{
        sessionId: _$typebox.TString;
        sessionFile: _$typebox.TOptional<_$typebox.TString>;
        leafId: _$typebox.TOptional<_$typebox.TString>;
        entryId: _$typebox.TOptional<_$typebox.TString>;
      }>;
    }>;
    entry: _$typebox.TObject<{
      sessionId: _$typebox.TString;
      updatedAt: _$typebox.TInteger;
    }>;
  }>;
  SessionsCreateParams: _$typebox.TObject<{
    key: _$typebox.TOptional<_$typebox.TString>;
    agentId: _$typebox.TOptional<_$typebox.TString>;
    label: _$typebox.TOptional<_$typebox.TString>;
    model: _$typebox.TOptional<_$typebox.TString>;
    parentSessionKey: _$typebox.TOptional<_$typebox.TString>;
    emitCommandHooks: _$typebox.TOptional<_$typebox.TBoolean>;
    task: _$typebox.TOptional<_$typebox.TString>;
    message: _$typebox.TOptional<_$typebox.TString>;
  }>;
  SessionsSendParams: _$typebox.TObject<{
    key: _$typebox.TString;
    message: _$typebox.TString;
    thinking: _$typebox.TOptional<_$typebox.TString>;
    attachments: _$typebox.TOptional<_$typebox.TArray<_$typebox.TUnknown>>;
    timeoutMs: _$typebox.TOptional<_$typebox.TInteger>;
    idempotencyKey: _$typebox.TOptional<_$typebox.TString>;
  }>;
  SessionsMessagesSubscribeParams: _$typebox.TObject<{
    key: _$typebox.TString;
  }>;
  SessionsMessagesUnsubscribeParams: _$typebox.TObject<{
    key: _$typebox.TString;
  }>;
  SessionsAbortParams: _$typebox.TObject<{
    key: _$typebox.TOptional<_$typebox.TString>;
    runId: _$typebox.TOptional<_$typebox.TString>;
  }>;
  SessionsPatchParams: _$typebox.TObject<{
    key: _$typebox.TString;
    label: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    thinkingLevel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    fastMode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TBoolean, _$typebox.TNull]>>;
    verboseLevel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    traceLevel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    reasoningLevel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    responseUsage: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"off">, _$typebox.TLiteral<"tokens">, _$typebox.TLiteral<"full">, _$typebox.TLiteral<"on">, _$typebox.TNull]>>;
    elevatedLevel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    execHost: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    execSecurity: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    execAsk: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    execNode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    model: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    spawnedBy: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    spawnedWorkspaceDir: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    spawnDepth: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TInteger, _$typebox.TNull]>>;
    subagentRole: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"orchestrator">, _$typebox.TLiteral<"leaf">, _$typebox.TNull]>>;
    subagentControlScope: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"children">, _$typebox.TLiteral<"none">, _$typebox.TNull]>>;
    sendPolicy: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"allow">, _$typebox.TLiteral<"deny">, _$typebox.TNull]>>;
    groupActivation: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"mention">, _$typebox.TLiteral<"always">, _$typebox.TNull]>>;
  }>;
  SessionsPluginPatchParams: _$typebox.TObject<{
    key: _$typebox.TString;
    pluginId: _$typebox.TString;
    namespace: _$typebox.TString;
    value: _$typebox.TOptional<_$typebox.TUnknown>;
    unset: _$typebox.TOptional<_$typebox.TBoolean>;
  }>;
  SessionsPluginPatchResult: _$typebox.TObject<{
    ok: _$typebox.TLiteral<true>;
    key: _$typebox.TString;
    value: _$typebox.TOptional<_$typebox.TUnknown>;
  }>;
  SessionsResetParams: _$typebox.TObject<{
    key: _$typebox.TString;
    reason: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"new">, _$typebox.TLiteral<"reset">]>>;
  }>;
  SessionsDeleteParams: _$typebox.TObject<{
    key: _$typebox.TString;
    deleteTranscript: _$typebox.TOptional<_$typebox.TBoolean>;
    emitLifecycleHooks: _$typebox.TOptional<_$typebox.TBoolean>;
  }>;
  SessionsCompactParams: _$typebox.TObject<{
    key: _$typebox.TString;
    maxLines: _$typebox.TOptional<_$typebox.TInteger>;
  }>;
  SessionsUsageParams: _$typebox.TObject<{
    key: _$typebox.TOptional<_$typebox.TString>;
    startDate: _$typebox.TOptional<_$typebox.TString>;
    endDate: _$typebox.TOptional<_$typebox.TString>;
    mode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"utc">, _$typebox.TLiteral<"gateway">, _$typebox.TLiteral<"specific">]>>;
    range: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"7d">, _$typebox.TLiteral<"30d">, _$typebox.TLiteral<"90d">, _$typebox.TLiteral<"1y">, _$typebox.TLiteral<"all">]>>;
    groupBy: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"instance">, _$typebox.TLiteral<"family">]>>;
    includeHistorical: _$typebox.TOptional<_$typebox.TBoolean>;
    utcOffset: _$typebox.TOptional<_$typebox.TString>;
    limit: _$typebox.TOptional<_$typebox.TInteger>;
    includeContextWeight: _$typebox.TOptional<_$typebox.TBoolean>;
  }>;
  TaskSummary: _$typebox.TObject<{
    id: _$typebox.TString;
    kind: _$typebox.TOptional<_$typebox.TString>;
    runtime: _$typebox.TOptional<_$typebox.TString>;
    status: _$typebox.TUnion<[_$typebox.TLiteral<"queued">, _$typebox.TLiteral<"running">, _$typebox.TLiteral<"completed">, _$typebox.TLiteral<"failed">, _$typebox.TLiteral<"cancelled">, _$typebox.TLiteral<"timed_out">]>;
    title: _$typebox.TOptional<_$typebox.TString>;
    agentId: _$typebox.TOptional<_$typebox.TString>;
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    childSessionKey: _$typebox.TOptional<_$typebox.TString>;
    ownerKey: _$typebox.TOptional<_$typebox.TString>;
    runId: _$typebox.TOptional<_$typebox.TString>;
    taskId: _$typebox.TOptional<_$typebox.TString>;
    flowId: _$typebox.TOptional<_$typebox.TString>;
    parentTaskId: _$typebox.TOptional<_$typebox.TString>;
    sourceId: _$typebox.TOptional<_$typebox.TString>;
    createdAt: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TInteger]>>;
    updatedAt: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TInteger]>>;
    startedAt: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TInteger]>>;
    endedAt: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TInteger]>>;
    progressSummary: _$typebox.TOptional<_$typebox.TString>;
    terminalSummary: _$typebox.TOptional<_$typebox.TString>;
    error: _$typebox.TOptional<_$typebox.TString>;
  }>;
  TasksListParams: _$typebox.TObject<{
    status: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TUnion<[_$typebox.TLiteral<"queued">, _$typebox.TLiteral<"running">, _$typebox.TLiteral<"completed">, _$typebox.TLiteral<"failed">, _$typebox.TLiteral<"cancelled">, _$typebox.TLiteral<"timed_out">]>, _$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"queued">, _$typebox.TLiteral<"running">, _$typebox.TLiteral<"completed">, _$typebox.TLiteral<"failed">, _$typebox.TLiteral<"cancelled">, _$typebox.TLiteral<"timed_out">]>>]>>;
    agentId: _$typebox.TOptional<_$typebox.TString>;
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    limit: _$typebox.TOptional<_$typebox.TInteger>;
    cursor: _$typebox.TOptional<_$typebox.TString>;
  }>;
  TasksListResult: _$typebox.TObject<{
    tasks: _$typebox.TArray<_$typebox.TObject<{
      id: _$typebox.TString;
      kind: _$typebox.TOptional<_$typebox.TString>;
      runtime: _$typebox.TOptional<_$typebox.TString>;
      status: _$typebox.TUnion<[_$typebox.TLiteral<"queued">, _$typebox.TLiteral<"running">, _$typebox.TLiteral<"completed">, _$typebox.TLiteral<"failed">, _$typebox.TLiteral<"cancelled">, _$typebox.TLiteral<"timed_out">]>;
      title: _$typebox.TOptional<_$typebox.TString>;
      agentId: _$typebox.TOptional<_$typebox.TString>;
      sessionKey: _$typebox.TOptional<_$typebox.TString>;
      childSessionKey: _$typebox.TOptional<_$typebox.TString>;
      ownerKey: _$typebox.TOptional<_$typebox.TString>;
      runId: _$typebox.TOptional<_$typebox.TString>;
      taskId: _$typebox.TOptional<_$typebox.TString>;
      flowId: _$typebox.TOptional<_$typebox.TString>;
      parentTaskId: _$typebox.TOptional<_$typebox.TString>;
      sourceId: _$typebox.TOptional<_$typebox.TString>;
      createdAt: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TInteger]>>;
      updatedAt: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TInteger]>>;
      startedAt: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TInteger]>>;
      endedAt: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TInteger]>>;
      progressSummary: _$typebox.TOptional<_$typebox.TString>;
      terminalSummary: _$typebox.TOptional<_$typebox.TString>;
      error: _$typebox.TOptional<_$typebox.TString>;
    }>>;
    nextCursor: _$typebox.TOptional<_$typebox.TString>;
  }>;
  TasksGetParams: _$typebox.TObject<{
    taskId: _$typebox.TString;
  }>;
  TasksGetResult: _$typebox.TObject<{
    task: _$typebox.TObject<{
      id: _$typebox.TString;
      kind: _$typebox.TOptional<_$typebox.TString>;
      runtime: _$typebox.TOptional<_$typebox.TString>;
      status: _$typebox.TUnion<[_$typebox.TLiteral<"queued">, _$typebox.TLiteral<"running">, _$typebox.TLiteral<"completed">, _$typebox.TLiteral<"failed">, _$typebox.TLiteral<"cancelled">, _$typebox.TLiteral<"timed_out">]>;
      title: _$typebox.TOptional<_$typebox.TString>;
      agentId: _$typebox.TOptional<_$typebox.TString>;
      sessionKey: _$typebox.TOptional<_$typebox.TString>;
      childSessionKey: _$typebox.TOptional<_$typebox.TString>;
      ownerKey: _$typebox.TOptional<_$typebox.TString>;
      runId: _$typebox.TOptional<_$typebox.TString>;
      taskId: _$typebox.TOptional<_$typebox.TString>;
      flowId: _$typebox.TOptional<_$typebox.TString>;
      parentTaskId: _$typebox.TOptional<_$typebox.TString>;
      sourceId: _$typebox.TOptional<_$typebox.TString>;
      createdAt: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TInteger]>>;
      updatedAt: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TInteger]>>;
      startedAt: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TInteger]>>;
      endedAt: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TInteger]>>;
      progressSummary: _$typebox.TOptional<_$typebox.TString>;
      terminalSummary: _$typebox.TOptional<_$typebox.TString>;
      error: _$typebox.TOptional<_$typebox.TString>;
    }>;
  }>;
  TasksCancelParams: _$typebox.TObject<{
    taskId: _$typebox.TString;
    reason: _$typebox.TOptional<_$typebox.TString>;
  }>;
  TasksCancelResult: _$typebox.TObject<{
    found: _$typebox.TBoolean;
    cancelled: _$typebox.TBoolean;
    reason: _$typebox.TOptional<_$typebox.TString>;
    task: _$typebox.TOptional<_$typebox.TObject<{
      id: _$typebox.TString;
      kind: _$typebox.TOptional<_$typebox.TString>;
      runtime: _$typebox.TOptional<_$typebox.TString>;
      status: _$typebox.TUnion<[_$typebox.TLiteral<"queued">, _$typebox.TLiteral<"running">, _$typebox.TLiteral<"completed">, _$typebox.TLiteral<"failed">, _$typebox.TLiteral<"cancelled">, _$typebox.TLiteral<"timed_out">]>;
      title: _$typebox.TOptional<_$typebox.TString>;
      agentId: _$typebox.TOptional<_$typebox.TString>;
      sessionKey: _$typebox.TOptional<_$typebox.TString>;
      childSessionKey: _$typebox.TOptional<_$typebox.TString>;
      ownerKey: _$typebox.TOptional<_$typebox.TString>;
      runId: _$typebox.TOptional<_$typebox.TString>;
      taskId: _$typebox.TOptional<_$typebox.TString>;
      flowId: _$typebox.TOptional<_$typebox.TString>;
      parentTaskId: _$typebox.TOptional<_$typebox.TString>;
      sourceId: _$typebox.TOptional<_$typebox.TString>;
      createdAt: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TInteger]>>;
      updatedAt: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TInteger]>>;
      startedAt: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TInteger]>>;
      endedAt: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TInteger]>>;
      progressSummary: _$typebox.TOptional<_$typebox.TString>;
      terminalSummary: _$typebox.TOptional<_$typebox.TString>;
      error: _$typebox.TOptional<_$typebox.TString>;
    }>>;
  }>;
  ConfigGetParams: _$typebox.TObject<{}>;
  ConfigSetParams: _$typebox.TObject<{
    raw: _$typebox.TString;
    baseHash: _$typebox.TOptional<_$typebox.TString>;
  }>;
  ConfigApplyParams: _$typebox.TObject<{
    raw: _$typebox.TString;
    baseHash: _$typebox.TOptional<_$typebox.TString>;
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    deliveryContext: _$typebox.TOptional<_$typebox.TObject<{
      channel: _$typebox.TOptional<_$typebox.TString>;
      to: _$typebox.TOptional<_$typebox.TString>;
      accountId: _$typebox.TOptional<_$typebox.TString>;
      threadId: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNumber]>>;
    }>>;
    note: _$typebox.TOptional<_$typebox.TString>;
    restartDelayMs: _$typebox.TOptional<_$typebox.TInteger>;
  }>;
  ConfigPatchParams: _$typebox.TObject<{
    raw: _$typebox.TString;
    baseHash: _$typebox.TOptional<_$typebox.TString>;
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    deliveryContext: _$typebox.TOptional<_$typebox.TObject<{
      channel: _$typebox.TOptional<_$typebox.TString>;
      to: _$typebox.TOptional<_$typebox.TString>;
      accountId: _$typebox.TOptional<_$typebox.TString>;
      threadId: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNumber]>>;
    }>>;
    note: _$typebox.TOptional<_$typebox.TString>;
    restartDelayMs: _$typebox.TOptional<_$typebox.TInteger>;
  }>;
  ConfigSchemaParams: _$typebox.TObject<{}>;
  ConfigSchemaLookupParams: _$typebox.TObject<{
    path: _$typebox.TString;
  }>;
  ConfigSchemaResponse: _$typebox.TObject<{
    schema: _$typebox.TUnknown;
    uiHints: _$typebox.TRecord<"^.*$", _$typebox.TObject<{
      label: _$typebox.TOptional<_$typebox.TString>;
      help: _$typebox.TOptional<_$typebox.TString>;
      tags: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
      group: _$typebox.TOptional<_$typebox.TString>;
      order: _$typebox.TOptional<_$typebox.TInteger>;
      advanced: _$typebox.TOptional<_$typebox.TBoolean>;
      sensitive: _$typebox.TOptional<_$typebox.TBoolean>;
      placeholder: _$typebox.TOptional<_$typebox.TString>;
      itemTemplate: _$typebox.TOptional<_$typebox.TUnknown>;
    }>>;
    version: _$typebox.TString;
    generatedAt: _$typebox.TString;
  }>;
  ConfigSchemaLookupResult: _$typebox.TObject<{
    path: _$typebox.TString;
    schema: _$typebox.TUnknown;
    hint: _$typebox.TOptional<_$typebox.TObject<{
      label: _$typebox.TOptional<_$typebox.TString>;
      help: _$typebox.TOptional<_$typebox.TString>;
      tags: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
      group: _$typebox.TOptional<_$typebox.TString>;
      order: _$typebox.TOptional<_$typebox.TInteger>;
      advanced: _$typebox.TOptional<_$typebox.TBoolean>;
      sensitive: _$typebox.TOptional<_$typebox.TBoolean>;
      placeholder: _$typebox.TOptional<_$typebox.TString>;
      itemTemplate: _$typebox.TOptional<_$typebox.TUnknown>;
    }>>;
    hintPath: _$typebox.TOptional<_$typebox.TString>;
    children: _$typebox.TArray<_$typebox.TObject<{
      key: _$typebox.TString;
      path: _$typebox.TString;
      type: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TArray<_$typebox.TString>]>>;
      required: _$typebox.TBoolean;
      hasChildren: _$typebox.TBoolean;
      hint: _$typebox.TOptional<_$typebox.TObject<{
        label: _$typebox.TOptional<_$typebox.TString>;
        help: _$typebox.TOptional<_$typebox.TString>;
        tags: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
        group: _$typebox.TOptional<_$typebox.TString>;
        order: _$typebox.TOptional<_$typebox.TInteger>;
        advanced: _$typebox.TOptional<_$typebox.TBoolean>;
        sensitive: _$typebox.TOptional<_$typebox.TBoolean>;
        placeholder: _$typebox.TOptional<_$typebox.TString>;
        itemTemplate: _$typebox.TOptional<_$typebox.TUnknown>;
      }>>;
      hintPath: _$typebox.TOptional<_$typebox.TString>;
    }>>;
  }>;
  WizardStartParams: _$typebox.TObject<{
    mode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"local">, _$typebox.TLiteral<"remote">]>>;
    workspace: _$typebox.TOptional<_$typebox.TString>;
  }>;
  WizardNextParams: _$typebox.TObject<{
    sessionId: _$typebox.TString;
    answer: _$typebox.TOptional<_$typebox.TObject<{
      stepId: _$typebox.TString;
      value: _$typebox.TOptional<_$typebox.TUnknown>;
    }>>;
  }>;
  WizardCancelParams: _$typebox.TObject<{
    sessionId: _$typebox.TString;
  }>;
  WizardStatusParams: _$typebox.TObject<{
    sessionId: _$typebox.TString;
  }>;
  WizardStep: _$typebox.TObject<{
    id: _$typebox.TString;
    type: _$typebox.TUnion<[_$typebox.TLiteral<"note">, _$typebox.TLiteral<"select">, _$typebox.TLiteral<"text">, _$typebox.TLiteral<"confirm">, _$typebox.TLiteral<"multiselect">, _$typebox.TLiteral<"progress">, _$typebox.TLiteral<"action">]>;
    title: _$typebox.TOptional<_$typebox.TString>;
    message: _$typebox.TOptional<_$typebox.TString>;
    format: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"plain">]>>;
    options: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
      value: _$typebox.TUnknown;
      label: _$typebox.TString;
      hint: _$typebox.TOptional<_$typebox.TString>;
    }>>>;
    initialValue: _$typebox.TOptional<_$typebox.TUnknown>;
    placeholder: _$typebox.TOptional<_$typebox.TString>;
    sensitive: _$typebox.TOptional<_$typebox.TBoolean>;
    executor: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"gateway">, _$typebox.TLiteral<"client">]>>;
  }>;
  WizardNextResult: _$typebox.TObject<{
    done: _$typebox.TBoolean;
    step: _$typebox.TOptional<_$typebox.TObject<{
      id: _$typebox.TString;
      type: _$typebox.TUnion<[_$typebox.TLiteral<"note">, _$typebox.TLiteral<"select">, _$typebox.TLiteral<"text">, _$typebox.TLiteral<"confirm">, _$typebox.TLiteral<"multiselect">, _$typebox.TLiteral<"progress">, _$typebox.TLiteral<"action">]>;
      title: _$typebox.TOptional<_$typebox.TString>;
      message: _$typebox.TOptional<_$typebox.TString>;
      format: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"plain">]>>;
      options: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
        value: _$typebox.TUnknown;
        label: _$typebox.TString;
        hint: _$typebox.TOptional<_$typebox.TString>;
      }>>>;
      initialValue: _$typebox.TOptional<_$typebox.TUnknown>;
      placeholder: _$typebox.TOptional<_$typebox.TString>;
      sensitive: _$typebox.TOptional<_$typebox.TBoolean>;
      executor: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"gateway">, _$typebox.TLiteral<"client">]>>;
    }>>;
    status: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"running">, _$typebox.TLiteral<"done">, _$typebox.TLiteral<"cancelled">, _$typebox.TLiteral<"error">]>>;
    error: _$typebox.TOptional<_$typebox.TString>;
  }>;
  WizardStartResult: _$typebox.TObject<{
    done: _$typebox.TBoolean;
    step: _$typebox.TOptional<_$typebox.TObject<{
      id: _$typebox.TString;
      type: _$typebox.TUnion<[_$typebox.TLiteral<"note">, _$typebox.TLiteral<"select">, _$typebox.TLiteral<"text">, _$typebox.TLiteral<"confirm">, _$typebox.TLiteral<"multiselect">, _$typebox.TLiteral<"progress">, _$typebox.TLiteral<"action">]>;
      title: _$typebox.TOptional<_$typebox.TString>;
      message: _$typebox.TOptional<_$typebox.TString>;
      format: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"plain">]>>;
      options: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
        value: _$typebox.TUnknown;
        label: _$typebox.TString;
        hint: _$typebox.TOptional<_$typebox.TString>;
      }>>>;
      initialValue: _$typebox.TOptional<_$typebox.TUnknown>;
      placeholder: _$typebox.TOptional<_$typebox.TString>;
      sensitive: _$typebox.TOptional<_$typebox.TBoolean>;
      executor: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"gateway">, _$typebox.TLiteral<"client">]>>;
    }>>;
    status: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"running">, _$typebox.TLiteral<"done">, _$typebox.TLiteral<"cancelled">, _$typebox.TLiteral<"error">]>>;
    error: _$typebox.TOptional<_$typebox.TString>;
    sessionId: _$typebox.TString;
  }>;
  WizardStatusResult: _$typebox.TObject<{
    status: _$typebox.TUnion<[_$typebox.TLiteral<"running">, _$typebox.TLiteral<"done">, _$typebox.TLiteral<"cancelled">, _$typebox.TLiteral<"error">]>;
    error: _$typebox.TOptional<_$typebox.TString>;
  }>;
  TalkModeParams: _$typebox.TObject<{
    enabled: _$typebox.TBoolean;
    phase: _$typebox.TOptional<_$typebox.TString>;
  }>;
  TalkEvent: _$typebox.TObject<{
    id: _$typebox.TString;
    type: _$typebox.TUnion<[_$typebox.TLiteral<"session.started">, _$typebox.TLiteral<"session.ready">, _$typebox.TLiteral<"session.closed">, _$typebox.TLiteral<"session.error">, _$typebox.TLiteral<"session.replaced">, _$typebox.TLiteral<"turn.started">, _$typebox.TLiteral<"turn.ended">, _$typebox.TLiteral<"turn.cancelled">, _$typebox.TLiteral<"capture.started">, _$typebox.TLiteral<"capture.stopped">, _$typebox.TLiteral<"capture.cancelled">, _$typebox.TLiteral<"capture.once">, _$typebox.TLiteral<"input.audio.delta">, _$typebox.TLiteral<"input.audio.committed">, _$typebox.TLiteral<"transcript.delta">, _$typebox.TLiteral<"transcript.done">, _$typebox.TLiteral<"output.text.delta">, _$typebox.TLiteral<"output.text.done">, _$typebox.TLiteral<"output.audio.started">, _$typebox.TLiteral<"output.audio.delta">, _$typebox.TLiteral<"output.audio.done">, _$typebox.TLiteral<"tool.call">, _$typebox.TLiteral<"tool.progress">, _$typebox.TLiteral<"tool.result">, _$typebox.TLiteral<"tool.error">, _$typebox.TLiteral<"usage.metrics">, _$typebox.TLiteral<"latency.metrics">, _$typebox.TLiteral<"health.changed">]>;
    sessionId: _$typebox.TString;
    turnId: _$typebox.TOptional<_$typebox.TString>;
    captureId: _$typebox.TOptional<_$typebox.TString>;
    seq: _$typebox.TInteger;
    timestamp: _$typebox.TString;
    mode: _$typebox.TUnion<[_$typebox.TLiteral<"realtime">, _$typebox.TLiteral<"stt-tts">, _$typebox.TLiteral<"transcription">]>;
    transport: _$typebox.TUnion<[_$typebox.TLiteral<"webrtc">, _$typebox.TLiteral<"provider-websocket">, _$typebox.TLiteral<"gateway-relay">, _$typebox.TLiteral<"managed-room">]>;
    brain: _$typebox.TUnion<[_$typebox.TLiteral<"agent-consult">, _$typebox.TLiteral<"direct-tools">, _$typebox.TLiteral<"none">]>;
    provider: _$typebox.TOptional<_$typebox.TString>;
    final: _$typebox.TOptional<_$typebox.TBoolean>;
    callId: _$typebox.TOptional<_$typebox.TString>;
    itemId: _$typebox.TOptional<_$typebox.TString>;
    parentId: _$typebox.TOptional<_$typebox.TString>;
    payload: _$typebox.TUnknown;
  }>;
  TalkCatalogParams: _$typebox.TObject<{}>;
  TalkCatalogResult: _$typebox.TObject<{
    modes: _$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"realtime">, _$typebox.TLiteral<"stt-tts">, _$typebox.TLiteral<"transcription">]>>;
    transports: _$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"webrtc">, _$typebox.TLiteral<"provider-websocket">, _$typebox.TLiteral<"gateway-relay">, _$typebox.TLiteral<"managed-room">]>>;
    brains: _$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"agent-consult">, _$typebox.TLiteral<"direct-tools">, _$typebox.TLiteral<"none">]>>;
    speech: _$typebox.TObject<{
      activeProvider: _$typebox.TOptional<_$typebox.TString>;
      providers: _$typebox.TArray<_$typebox.TObject<{
        id: _$typebox.TString;
        label: _$typebox.TString;
        configured: _$typebox.TBoolean;
        models: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
        voices: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
        defaultModel: _$typebox.TOptional<_$typebox.TString>;
        modes: _$typebox.TOptional<_$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"realtime">, _$typebox.TLiteral<"stt-tts">, _$typebox.TLiteral<"transcription">]>>>;
        transports: _$typebox.TOptional<_$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"webrtc">, _$typebox.TLiteral<"provider-websocket">, _$typebox.TLiteral<"gateway-relay">, _$typebox.TLiteral<"managed-room">]>>>;
        brains: _$typebox.TOptional<_$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"agent-consult">, _$typebox.TLiteral<"direct-tools">, _$typebox.TLiteral<"none">]>>>;
        inputAudioFormats: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
          encoding: _$typebox.TUnion<[_$typebox.TLiteral<"pcm16">, _$typebox.TLiteral<"g711_ulaw">]>;
          sampleRateHz: _$typebox.TInteger;
          channels: _$typebox.TInteger;
        }>>>;
        outputAudioFormats: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
          encoding: _$typebox.TUnion<[_$typebox.TLiteral<"pcm16">, _$typebox.TLiteral<"g711_ulaw">]>;
          sampleRateHz: _$typebox.TInteger;
          channels: _$typebox.TInteger;
        }>>>;
        supportsBrowserSession: _$typebox.TOptional<_$typebox.TBoolean>;
        supportsBargeIn: _$typebox.TOptional<_$typebox.TBoolean>;
        supportsToolCalls: _$typebox.TOptional<_$typebox.TBoolean>;
        supportsVideoFrames: _$typebox.TOptional<_$typebox.TBoolean>;
        supportsSessionResumption: _$typebox.TOptional<_$typebox.TBoolean>;
      }>>;
    }>;
    transcription: _$typebox.TObject<{
      activeProvider: _$typebox.TOptional<_$typebox.TString>;
      providers: _$typebox.TArray<_$typebox.TObject<{
        id: _$typebox.TString;
        label: _$typebox.TString;
        configured: _$typebox.TBoolean;
        models: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
        voices: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
        defaultModel: _$typebox.TOptional<_$typebox.TString>;
        modes: _$typebox.TOptional<_$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"realtime">, _$typebox.TLiteral<"stt-tts">, _$typebox.TLiteral<"transcription">]>>>;
        transports: _$typebox.TOptional<_$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"webrtc">, _$typebox.TLiteral<"provider-websocket">, _$typebox.TLiteral<"gateway-relay">, _$typebox.TLiteral<"managed-room">]>>>;
        brains: _$typebox.TOptional<_$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"agent-consult">, _$typebox.TLiteral<"direct-tools">, _$typebox.TLiteral<"none">]>>>;
        inputAudioFormats: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
          encoding: _$typebox.TUnion<[_$typebox.TLiteral<"pcm16">, _$typebox.TLiteral<"g711_ulaw">]>;
          sampleRateHz: _$typebox.TInteger;
          channels: _$typebox.TInteger;
        }>>>;
        outputAudioFormats: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
          encoding: _$typebox.TUnion<[_$typebox.TLiteral<"pcm16">, _$typebox.TLiteral<"g711_ulaw">]>;
          sampleRateHz: _$typebox.TInteger;
          channels: _$typebox.TInteger;
        }>>>;
        supportsBrowserSession: _$typebox.TOptional<_$typebox.TBoolean>;
        supportsBargeIn: _$typebox.TOptional<_$typebox.TBoolean>;
        supportsToolCalls: _$typebox.TOptional<_$typebox.TBoolean>;
        supportsVideoFrames: _$typebox.TOptional<_$typebox.TBoolean>;
        supportsSessionResumption: _$typebox.TOptional<_$typebox.TBoolean>;
      }>>;
    }>;
    realtime: _$typebox.TObject<{
      activeProvider: _$typebox.TOptional<_$typebox.TString>;
      providers: _$typebox.TArray<_$typebox.TObject<{
        id: _$typebox.TString;
        label: _$typebox.TString;
        configured: _$typebox.TBoolean;
        models: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
        voices: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
        defaultModel: _$typebox.TOptional<_$typebox.TString>;
        modes: _$typebox.TOptional<_$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"realtime">, _$typebox.TLiteral<"stt-tts">, _$typebox.TLiteral<"transcription">]>>>;
        transports: _$typebox.TOptional<_$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"webrtc">, _$typebox.TLiteral<"provider-websocket">, _$typebox.TLiteral<"gateway-relay">, _$typebox.TLiteral<"managed-room">]>>>;
        brains: _$typebox.TOptional<_$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"agent-consult">, _$typebox.TLiteral<"direct-tools">, _$typebox.TLiteral<"none">]>>>;
        inputAudioFormats: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
          encoding: _$typebox.TUnion<[_$typebox.TLiteral<"pcm16">, _$typebox.TLiteral<"g711_ulaw">]>;
          sampleRateHz: _$typebox.TInteger;
          channels: _$typebox.TInteger;
        }>>>;
        outputAudioFormats: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
          encoding: _$typebox.TUnion<[_$typebox.TLiteral<"pcm16">, _$typebox.TLiteral<"g711_ulaw">]>;
          sampleRateHz: _$typebox.TInteger;
          channels: _$typebox.TInteger;
        }>>>;
        supportsBrowserSession: _$typebox.TOptional<_$typebox.TBoolean>;
        supportsBargeIn: _$typebox.TOptional<_$typebox.TBoolean>;
        supportsToolCalls: _$typebox.TOptional<_$typebox.TBoolean>;
        supportsVideoFrames: _$typebox.TOptional<_$typebox.TBoolean>;
        supportsSessionResumption: _$typebox.TOptional<_$typebox.TBoolean>;
      }>>;
    }>;
  }>;
  TalkClientCreateParams: _$typebox.TObject<{
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    provider: _$typebox.TOptional<_$typebox.TString>;
    model: _$typebox.TOptional<_$typebox.TString>;
    voice: _$typebox.TOptional<_$typebox.TString>;
    vadThreshold: _$typebox.TOptional<_$typebox.TNumber>;
    silenceDurationMs: _$typebox.TOptional<_$typebox.TInteger>;
    prefixPaddingMs: _$typebox.TOptional<_$typebox.TInteger>;
    reasoningEffort: _$typebox.TOptional<_$typebox.TString>;
    mode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"realtime">, _$typebox.TLiteral<"stt-tts">, _$typebox.TLiteral<"transcription">]>>;
    transport: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"webrtc">, _$typebox.TLiteral<"provider-websocket">, _$typebox.TLiteral<"gateway-relay">, _$typebox.TLiteral<"managed-room">]>>;
    brain: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"agent-consult">, _$typebox.TLiteral<"direct-tools">, _$typebox.TLiteral<"none">]>>;
  }>;
  TalkClientCreateResult: _$typebox.TUnion<[_$typebox.TObject<{
    provider: _$typebox.TString;
    transport: _$typebox.TLiteral<"webrtc">;
    clientSecret: _$typebox.TString;
    offerUrl: _$typebox.TOptional<_$typebox.TString>;
    offerHeaders: _$typebox.TOptional<_$typebox.TRecord<"^.*$", _$typebox.TString>>;
    model: _$typebox.TOptional<_$typebox.TString>;
    voice: _$typebox.TOptional<_$typebox.TString>;
    expiresAt: _$typebox.TOptional<_$typebox.TNumber>;
  }>, _$typebox.TObject<{
    provider: _$typebox.TString;
    transport: _$typebox.TLiteral<"provider-websocket">;
    protocol: _$typebox.TString;
    clientSecret: _$typebox.TString;
    websocketUrl: _$typebox.TString;
    audio: _$typebox.TObject<{
      inputEncoding: _$typebox.TUnion<[_$typebox.TLiteral<"pcm16">, _$typebox.TLiteral<"g711_ulaw">]>;
      inputSampleRateHz: _$typebox.TInteger;
      outputEncoding: _$typebox.TUnion<[_$typebox.TLiteral<"pcm16">, _$typebox.TLiteral<"g711_ulaw">]>;
      outputSampleRateHz: _$typebox.TInteger;
    }>;
    initialMessage: _$typebox.TOptional<_$typebox.TUnknown>;
    model: _$typebox.TOptional<_$typebox.TString>;
    voice: _$typebox.TOptional<_$typebox.TString>;
    expiresAt: _$typebox.TOptional<_$typebox.TNumber>;
  }>, _$typebox.TObject<{
    provider: _$typebox.TString;
    transport: _$typebox.TLiteral<"gateway-relay">;
    relaySessionId: _$typebox.TString;
    audio: _$typebox.TObject<{
      inputEncoding: _$typebox.TUnion<[_$typebox.TLiteral<"pcm16">, _$typebox.TLiteral<"g711_ulaw">]>;
      inputSampleRateHz: _$typebox.TInteger;
      outputEncoding: _$typebox.TUnion<[_$typebox.TLiteral<"pcm16">, _$typebox.TLiteral<"g711_ulaw">]>;
      outputSampleRateHz: _$typebox.TInteger;
    }>;
    model: _$typebox.TOptional<_$typebox.TString>;
    voice: _$typebox.TOptional<_$typebox.TString>;
    expiresAt: _$typebox.TOptional<_$typebox.TNumber>;
  }>, _$typebox.TObject<{
    provider: _$typebox.TString;
    transport: _$typebox.TLiteral<"managed-room">;
    roomUrl: _$typebox.TString;
    token: _$typebox.TOptional<_$typebox.TString>;
    model: _$typebox.TOptional<_$typebox.TString>;
    voice: _$typebox.TOptional<_$typebox.TString>;
    expiresAt: _$typebox.TOptional<_$typebox.TNumber>;
  }>]>;
  TalkClientToolCallParams: _$typebox.TObject<{
    sessionKey: _$typebox.TString;
    callId: _$typebox.TString;
    name: _$typebox.TString;
    args: _$typebox.TOptional<_$typebox.TUnknown>;
    relaySessionId: _$typebox.TOptional<_$typebox.TString>;
  }>;
  TalkClientToolCallResult: _$typebox.TObject<{
    runId: _$typebox.TString;
    idempotencyKey: _$typebox.TString;
  }>;
  TalkConfigParams: _$typebox.TObject<{
    includeSecrets: _$typebox.TOptional<_$typebox.TBoolean>;
  }>;
  TalkConfigResult: _$typebox.TObject<{
    config: _$typebox.TObject<{
      talk: _$typebox.TOptional<_$typebox.TObject<{
        provider: _$typebox.TOptional<_$typebox.TString>;
        providers: _$typebox.TOptional<_$typebox.TRecord<"^.*$", _$typebox.TObject<{
          apiKey: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TUnion<[_$typebox.TObject<{
            source: _$typebox.TLiteral<"env">;
            provider: _$typebox.TString;
            id: _$typebox.TString;
          }>, _$typebox.TObject<{
            source: _$typebox.TLiteral<"file">;
            provider: _$typebox.TString;
            id: _$typebox.TUnsafe<string>;
          }>, _$typebox.TObject<{
            source: _$typebox.TLiteral<"exec">;
            provider: _$typebox.TString;
            id: _$typebox.TString;
          }>]>]>>;
        }>>>;
        realtime: _$typebox.TOptional<_$typebox.TObject<{
          provider: _$typebox.TOptional<_$typebox.TString>;
          providers: _$typebox.TOptional<_$typebox.TRecord<"^.*$", _$typebox.TObject<{
            apiKey: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TUnion<[_$typebox.TObject<{
              source: _$typebox.TLiteral<"env">;
              provider: _$typebox.TString;
              id: _$typebox.TString;
            }>, _$typebox.TObject<{
              source: _$typebox.TLiteral<"file">;
              provider: _$typebox.TString;
              id: _$typebox.TUnsafe<string>;
            }>, _$typebox.TObject<{
              source: _$typebox.TLiteral<"exec">;
              provider: _$typebox.TString;
              id: _$typebox.TString;
            }>]>]>>;
          }>>>;
          model: _$typebox.TOptional<_$typebox.TString>;
          voice: _$typebox.TOptional<_$typebox.TString>;
          instructions: _$typebox.TOptional<_$typebox.TString>;
          mode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"realtime">, _$typebox.TLiteral<"stt-tts">, _$typebox.TLiteral<"transcription">]>>;
          transport: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"webrtc">, _$typebox.TLiteral<"provider-websocket">, _$typebox.TLiteral<"gateway-relay">, _$typebox.TLiteral<"managed-room">]>>;
          brain: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"agent-consult">, _$typebox.TLiteral<"direct-tools">, _$typebox.TLiteral<"none">]>>;
        }>>;
        resolved: _$typebox.TOptional<_$typebox.TObject<{
          provider: _$typebox.TString;
          config: _$typebox.TObject<{
            apiKey: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TUnion<[_$typebox.TObject<{
              source: _$typebox.TLiteral<"env">;
              provider: _$typebox.TString;
              id: _$typebox.TString;
            }>, _$typebox.TObject<{
              source: _$typebox.TLiteral<"file">;
              provider: _$typebox.TString;
              id: _$typebox.TUnsafe<string>;
            }>, _$typebox.TObject<{
              source: _$typebox.TLiteral<"exec">;
              provider: _$typebox.TString;
              id: _$typebox.TString;
            }>]>]>>;
          }>;
        }>>;
        consultThinkingLevel: _$typebox.TOptional<_$typebox.TString>;
        consultFastMode: _$typebox.TOptional<_$typebox.TBoolean>;
        speechLocale: _$typebox.TOptional<_$typebox.TString>;
        interruptOnSpeech: _$typebox.TOptional<_$typebox.TBoolean>;
        silenceTimeoutMs: _$typebox.TOptional<_$typebox.TInteger>;
      }>>;
      session: _$typebox.TOptional<_$typebox.TObject<{
        mainKey: _$typebox.TOptional<_$typebox.TString>;
      }>>;
      ui: _$typebox.TOptional<_$typebox.TObject<{
        seamColor: _$typebox.TOptional<_$typebox.TString>;
      }>>;
    }>;
  }>;
  TalkSessionAppendAudioParams: _$typebox.TObject<{
    sessionId: _$typebox.TString;
    audioBase64: _$typebox.TString;
    timestamp: _$typebox.TOptional<_$typebox.TNumber>;
  }>;
  TalkSessionCancelOutputParams: _$typebox.TObject<{
    sessionId: _$typebox.TString;
    turnId: _$typebox.TOptional<_$typebox.TString>;
    reason: _$typebox.TOptional<_$typebox.TString>;
  }>;
  TalkSessionCancelTurnParams: _$typebox.TObject<{
    sessionId: _$typebox.TString;
    turnId: _$typebox.TOptional<_$typebox.TString>;
    reason: _$typebox.TOptional<_$typebox.TString>;
  }>;
  TalkSessionCreateParams: _$typebox.TObject<{
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    provider: _$typebox.TOptional<_$typebox.TString>;
    model: _$typebox.TOptional<_$typebox.TString>;
    voice: _$typebox.TOptional<_$typebox.TString>;
    vadThreshold: _$typebox.TOptional<_$typebox.TNumber>;
    silenceDurationMs: _$typebox.TOptional<_$typebox.TInteger>;
    prefixPaddingMs: _$typebox.TOptional<_$typebox.TInteger>;
    reasoningEffort: _$typebox.TOptional<_$typebox.TString>;
    mode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"realtime">, _$typebox.TLiteral<"stt-tts">, _$typebox.TLiteral<"transcription">]>>;
    transport: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"webrtc">, _$typebox.TLiteral<"provider-websocket">, _$typebox.TLiteral<"gateway-relay">, _$typebox.TLiteral<"managed-room">]>>;
    brain: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"agent-consult">, _$typebox.TLiteral<"direct-tools">, _$typebox.TLiteral<"none">]>>;
    ttlMs: _$typebox.TOptional<_$typebox.TInteger>;
  }>;
  TalkSessionCreateResult: _$typebox.TObject<{
    sessionId: _$typebox.TString;
    provider: _$typebox.TOptional<_$typebox.TString>;
    mode: _$typebox.TUnion<[_$typebox.TLiteral<"realtime">, _$typebox.TLiteral<"stt-tts">, _$typebox.TLiteral<"transcription">]>;
    transport: _$typebox.TUnion<[_$typebox.TLiteral<"webrtc">, _$typebox.TLiteral<"provider-websocket">, _$typebox.TLiteral<"gateway-relay">, _$typebox.TLiteral<"managed-room">]>;
    brain: _$typebox.TUnion<[_$typebox.TLiteral<"agent-consult">, _$typebox.TLiteral<"direct-tools">, _$typebox.TLiteral<"none">]>;
    relaySessionId: _$typebox.TOptional<_$typebox.TString>;
    transcriptionSessionId: _$typebox.TOptional<_$typebox.TString>;
    handoffId: _$typebox.TOptional<_$typebox.TString>;
    roomId: _$typebox.TOptional<_$typebox.TString>;
    roomUrl: _$typebox.TOptional<_$typebox.TString>;
    token: _$typebox.TOptional<_$typebox.TString>;
    audio: _$typebox.TOptional<_$typebox.TUnknown>;
    model: _$typebox.TOptional<_$typebox.TString>;
    voice: _$typebox.TOptional<_$typebox.TString>;
    expiresAt: _$typebox.TOptional<_$typebox.TNumber>;
  }>;
  TalkSessionJoinParams: _$typebox.TObject<{
    sessionId: _$typebox.TString;
    token: _$typebox.TString;
  }>;
  TalkSessionJoinResult: _$typebox.TObject<{
    id: _$typebox.TString;
    roomId: _$typebox.TString;
    roomUrl: _$typebox.TString;
    sessionKey: _$typebox.TString;
    sessionId: _$typebox.TOptional<_$typebox.TString>;
    channel: _$typebox.TOptional<_$typebox.TString>;
    target: _$typebox.TOptional<_$typebox.TString>;
    provider: _$typebox.TOptional<_$typebox.TString>;
    model: _$typebox.TOptional<_$typebox.TString>;
    voice: _$typebox.TOptional<_$typebox.TString>;
    mode: _$typebox.TUnion<[_$typebox.TLiteral<"realtime">, _$typebox.TLiteral<"stt-tts">, _$typebox.TLiteral<"transcription">]>;
    transport: _$typebox.TUnion<[_$typebox.TLiteral<"webrtc">, _$typebox.TLiteral<"provider-websocket">, _$typebox.TLiteral<"gateway-relay">, _$typebox.TLiteral<"managed-room">]>;
    brain: _$typebox.TUnion<[_$typebox.TLiteral<"agent-consult">, _$typebox.TLiteral<"direct-tools">, _$typebox.TLiteral<"none">]>;
    createdAt: _$typebox.TNumber;
    expiresAt: _$typebox.TNumber;
    room: _$typebox.TObject<{
      activeClientId: _$typebox.TOptional<_$typebox.TString>;
      activeTurnId: _$typebox.TOptional<_$typebox.TString>;
      recentTalkEvents: _$typebox.TArray<_$typebox.TObject<{
        id: _$typebox.TString;
        type: _$typebox.TUnion<[_$typebox.TLiteral<"session.started">, _$typebox.TLiteral<"session.ready">, _$typebox.TLiteral<"session.closed">, _$typebox.TLiteral<"session.error">, _$typebox.TLiteral<"session.replaced">, _$typebox.TLiteral<"turn.started">, _$typebox.TLiteral<"turn.ended">, _$typebox.TLiteral<"turn.cancelled">, _$typebox.TLiteral<"capture.started">, _$typebox.TLiteral<"capture.stopped">, _$typebox.TLiteral<"capture.cancelled">, _$typebox.TLiteral<"capture.once">, _$typebox.TLiteral<"input.audio.delta">, _$typebox.TLiteral<"input.audio.committed">, _$typebox.TLiteral<"transcript.delta">, _$typebox.TLiteral<"transcript.done">, _$typebox.TLiteral<"output.text.delta">, _$typebox.TLiteral<"output.text.done">, _$typebox.TLiteral<"output.audio.started">, _$typebox.TLiteral<"output.audio.delta">, _$typebox.TLiteral<"output.audio.done">, _$typebox.TLiteral<"tool.call">, _$typebox.TLiteral<"tool.progress">, _$typebox.TLiteral<"tool.result">, _$typebox.TLiteral<"tool.error">, _$typebox.TLiteral<"usage.metrics">, _$typebox.TLiteral<"latency.metrics">, _$typebox.TLiteral<"health.changed">]>;
        sessionId: _$typebox.TString;
        turnId: _$typebox.TOptional<_$typebox.TString>;
        captureId: _$typebox.TOptional<_$typebox.TString>;
        seq: _$typebox.TInteger;
        timestamp: _$typebox.TString;
        mode: _$typebox.TUnion<[_$typebox.TLiteral<"realtime">, _$typebox.TLiteral<"stt-tts">, _$typebox.TLiteral<"transcription">]>;
        transport: _$typebox.TUnion<[_$typebox.TLiteral<"webrtc">, _$typebox.TLiteral<"provider-websocket">, _$typebox.TLiteral<"gateway-relay">, _$typebox.TLiteral<"managed-room">]>;
        brain: _$typebox.TUnion<[_$typebox.TLiteral<"agent-consult">, _$typebox.TLiteral<"direct-tools">, _$typebox.TLiteral<"none">]>;
        provider: _$typebox.TOptional<_$typebox.TString>;
        final: _$typebox.TOptional<_$typebox.TBoolean>;
        callId: _$typebox.TOptional<_$typebox.TString>;
        itemId: _$typebox.TOptional<_$typebox.TString>;
        parentId: _$typebox.TOptional<_$typebox.TString>;
        payload: _$typebox.TUnknown;
      }>>;
    }>;
  }>;
  TalkSessionTurnParams: _$typebox.TObject<{
    sessionId: _$typebox.TString;
    turnId: _$typebox.TOptional<_$typebox.TString>;
  }>;
  TalkSessionTurnResult: _$typebox.TObject<{
    ok: _$typebox.TBoolean;
    turnId: _$typebox.TOptional<_$typebox.TString>;
    events: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
      id: _$typebox.TString;
      type: _$typebox.TUnion<[_$typebox.TLiteral<"session.started">, _$typebox.TLiteral<"session.ready">, _$typebox.TLiteral<"session.closed">, _$typebox.TLiteral<"session.error">, _$typebox.TLiteral<"session.replaced">, _$typebox.TLiteral<"turn.started">, _$typebox.TLiteral<"turn.ended">, _$typebox.TLiteral<"turn.cancelled">, _$typebox.TLiteral<"capture.started">, _$typebox.TLiteral<"capture.stopped">, _$typebox.TLiteral<"capture.cancelled">, _$typebox.TLiteral<"capture.once">, _$typebox.TLiteral<"input.audio.delta">, _$typebox.TLiteral<"input.audio.committed">, _$typebox.TLiteral<"transcript.delta">, _$typebox.TLiteral<"transcript.done">, _$typebox.TLiteral<"output.text.delta">, _$typebox.TLiteral<"output.text.done">, _$typebox.TLiteral<"output.audio.started">, _$typebox.TLiteral<"output.audio.delta">, _$typebox.TLiteral<"output.audio.done">, _$typebox.TLiteral<"tool.call">, _$typebox.TLiteral<"tool.progress">, _$typebox.TLiteral<"tool.result">, _$typebox.TLiteral<"tool.error">, _$typebox.TLiteral<"usage.metrics">, _$typebox.TLiteral<"latency.metrics">, _$typebox.TLiteral<"health.changed">]>;
      sessionId: _$typebox.TString;
      turnId: _$typebox.TOptional<_$typebox.TString>;
      captureId: _$typebox.TOptional<_$typebox.TString>;
      seq: _$typebox.TInteger;
      timestamp: _$typebox.TString;
      mode: _$typebox.TUnion<[_$typebox.TLiteral<"realtime">, _$typebox.TLiteral<"stt-tts">, _$typebox.TLiteral<"transcription">]>;
      transport: _$typebox.TUnion<[_$typebox.TLiteral<"webrtc">, _$typebox.TLiteral<"provider-websocket">, _$typebox.TLiteral<"gateway-relay">, _$typebox.TLiteral<"managed-room">]>;
      brain: _$typebox.TUnion<[_$typebox.TLiteral<"agent-consult">, _$typebox.TLiteral<"direct-tools">, _$typebox.TLiteral<"none">]>;
      provider: _$typebox.TOptional<_$typebox.TString>;
      final: _$typebox.TOptional<_$typebox.TBoolean>;
      callId: _$typebox.TOptional<_$typebox.TString>;
      itemId: _$typebox.TOptional<_$typebox.TString>;
      parentId: _$typebox.TOptional<_$typebox.TString>;
      payload: _$typebox.TUnknown;
    }>>>;
  }>;
  TalkSessionSubmitToolResultParams: _$typebox.TObject<{
    sessionId: _$typebox.TString;
    callId: _$typebox.TString;
    result: _$typebox.TUnknown;
    options: _$typebox.TOptional<_$typebox.TObject<{
      suppressResponse: _$typebox.TOptional<_$typebox.TBoolean>;
      willContinue: _$typebox.TOptional<_$typebox.TBoolean>;
    }>>;
  }>;
  TalkSessionCloseParams: _$typebox.TObject<{
    sessionId: _$typebox.TString;
  }>;
  TalkSessionOkResult: _$typebox.TObject<{
    ok: _$typebox.TBoolean;
  }>;
  TalkSpeakParams: _$typebox.TObject<{
    text: _$typebox.TString;
    voiceId: _$typebox.TOptional<_$typebox.TString>;
    modelId: _$typebox.TOptional<_$typebox.TString>;
    outputFormat: _$typebox.TOptional<_$typebox.TString>;
    speed: _$typebox.TOptional<_$typebox.TNumber>;
    rateWpm: _$typebox.TOptional<_$typebox.TInteger>;
    stability: _$typebox.TOptional<_$typebox.TNumber>;
    similarity: _$typebox.TOptional<_$typebox.TNumber>;
    style: _$typebox.TOptional<_$typebox.TNumber>;
    speakerBoost: _$typebox.TOptional<_$typebox.TBoolean>;
    seed: _$typebox.TOptional<_$typebox.TInteger>;
    normalize: _$typebox.TOptional<_$typebox.TString>;
    language: _$typebox.TOptional<_$typebox.TString>;
    latencyTier: _$typebox.TOptional<_$typebox.TInteger>;
  }>;
  TalkSpeakResult: _$typebox.TObject<{
    audioBase64: _$typebox.TString;
    provider: _$typebox.TString;
    outputFormat: _$typebox.TOptional<_$typebox.TString>;
    voiceCompatible: _$typebox.TOptional<_$typebox.TBoolean>;
    mimeType: _$typebox.TOptional<_$typebox.TString>;
    fileExtension: _$typebox.TOptional<_$typebox.TString>;
  }>;
  ChannelsStatusParams: _$typebox.TObject<{
    probe: _$typebox.TOptional<_$typebox.TBoolean>;
    timeoutMs: _$typebox.TOptional<_$typebox.TInteger>;
    channel: _$typebox.TOptional<_$typebox.TString>;
  }>;
  ChannelsStatusResult: _$typebox.TObject<{
    ts: _$typebox.TInteger;
    channelOrder: _$typebox.TArray<_$typebox.TString>;
    channelLabels: _$typebox.TRecord<"^.*$", _$typebox.TString>;
    channelDetailLabels: _$typebox.TOptional<_$typebox.TRecord<"^.*$", _$typebox.TString>>;
    channelSystemImages: _$typebox.TOptional<_$typebox.TRecord<"^.*$", _$typebox.TString>>;
    channelMeta: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
      id: _$typebox.TString;
      label: _$typebox.TString;
      detailLabel: _$typebox.TString;
      systemImage: _$typebox.TOptional<_$typebox.TString>;
    }>>>;
    channels: _$typebox.TRecord<"^.*$", _$typebox.TUnknown>;
    channelAccounts: _$typebox.TRecord<"^.*$", _$typebox.TArray<_$typebox.TObject<{
      accountId: _$typebox.TString;
      name: _$typebox.TOptional<_$typebox.TString>;
      enabled: _$typebox.TOptional<_$typebox.TBoolean>;
      configured: _$typebox.TOptional<_$typebox.TBoolean>;
      linked: _$typebox.TOptional<_$typebox.TBoolean>;
      running: _$typebox.TOptional<_$typebox.TBoolean>;
      connected: _$typebox.TOptional<_$typebox.TBoolean>;
      reconnectAttempts: _$typebox.TOptional<_$typebox.TInteger>;
      lastConnectedAt: _$typebox.TOptional<_$typebox.TInteger>;
      lastError: _$typebox.TOptional<_$typebox.TString>;
      healthState: _$typebox.TOptional<_$typebox.TString>;
      lastStartAt: _$typebox.TOptional<_$typebox.TInteger>;
      lastStopAt: _$typebox.TOptional<_$typebox.TInteger>;
      lastInboundAt: _$typebox.TOptional<_$typebox.TInteger>;
      lastOutboundAt: _$typebox.TOptional<_$typebox.TInteger>;
      lastTransportActivityAt: _$typebox.TOptional<_$typebox.TInteger>;
      busy: _$typebox.TOptional<_$typebox.TBoolean>;
      activeRuns: _$typebox.TOptional<_$typebox.TInteger>;
      lastRunActivityAt: _$typebox.TOptional<_$typebox.TInteger>;
      lastProbeAt: _$typebox.TOptional<_$typebox.TInteger>;
      mode: _$typebox.TOptional<_$typebox.TString>;
      dmPolicy: _$typebox.TOptional<_$typebox.TString>;
      allowFrom: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
      tokenSource: _$typebox.TOptional<_$typebox.TString>;
      botTokenSource: _$typebox.TOptional<_$typebox.TString>;
      appTokenSource: _$typebox.TOptional<_$typebox.TString>;
      baseUrl: _$typebox.TOptional<_$typebox.TString>;
      allowUnmentionedGroups: _$typebox.TOptional<_$typebox.TBoolean>;
      cliPath: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
      dbPath: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
      port: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TInteger, _$typebox.TNull]>>;
      probe: _$typebox.TOptional<_$typebox.TUnknown>;
      audit: _$typebox.TOptional<_$typebox.TUnknown>;
      application: _$typebox.TOptional<_$typebox.TUnknown>;
    }>>>;
    channelDefaultAccountId: _$typebox.TRecord<"^.*$", _$typebox.TString>;
    eventLoop: _$typebox.TOptional<_$typebox.TObject<{
      degraded: _$typebox.TBoolean;
      reasons: _$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"event_loop_delay">, _$typebox.TLiteral<"event_loop_utilization">, _$typebox.TLiteral<"cpu">]>>;
      intervalMs: _$typebox.TInteger;
      delayP99Ms: _$typebox.TNumber;
      delayMaxMs: _$typebox.TNumber;
      utilization: _$typebox.TNumber;
      cpuCoreRatio: _$typebox.TNumber;
    }>>;
    partial: _$typebox.TOptional<_$typebox.TBoolean>;
    warnings: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
  }>;
  ChannelsStartParams: _$typebox.TObject<{
    channel: _$typebox.TString;
    accountId: _$typebox.TOptional<_$typebox.TString>;
  }>;
  ChannelsStopParams: _$typebox.TObject<{
    channel: _$typebox.TString;
    accountId: _$typebox.TOptional<_$typebox.TString>;
  }>;
  ChannelsLogoutParams: _$typebox.TObject<{
    channel: _$typebox.TString;
    accountId: _$typebox.TOptional<_$typebox.TString>;
  }>;
  WebLoginStartParams: _$typebox.TObject<{
    force: _$typebox.TOptional<_$typebox.TBoolean>;
    timeoutMs: _$typebox.TOptional<_$typebox.TInteger>;
    verbose: _$typebox.TOptional<_$typebox.TBoolean>;
    accountId: _$typebox.TOptional<_$typebox.TString>;
  }>;
  WebLoginWaitParams: _$typebox.TObject<{
    timeoutMs: _$typebox.TOptional<_$typebox.TInteger>;
    accountId: _$typebox.TOptional<_$typebox.TString>;
    currentQrDataUrl: _$typebox.TOptional<_$typebox.TString>;
  }>;
  AgentSummary: _$typebox.TObject<{
    id: _$typebox.TString;
    name: _$typebox.TOptional<_$typebox.TString>;
    identity: _$typebox.TOptional<_$typebox.TObject<{
      name: _$typebox.TOptional<_$typebox.TString>;
      theme: _$typebox.TOptional<_$typebox.TString>;
      emoji: _$typebox.TOptional<_$typebox.TString>;
      avatar: _$typebox.TOptional<_$typebox.TString>;
      avatarUrl: _$typebox.TOptional<_$typebox.TString>;
    }>>;
    workspace: _$typebox.TOptional<_$typebox.TString>;
    model: _$typebox.TOptional<_$typebox.TObject<{
      primary: _$typebox.TOptional<_$typebox.TString>;
      fallbacks: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    }>>;
    agentRuntime: _$typebox.TOptional<_$typebox.TObject<{
      id: _$typebox.TString;
      fallback: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"pi">, _$typebox.TLiteral<"none">]>>;
      source: _$typebox.TUnion<[_$typebox.TLiteral<"env">, _$typebox.TLiteral<"agent">, _$typebox.TLiteral<"defaults">, _$typebox.TLiteral<"model">, _$typebox.TLiteral<"provider">, _$typebox.TLiteral<"implicit">]>;
    }>>;
  }>;
  AgentsCreateParams: _$typebox.TObject<{
    name: _$typebox.TString;
    workspace: _$typebox.TString;
    model: _$typebox.TOptional<_$typebox.TString>;
    emoji: _$typebox.TOptional<_$typebox.TString>;
    avatar: _$typebox.TOptional<_$typebox.TString>;
  }>;
  AgentsCreateResult: _$typebox.TObject<{
    ok: _$typebox.TLiteral<true>;
    agentId: _$typebox.TString;
    name: _$typebox.TString;
    workspace: _$typebox.TString;
    model: _$typebox.TOptional<_$typebox.TString>;
  }>;
  AgentsUpdateParams: _$typebox.TObject<{
    agentId: _$typebox.TString;
    name: _$typebox.TOptional<_$typebox.TString>;
    workspace: _$typebox.TOptional<_$typebox.TString>;
    model: _$typebox.TOptional<_$typebox.TString>;
    emoji: _$typebox.TOptional<_$typebox.TString>;
    avatar: _$typebox.TOptional<_$typebox.TString>;
  }>;
  AgentsUpdateResult: _$typebox.TObject<{
    ok: _$typebox.TLiteral<true>;
    agentId: _$typebox.TString;
  }>;
  AgentsDeleteParams: _$typebox.TObject<{
    agentId: _$typebox.TString;
    deleteFiles: _$typebox.TOptional<_$typebox.TBoolean>;
  }>;
  AgentsDeleteResult: _$typebox.TObject<{
    ok: _$typebox.TLiteral<true>;
    agentId: _$typebox.TString;
    removedBindings: _$typebox.TInteger;
  }>;
  AgentsFileEntry: _$typebox.TObject<{
    name: _$typebox.TString;
    path: _$typebox.TString;
    missing: _$typebox.TBoolean;
    size: _$typebox.TOptional<_$typebox.TInteger>;
    updatedAtMs: _$typebox.TOptional<_$typebox.TInteger>;
    content: _$typebox.TOptional<_$typebox.TString>;
  }>;
  AgentsFilesListParams: _$typebox.TObject<{
    agentId: _$typebox.TString;
  }>;
  AgentsFilesListResult: _$typebox.TObject<{
    agentId: _$typebox.TString;
    workspace: _$typebox.TString;
    files: _$typebox.TArray<_$typebox.TObject<{
      name: _$typebox.TString;
      path: _$typebox.TString;
      missing: _$typebox.TBoolean;
      size: _$typebox.TOptional<_$typebox.TInteger>;
      updatedAtMs: _$typebox.TOptional<_$typebox.TInteger>;
      content: _$typebox.TOptional<_$typebox.TString>;
    }>>;
  }>;
  AgentsFilesGetParams: _$typebox.TObject<{
    agentId: _$typebox.TString;
    name: _$typebox.TString;
  }>;
  AgentsFilesGetResult: _$typebox.TObject<{
    agentId: _$typebox.TString;
    workspace: _$typebox.TString;
    file: _$typebox.TObject<{
      name: _$typebox.TString;
      path: _$typebox.TString;
      missing: _$typebox.TBoolean;
      size: _$typebox.TOptional<_$typebox.TInteger>;
      updatedAtMs: _$typebox.TOptional<_$typebox.TInteger>;
      content: _$typebox.TOptional<_$typebox.TString>;
    }>;
  }>;
  AgentsFilesSetParams: _$typebox.TObject<{
    agentId: _$typebox.TString;
    name: _$typebox.TString;
    content: _$typebox.TString;
  }>;
  AgentsFilesSetResult: _$typebox.TObject<{
    ok: _$typebox.TLiteral<true>;
    agentId: _$typebox.TString;
    workspace: _$typebox.TString;
    file: _$typebox.TObject<{
      name: _$typebox.TString;
      path: _$typebox.TString;
      missing: _$typebox.TBoolean;
      size: _$typebox.TOptional<_$typebox.TInteger>;
      updatedAtMs: _$typebox.TOptional<_$typebox.TInteger>;
      content: _$typebox.TOptional<_$typebox.TString>;
    }>;
  }>;
  ArtifactSummary: _$typebox.TObject<{
    id: _$typebox.TString;
    type: _$typebox.TString;
    title: _$typebox.TString;
    mimeType: _$typebox.TOptional<_$typebox.TString>;
    sizeBytes: _$typebox.TOptional<_$typebox.TInteger>;
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    runId: _$typebox.TOptional<_$typebox.TString>;
    taskId: _$typebox.TOptional<_$typebox.TString>;
    messageSeq: _$typebox.TOptional<_$typebox.TInteger>;
    source: _$typebox.TOptional<_$typebox.TString>;
    download: _$typebox.TObject<{
      mode: _$typebox.TUnion<[_$typebox.TLiteral<"bytes">, _$typebox.TLiteral<"url">, _$typebox.TLiteral<"unsupported">]>;
    }>;
  }>;
  ArtifactsListParams: _$typebox.TObject<{
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    runId: _$typebox.TOptional<_$typebox.TString>;
    taskId: _$typebox.TOptional<_$typebox.TString>;
  }>;
  ArtifactsListResult: _$typebox.TObject<{
    artifacts: _$typebox.TArray<_$typebox.TObject<{
      id: _$typebox.TString;
      type: _$typebox.TString;
      title: _$typebox.TString;
      mimeType: _$typebox.TOptional<_$typebox.TString>;
      sizeBytes: _$typebox.TOptional<_$typebox.TInteger>;
      sessionKey: _$typebox.TOptional<_$typebox.TString>;
      runId: _$typebox.TOptional<_$typebox.TString>;
      taskId: _$typebox.TOptional<_$typebox.TString>;
      messageSeq: _$typebox.TOptional<_$typebox.TInteger>;
      source: _$typebox.TOptional<_$typebox.TString>;
      download: _$typebox.TObject<{
        mode: _$typebox.TUnion<[_$typebox.TLiteral<"bytes">, _$typebox.TLiteral<"url">, _$typebox.TLiteral<"unsupported">]>;
      }>;
    }>>;
  }>;
  ArtifactsGetParams: _$typebox.TObject<{
    artifactId: _$typebox.TString;
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    runId: _$typebox.TOptional<_$typebox.TString>;
    taskId: _$typebox.TOptional<_$typebox.TString>;
  }>;
  ArtifactsGetResult: _$typebox.TObject<{
    artifact: _$typebox.TObject<{
      id: _$typebox.TString;
      type: _$typebox.TString;
      title: _$typebox.TString;
      mimeType: _$typebox.TOptional<_$typebox.TString>;
      sizeBytes: _$typebox.TOptional<_$typebox.TInteger>;
      sessionKey: _$typebox.TOptional<_$typebox.TString>;
      runId: _$typebox.TOptional<_$typebox.TString>;
      taskId: _$typebox.TOptional<_$typebox.TString>;
      messageSeq: _$typebox.TOptional<_$typebox.TInteger>;
      source: _$typebox.TOptional<_$typebox.TString>;
      download: _$typebox.TObject<{
        mode: _$typebox.TUnion<[_$typebox.TLiteral<"bytes">, _$typebox.TLiteral<"url">, _$typebox.TLiteral<"unsupported">]>;
      }>;
    }>;
  }>;
  ArtifactsDownloadParams: _$typebox.TObject<{
    artifactId: _$typebox.TString;
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    runId: _$typebox.TOptional<_$typebox.TString>;
    taskId: _$typebox.TOptional<_$typebox.TString>;
  }>;
  ArtifactsDownloadResult: _$typebox.TObject<{
    artifact: _$typebox.TObject<{
      id: _$typebox.TString;
      type: _$typebox.TString;
      title: _$typebox.TString;
      mimeType: _$typebox.TOptional<_$typebox.TString>;
      sizeBytes: _$typebox.TOptional<_$typebox.TInteger>;
      sessionKey: _$typebox.TOptional<_$typebox.TString>;
      runId: _$typebox.TOptional<_$typebox.TString>;
      taskId: _$typebox.TOptional<_$typebox.TString>;
      messageSeq: _$typebox.TOptional<_$typebox.TInteger>;
      source: _$typebox.TOptional<_$typebox.TString>;
      download: _$typebox.TObject<{
        mode: _$typebox.TUnion<[_$typebox.TLiteral<"bytes">, _$typebox.TLiteral<"url">, _$typebox.TLiteral<"unsupported">]>;
      }>;
    }>;
    encoding: _$typebox.TOptional<_$typebox.TLiteral<"base64">>;
    data: _$typebox.TOptional<_$typebox.TString>;
    url: _$typebox.TOptional<_$typebox.TString>;
  }>;
  AgentsListParams: _$typebox.TObject<{}>;
  AgentsListResult: _$typebox.TObject<{
    defaultId: _$typebox.TString;
    mainKey: _$typebox.TString;
    scope: _$typebox.TUnion<[_$typebox.TLiteral<"per-sender">, _$typebox.TLiteral<"global">]>;
    agents: _$typebox.TArray<_$typebox.TObject<{
      id: _$typebox.TString;
      name: _$typebox.TOptional<_$typebox.TString>;
      identity: _$typebox.TOptional<_$typebox.TObject<{
        name: _$typebox.TOptional<_$typebox.TString>;
        theme: _$typebox.TOptional<_$typebox.TString>;
        emoji: _$typebox.TOptional<_$typebox.TString>;
        avatar: _$typebox.TOptional<_$typebox.TString>;
        avatarUrl: _$typebox.TOptional<_$typebox.TString>;
      }>>;
      workspace: _$typebox.TOptional<_$typebox.TString>;
      model: _$typebox.TOptional<_$typebox.TObject<{
        primary: _$typebox.TOptional<_$typebox.TString>;
        fallbacks: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
      }>>;
      agentRuntime: _$typebox.TOptional<_$typebox.TObject<{
        id: _$typebox.TString;
        fallback: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"pi">, _$typebox.TLiteral<"none">]>>;
        source: _$typebox.TUnion<[_$typebox.TLiteral<"env">, _$typebox.TLiteral<"agent">, _$typebox.TLiteral<"defaults">, _$typebox.TLiteral<"model">, _$typebox.TLiteral<"provider">, _$typebox.TLiteral<"implicit">]>;
      }>>;
    }>>;
  }>;
  ModelChoice: _$typebox.TObject<{
    id: _$typebox.TString;
    name: _$typebox.TString;
    provider: _$typebox.TString;
    alias: _$typebox.TOptional<_$typebox.TString>;
    contextWindow: _$typebox.TOptional<_$typebox.TInteger>;
    reasoning: _$typebox.TOptional<_$typebox.TBoolean>;
  }>;
  ModelsListParams: _$typebox.TObject<{
    view: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"default">, _$typebox.TLiteral<"configured">, _$typebox.TLiteral<"all">]>>;
  }>;
  ModelsListResult: _$typebox.TObject<{
    models: _$typebox.TArray<_$typebox.TObject<{
      id: _$typebox.TString;
      name: _$typebox.TString;
      provider: _$typebox.TString;
      alias: _$typebox.TOptional<_$typebox.TString>;
      contextWindow: _$typebox.TOptional<_$typebox.TInteger>;
      reasoning: _$typebox.TOptional<_$typebox.TBoolean>;
    }>>;
  }>;
  CommandEntry: _$typebox.TObject<{
    name: _$typebox.TString;
    nativeName: _$typebox.TOptional<_$typebox.TString>;
    textAliases: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    description: _$typebox.TString;
    category: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"session">, _$typebox.TLiteral<"options">, _$typebox.TLiteral<"status">, _$typebox.TLiteral<"management">, _$typebox.TLiteral<"media">, _$typebox.TLiteral<"tools">, _$typebox.TLiteral<"docks">]>>;
    source: _$typebox.TUnion<[_$typebox.TLiteral<"native">, _$typebox.TLiteral<"skill">, _$typebox.TLiteral<"plugin">]>;
    scope: _$typebox.TUnion<[_$typebox.TLiteral<"text">, _$typebox.TLiteral<"native">, _$typebox.TLiteral<"both">]>;
    acceptsArgs: _$typebox.TBoolean;
    args: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
      name: _$typebox.TString;
      description: _$typebox.TString;
      type: _$typebox.TUnion<[_$typebox.TLiteral<"string">, _$typebox.TLiteral<"number">, _$typebox.TLiteral<"boolean">]>;
      required: _$typebox.TOptional<_$typebox.TBoolean>;
      choices: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
        value: _$typebox.TString;
        label: _$typebox.TString;
      }>>>;
      dynamic: _$typebox.TOptional<_$typebox.TBoolean>;
    }>>>;
  }>;
  CommandsListParams: _$typebox.TObject<{
    agentId: _$typebox.TOptional<_$typebox.TString>;
    provider: _$typebox.TOptional<_$typebox.TString>;
    scope: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"text">, _$typebox.TLiteral<"native">, _$typebox.TLiteral<"both">]>>;
    includeArgs: _$typebox.TOptional<_$typebox.TBoolean>;
  }>;
  CommandsListResult: _$typebox.TObject<{
    commands: _$typebox.TArray<_$typebox.TObject<{
      name: _$typebox.TString;
      nativeName: _$typebox.TOptional<_$typebox.TString>;
      textAliases: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
      description: _$typebox.TString;
      category: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"session">, _$typebox.TLiteral<"options">, _$typebox.TLiteral<"status">, _$typebox.TLiteral<"management">, _$typebox.TLiteral<"media">, _$typebox.TLiteral<"tools">, _$typebox.TLiteral<"docks">]>>;
      source: _$typebox.TUnion<[_$typebox.TLiteral<"native">, _$typebox.TLiteral<"skill">, _$typebox.TLiteral<"plugin">]>;
      scope: _$typebox.TUnion<[_$typebox.TLiteral<"text">, _$typebox.TLiteral<"native">, _$typebox.TLiteral<"both">]>;
      acceptsArgs: _$typebox.TBoolean;
      args: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
        name: _$typebox.TString;
        description: _$typebox.TString;
        type: _$typebox.TUnion<[_$typebox.TLiteral<"string">, _$typebox.TLiteral<"number">, _$typebox.TLiteral<"boolean">]>;
        required: _$typebox.TOptional<_$typebox.TBoolean>;
        choices: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
          value: _$typebox.TString;
          label: _$typebox.TString;
        }>>>;
        dynamic: _$typebox.TOptional<_$typebox.TBoolean>;
      }>>>;
    }>>;
  }>;
  SkillsStatusParams: _$typebox.TObject<{
    agentId: _$typebox.TOptional<_$typebox.TString>;
  }>;
  ToolsCatalogParams: _$typebox.TObject<{
    agentId: _$typebox.TOptional<_$typebox.TString>;
    includePlugins: _$typebox.TOptional<_$typebox.TBoolean>;
  }>;
  ToolCatalogProfile: _$typebox.TObject<{
    id: _$typebox.TUnion<[_$typebox.TLiteral<"minimal">, _$typebox.TLiteral<"coding">, _$typebox.TLiteral<"messaging">, _$typebox.TLiteral<"full">]>;
    label: _$typebox.TString;
  }>;
  ToolCatalogEntry: _$typebox.TObject<{
    id: _$typebox.TString;
    label: _$typebox.TString;
    description: _$typebox.TString;
    source: _$typebox.TUnion<[_$typebox.TLiteral<"core">, _$typebox.TLiteral<"plugin">]>;
    pluginId: _$typebox.TOptional<_$typebox.TString>;
    optional: _$typebox.TOptional<_$typebox.TBoolean>;
    risk: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"low">, _$typebox.TLiteral<"medium">, _$typebox.TLiteral<"high">]>>;
    tags: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    defaultProfiles: _$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"minimal">, _$typebox.TLiteral<"coding">, _$typebox.TLiteral<"messaging">, _$typebox.TLiteral<"full">]>>;
  }>;
  ToolCatalogGroup: _$typebox.TObject<{
    id: _$typebox.TString;
    label: _$typebox.TString;
    source: _$typebox.TUnion<[_$typebox.TLiteral<"core">, _$typebox.TLiteral<"plugin">]>;
    pluginId: _$typebox.TOptional<_$typebox.TString>;
    tools: _$typebox.TArray<_$typebox.TObject<{
      id: _$typebox.TString;
      label: _$typebox.TString;
      description: _$typebox.TString;
      source: _$typebox.TUnion<[_$typebox.TLiteral<"core">, _$typebox.TLiteral<"plugin">]>;
      pluginId: _$typebox.TOptional<_$typebox.TString>;
      optional: _$typebox.TOptional<_$typebox.TBoolean>;
      risk: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"low">, _$typebox.TLiteral<"medium">, _$typebox.TLiteral<"high">]>>;
      tags: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
      defaultProfiles: _$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"minimal">, _$typebox.TLiteral<"coding">, _$typebox.TLiteral<"messaging">, _$typebox.TLiteral<"full">]>>;
    }>>;
  }>;
  ToolsCatalogResult: _$typebox.TObject<{
    agentId: _$typebox.TString;
    profiles: _$typebox.TArray<_$typebox.TObject<{
      id: _$typebox.TUnion<[_$typebox.TLiteral<"minimal">, _$typebox.TLiteral<"coding">, _$typebox.TLiteral<"messaging">, _$typebox.TLiteral<"full">]>;
      label: _$typebox.TString;
    }>>;
    groups: _$typebox.TArray<_$typebox.TObject<{
      id: _$typebox.TString;
      label: _$typebox.TString;
      source: _$typebox.TUnion<[_$typebox.TLiteral<"core">, _$typebox.TLiteral<"plugin">]>;
      pluginId: _$typebox.TOptional<_$typebox.TString>;
      tools: _$typebox.TArray<_$typebox.TObject<{
        id: _$typebox.TString;
        label: _$typebox.TString;
        description: _$typebox.TString;
        source: _$typebox.TUnion<[_$typebox.TLiteral<"core">, _$typebox.TLiteral<"plugin">]>;
        pluginId: _$typebox.TOptional<_$typebox.TString>;
        optional: _$typebox.TOptional<_$typebox.TBoolean>;
        risk: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"low">, _$typebox.TLiteral<"medium">, _$typebox.TLiteral<"high">]>>;
        tags: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
        defaultProfiles: _$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"minimal">, _$typebox.TLiteral<"coding">, _$typebox.TLiteral<"messaging">, _$typebox.TLiteral<"full">]>>;
      }>>;
    }>>;
  }>;
  ToolsEffectiveParams: _$typebox.TObject<{
    agentId: _$typebox.TOptional<_$typebox.TString>;
    sessionKey: _$typebox.TString;
  }>;
  ToolsEffectiveEntry: _$typebox.TObject<{
    id: _$typebox.TString;
    label: _$typebox.TString;
    description: _$typebox.TString;
    rawDescription: _$typebox.TString;
    source: _$typebox.TUnion<[_$typebox.TLiteral<"core">, _$typebox.TLiteral<"plugin">, _$typebox.TLiteral<"channel">]>;
    pluginId: _$typebox.TOptional<_$typebox.TString>;
    channelId: _$typebox.TOptional<_$typebox.TString>;
    risk: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"low">, _$typebox.TLiteral<"medium">, _$typebox.TLiteral<"high">]>>;
    tags: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
  }>;
  ToolsEffectiveGroup: _$typebox.TObject<{
    id: _$typebox.TUnion<[_$typebox.TLiteral<"core">, _$typebox.TLiteral<"plugin">, _$typebox.TLiteral<"channel">]>;
    label: _$typebox.TString;
    source: _$typebox.TUnion<[_$typebox.TLiteral<"core">, _$typebox.TLiteral<"plugin">, _$typebox.TLiteral<"channel">]>;
    tools: _$typebox.TArray<_$typebox.TObject<{
      id: _$typebox.TString;
      label: _$typebox.TString;
      description: _$typebox.TString;
      rawDescription: _$typebox.TString;
      source: _$typebox.TUnion<[_$typebox.TLiteral<"core">, _$typebox.TLiteral<"plugin">, _$typebox.TLiteral<"channel">]>;
      pluginId: _$typebox.TOptional<_$typebox.TString>;
      channelId: _$typebox.TOptional<_$typebox.TString>;
      risk: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"low">, _$typebox.TLiteral<"medium">, _$typebox.TLiteral<"high">]>>;
      tags: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    }>>;
  }>;
  ToolsEffectiveResult: _$typebox.TObject<{
    agentId: _$typebox.TString;
    profile: _$typebox.TString;
    groups: _$typebox.TArray<_$typebox.TObject<{
      id: _$typebox.TUnion<[_$typebox.TLiteral<"core">, _$typebox.TLiteral<"plugin">, _$typebox.TLiteral<"channel">]>;
      label: _$typebox.TString;
      source: _$typebox.TUnion<[_$typebox.TLiteral<"core">, _$typebox.TLiteral<"plugin">, _$typebox.TLiteral<"channel">]>;
      tools: _$typebox.TArray<_$typebox.TObject<{
        id: _$typebox.TString;
        label: _$typebox.TString;
        description: _$typebox.TString;
        rawDescription: _$typebox.TString;
        source: _$typebox.TUnion<[_$typebox.TLiteral<"core">, _$typebox.TLiteral<"plugin">, _$typebox.TLiteral<"channel">]>;
        pluginId: _$typebox.TOptional<_$typebox.TString>;
        channelId: _$typebox.TOptional<_$typebox.TString>;
        risk: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"low">, _$typebox.TLiteral<"medium">, _$typebox.TLiteral<"high">]>>;
        tags: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
      }>>;
    }>>;
  }>;
  ToolsInvokeParams: _$typebox.TObject<{
    name: _$typebox.TString;
    args: _$typebox.TOptional<_$typebox.TRecord<"^.*$", _$typebox.TUnknown>>;
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    agentId: _$typebox.TOptional<_$typebox.TString>;
    confirm: _$typebox.TOptional<_$typebox.TBoolean>;
    idempotencyKey: _$typebox.TOptional<_$typebox.TString>;
  }>;
  ToolsInvokeError: _$typebox.TObject<{
    code: _$typebox.TString;
    message: _$typebox.TString;
    details: _$typebox.TOptional<_$typebox.TUnknown>;
  }>;
  ToolsInvokeResult: _$typebox.TObject<{
    ok: _$typebox.TBoolean;
    toolName: _$typebox.TString;
    output: _$typebox.TOptional<_$typebox.TUnknown>;
    requiresApproval: _$typebox.TOptional<_$typebox.TBoolean>;
    approvalId: _$typebox.TOptional<_$typebox.TString>;
    source: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"core">, _$typebox.TLiteral<"plugin">, _$typebox.TLiteral<"mcp">, _$typebox.TLiteral<"channel">, _$typebox.TString]>>;
    error: _$typebox.TOptional<_$typebox.TObject<{
      code: _$typebox.TString;
      message: _$typebox.TString;
      details: _$typebox.TOptional<_$typebox.TUnknown>;
    }>>;
  }>;
  SkillsBinsParams: _$typebox.TObject<{}>;
  SkillsBinsResult: _$typebox.TObject<{
    bins: _$typebox.TArray<_$typebox.TString>;
  }>;
  SkillsSearchParams: _$typebox.TObject<{
    query: _$typebox.TOptional<_$typebox.TString>;
    limit: _$typebox.TOptional<_$typebox.TInteger>;
  }>;
  SkillsSearchResult: _$typebox.TObject<{
    results: _$typebox.TArray<_$typebox.TObject<{
      score: _$typebox.TNumber;
      slug: _$typebox.TString;
      displayName: _$typebox.TString;
      summary: _$typebox.TOptional<_$typebox.TString>;
      version: _$typebox.TOptional<_$typebox.TString>;
      updatedAt: _$typebox.TOptional<_$typebox.TInteger>;
    }>>;
  }>;
  SkillsDetailParams: _$typebox.TObject<{
    slug: _$typebox.TString;
  }>;
  SkillsDetailResult: _$typebox.TObject<{
    skill: _$typebox.TUnion<[_$typebox.TObject<{
      slug: _$typebox.TString;
      displayName: _$typebox.TString;
      summary: _$typebox.TOptional<_$typebox.TString>;
      tags: _$typebox.TOptional<_$typebox.TRecord<"^.*$", _$typebox.TString>>;
      createdAt: _$typebox.TInteger;
      updatedAt: _$typebox.TInteger;
    }>, _$typebox.TNull]>;
    latestVersion: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TObject<{
      version: _$typebox.TString;
      createdAt: _$typebox.TInteger;
      changelog: _$typebox.TOptional<_$typebox.TString>;
    }>, _$typebox.TNull]>>;
    metadata: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TObject<{
      os: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TArray<_$typebox.TString>, _$typebox.TNull]>>;
      systems: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TArray<_$typebox.TString>, _$typebox.TNull]>>;
    }>, _$typebox.TNull]>>;
    owner: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TObject<{
      handle: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
      displayName: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
      image: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    }>, _$typebox.TNull]>>;
  }>;
  SkillsUploadBeginParams: _$typebox.TObject<{
    kind: _$typebox.TLiteral<"skill-archive">;
    slug: _$typebox.TString;
    sizeBytes: _$typebox.TInteger;
    sha256: _$typebox.TOptional<_$typebox.TString>;
    force: _$typebox.TOptional<_$typebox.TBoolean>;
    idempotencyKey: _$typebox.TOptional<_$typebox.TString>;
  }>;
  SkillsUploadChunkParams: _$typebox.TObject<{
    uploadId: _$typebox.TString;
    offset: _$typebox.TInteger;
    dataBase64: _$typebox.TString;
  }>;
  SkillsUploadCommitParams: _$typebox.TObject<{
    uploadId: _$typebox.TString;
    sha256: _$typebox.TOptional<_$typebox.TString>;
  }>;
  SkillsInstallParams: _$typebox.TUnion<[_$typebox.TObject<{
    name: _$typebox.TString;
    installId: _$typebox.TString;
    dangerouslyForceUnsafeInstall: _$typebox.TOptional<_$typebox.TBoolean>;
    timeoutMs: _$typebox.TOptional<_$typebox.TInteger>;
  }>, _$typebox.TObject<{
    source: _$typebox.TLiteral<"clawhub">;
    slug: _$typebox.TString;
    version: _$typebox.TOptional<_$typebox.TString>;
    force: _$typebox.TOptional<_$typebox.TBoolean>;
    timeoutMs: _$typebox.TOptional<_$typebox.TInteger>;
  }>, _$typebox.TObject<{
    source: _$typebox.TLiteral<"upload">;
    uploadId: _$typebox.TString;
    slug: _$typebox.TString;
    force: _$typebox.TOptional<_$typebox.TBoolean>;
    sha256: _$typebox.TOptional<_$typebox.TString>;
    timeoutMs: _$typebox.TOptional<_$typebox.TInteger>;
  }>]>;
  SkillsUpdateParams: _$typebox.TUnion<[_$typebox.TObject<{
    skillKey: _$typebox.TString;
    enabled: _$typebox.TOptional<_$typebox.TBoolean>;
    apiKey: _$typebox.TOptional<_$typebox.TString>;
    env: _$typebox.TOptional<_$typebox.TRecord<"^.*$", _$typebox.TString>>;
  }>, _$typebox.TObject<{
    source: _$typebox.TLiteral<"clawhub">;
    slug: _$typebox.TOptional<_$typebox.TString>;
    all: _$typebox.TOptional<_$typebox.TBoolean>;
  }>]>;
  CronJob: _$typebox.TObject<{
    id: _$typebox.TString;
    agentId: _$typebox.TOptional<_$typebox.TString>;
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    name: _$typebox.TString;
    description: _$typebox.TOptional<_$typebox.TString>;
    enabled: _$typebox.TBoolean;
    deleteAfterRun: _$typebox.TOptional<_$typebox.TBoolean>;
    createdAtMs: _$typebox.TInteger;
    updatedAtMs: _$typebox.TInteger;
    schedule: _$typebox.TUnion<[_$typebox.TObject<{
      kind: _$typebox.TLiteral<"at">;
      at: _$typebox.TString;
    }>, _$typebox.TObject<{
      kind: _$typebox.TLiteral<"every">;
      everyMs: _$typebox.TInteger;
      anchorMs: _$typebox.TOptional<_$typebox.TInteger>;
    }>, _$typebox.TObject<{
      kind: _$typebox.TLiteral<"cron">;
      expr: _$typebox.TString;
      tz: _$typebox.TOptional<_$typebox.TString>;
      staggerMs: _$typebox.TOptional<_$typebox.TInteger>;
    }>]>;
    sessionTarget: _$typebox.TUnion<[_$typebox.TLiteral<"main">, _$typebox.TLiteral<"isolated">, _$typebox.TLiteral<"current">, _$typebox.TString]>;
    wakeMode: _$typebox.TUnion<[_$typebox.TLiteral<"next-heartbeat">, _$typebox.TLiteral<"now">]>;
    payload: _$typebox.TUnion<[_$typebox.TObject<{
      kind: _$typebox.TLiteral<"systemEvent">;
      text: _$typebox.TString;
    }>, _$typebox.TObject<{
      kind: _$typebox.TLiteral<"agentTurn">;
      message: TSchema;
      model: _$typebox.TOptional<_$typebox.TString>;
      fallbacks: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
      thinking: _$typebox.TOptional<_$typebox.TString>;
      timeoutSeconds: _$typebox.TOptional<_$typebox.TNumber>;
      allowUnsafeExternalContent: _$typebox.TOptional<_$typebox.TBoolean>;
      lightContext: _$typebox.TOptional<_$typebox.TBoolean>;
      toolsAllow: _$typebox.TOptional<TSchema>;
    }>]>;
    delivery: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TObject<{
      to: _$typebox.TOptional<_$typebox.TString>;
      channel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"last">, _$typebox.TString]>>;
      threadId: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNumber]>>;
      accountId: _$typebox.TOptional<_$typebox.TString>;
      bestEffort: _$typebox.TOptional<_$typebox.TBoolean>;
      failureDestination: _$typebox.TOptional<_$typebox.TObject<{
        channel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"last">, _$typebox.TString]>>;
        to: _$typebox.TOptional<_$typebox.TString>;
        accountId: _$typebox.TOptional<_$typebox.TString>;
        mode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"announce">, _$typebox.TLiteral<"webhook">]>>;
      }>>;
      mode: _$typebox.TLiteral<"none">;
    }>, _$typebox.TObject<{
      to: _$typebox.TOptional<_$typebox.TString>;
      channel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"last">, _$typebox.TString]>>;
      threadId: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNumber]>>;
      accountId: _$typebox.TOptional<_$typebox.TString>;
      bestEffort: _$typebox.TOptional<_$typebox.TBoolean>;
      failureDestination: _$typebox.TOptional<_$typebox.TObject<{
        channel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"last">, _$typebox.TString]>>;
        to: _$typebox.TOptional<_$typebox.TString>;
        accountId: _$typebox.TOptional<_$typebox.TString>;
        mode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"announce">, _$typebox.TLiteral<"webhook">]>>;
      }>>;
      mode: _$typebox.TLiteral<"announce">;
    }>, _$typebox.TObject<{
      to: _$typebox.TString;
      channel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"last">, _$typebox.TString]>>;
      threadId: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNumber]>>;
      accountId: _$typebox.TOptional<_$typebox.TString>;
      bestEffort: _$typebox.TOptional<_$typebox.TBoolean>;
      failureDestination: _$typebox.TOptional<_$typebox.TObject<{
        channel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"last">, _$typebox.TString]>>;
        to: _$typebox.TOptional<_$typebox.TString>;
        accountId: _$typebox.TOptional<_$typebox.TString>;
        mode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"announce">, _$typebox.TLiteral<"webhook">]>>;
      }>>;
      mode: _$typebox.TLiteral<"webhook">;
    }>]>>;
    failureAlert: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<false>, _$typebox.TObject<{
      after: _$typebox.TOptional<_$typebox.TInteger>;
      channel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"last">, _$typebox.TString]>>;
      to: _$typebox.TOptional<_$typebox.TString>;
      cooldownMs: _$typebox.TOptional<_$typebox.TInteger>;
      includeSkipped: _$typebox.TOptional<_$typebox.TBoolean>;
      mode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"announce">, _$typebox.TLiteral<"webhook">]>>;
      accountId: _$typebox.TOptional<_$typebox.TString>;
    }>]>>;
    state: _$typebox.TObject<{
      nextRunAtMs: _$typebox.TOptional<_$typebox.TInteger>;
      runningAtMs: _$typebox.TOptional<_$typebox.TInteger>;
      lastRunAtMs: _$typebox.TOptional<_$typebox.TInteger>;
      lastRunStatus: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"ok">, _$typebox.TLiteral<"error">, _$typebox.TLiteral<"skipped">]>>;
      lastStatus: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"ok">, _$typebox.TLiteral<"error">, _$typebox.TLiteral<"skipped">]>>;
      lastError: _$typebox.TOptional<_$typebox.TString>;
      lastDiagnostics: _$typebox.TOptional<_$typebox.TObject<{
        summary: _$typebox.TOptional<_$typebox.TString>;
        entries: _$typebox.TArray<_$typebox.TObject<{
          ts: _$typebox.TInteger;
          source: _$typebox.TUnion<[_$typebox.TLiteral<"cron-preflight">, _$typebox.TLiteral<"cron-setup">, _$typebox.TLiteral<"model-preflight">, _$typebox.TLiteral<"agent-run">, _$typebox.TLiteral<"tool">, _$typebox.TLiteral<"exec">, _$typebox.TLiteral<"delivery">]>;
          severity: _$typebox.TUnion<[_$typebox.TLiteral<"info">, _$typebox.TLiteral<"warn">, _$typebox.TLiteral<"error">]>;
          message: _$typebox.TString;
          toolName: _$typebox.TOptional<_$typebox.TString>;
          exitCode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TNumber, _$typebox.TNull]>>;
          truncated: _$typebox.TOptional<_$typebox.TBoolean>;
        }>>;
      }>>;
      lastDiagnosticSummary: _$typebox.TOptional<_$typebox.TString>;
      lastErrorReason: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"auth">, _$typebox.TLiteral<"format">, _$typebox.TLiteral<"rate_limit">, _$typebox.TLiteral<"billing">, _$typebox.TLiteral<"server_error">, _$typebox.TLiteral<"timeout">, _$typebox.TLiteral<"model_not_found">, _$typebox.TLiteral<"empty_response">, _$typebox.TLiteral<"no_error_details">, _$typebox.TLiteral<"unclassified">, _$typebox.TLiteral<"unknown">]>>;
      lastDurationMs: _$typebox.TOptional<_$typebox.TInteger>;
      consecutiveErrors: _$typebox.TOptional<_$typebox.TInteger>;
      consecutiveSkipped: _$typebox.TOptional<_$typebox.TInteger>;
      lastDelivered: _$typebox.TOptional<_$typebox.TBoolean>;
      lastDeliveryStatus: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"delivered">, _$typebox.TLiteral<"not-delivered">, _$typebox.TLiteral<"unknown">, _$typebox.TLiteral<"not-requested">]>>;
      lastDeliveryError: _$typebox.TOptional<_$typebox.TString>;
      lastFailureAlertAtMs: _$typebox.TOptional<_$typebox.TInteger>;
    }>;
  }>;
  CronListParams: _$typebox.TObject<{
    includeDisabled: _$typebox.TOptional<_$typebox.TBoolean>;
    limit: _$typebox.TOptional<_$typebox.TInteger>;
    offset: _$typebox.TOptional<_$typebox.TInteger>;
    query: _$typebox.TOptional<_$typebox.TString>;
    enabled: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"all">, _$typebox.TLiteral<"enabled">, _$typebox.TLiteral<"disabled">]>>;
    sortBy: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"nextRunAtMs">, _$typebox.TLiteral<"updatedAtMs">, _$typebox.TLiteral<"name">]>>;
    sortDir: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"asc">, _$typebox.TLiteral<"desc">]>>;
    agentId: _$typebox.TOptional<_$typebox.TString>;
  }>;
  CronStatusParams: _$typebox.TObject<{}>;
  CronGetParams: _$typebox.TUnion<[_$typebox.TObject<{
    id: _$typebox.TString;
  }>, _$typebox.TObject<{
    jobId: _$typebox.TString;
  }>]>;
  CronAddParams: _$typebox.TObject<{
    schedule: _$typebox.TUnion<[_$typebox.TObject<{
      kind: _$typebox.TLiteral<"at">;
      at: _$typebox.TString;
    }>, _$typebox.TObject<{
      kind: _$typebox.TLiteral<"every">;
      everyMs: _$typebox.TInteger;
      anchorMs: _$typebox.TOptional<_$typebox.TInteger>;
    }>, _$typebox.TObject<{
      kind: _$typebox.TLiteral<"cron">;
      expr: _$typebox.TString;
      tz: _$typebox.TOptional<_$typebox.TString>;
      staggerMs: _$typebox.TOptional<_$typebox.TInteger>;
    }>]>;
    sessionTarget: _$typebox.TUnion<[_$typebox.TLiteral<"main">, _$typebox.TLiteral<"isolated">, _$typebox.TLiteral<"current">, _$typebox.TString]>;
    wakeMode: _$typebox.TUnion<[_$typebox.TLiteral<"next-heartbeat">, _$typebox.TLiteral<"now">]>;
    payload: _$typebox.TUnion<[_$typebox.TObject<{
      kind: _$typebox.TLiteral<"systemEvent">;
      text: _$typebox.TString;
    }>, _$typebox.TObject<{
      kind: _$typebox.TLiteral<"agentTurn">;
      message: TSchema;
      model: _$typebox.TOptional<_$typebox.TString>;
      fallbacks: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
      thinking: _$typebox.TOptional<_$typebox.TString>;
      timeoutSeconds: _$typebox.TOptional<_$typebox.TNumber>;
      allowUnsafeExternalContent: _$typebox.TOptional<_$typebox.TBoolean>;
      lightContext: _$typebox.TOptional<_$typebox.TBoolean>;
      toolsAllow: _$typebox.TOptional<TSchema>;
    }>]>;
    delivery: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TObject<{
      to: _$typebox.TOptional<_$typebox.TString>;
      channel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"last">, _$typebox.TString]>>;
      threadId: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNumber]>>;
      accountId: _$typebox.TOptional<_$typebox.TString>;
      bestEffort: _$typebox.TOptional<_$typebox.TBoolean>;
      failureDestination: _$typebox.TOptional<_$typebox.TObject<{
        channel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"last">, _$typebox.TString]>>;
        to: _$typebox.TOptional<_$typebox.TString>;
        accountId: _$typebox.TOptional<_$typebox.TString>;
        mode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"announce">, _$typebox.TLiteral<"webhook">]>>;
      }>>;
      mode: _$typebox.TLiteral<"none">;
    }>, _$typebox.TObject<{
      to: _$typebox.TOptional<_$typebox.TString>;
      channel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"last">, _$typebox.TString]>>;
      threadId: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNumber]>>;
      accountId: _$typebox.TOptional<_$typebox.TString>;
      bestEffort: _$typebox.TOptional<_$typebox.TBoolean>;
      failureDestination: _$typebox.TOptional<_$typebox.TObject<{
        channel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"last">, _$typebox.TString]>>;
        to: _$typebox.TOptional<_$typebox.TString>;
        accountId: _$typebox.TOptional<_$typebox.TString>;
        mode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"announce">, _$typebox.TLiteral<"webhook">]>>;
      }>>;
      mode: _$typebox.TLiteral<"announce">;
    }>, _$typebox.TObject<{
      to: _$typebox.TString;
      channel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"last">, _$typebox.TString]>>;
      threadId: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNumber]>>;
      accountId: _$typebox.TOptional<_$typebox.TString>;
      bestEffort: _$typebox.TOptional<_$typebox.TBoolean>;
      failureDestination: _$typebox.TOptional<_$typebox.TObject<{
        channel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"last">, _$typebox.TString]>>;
        to: _$typebox.TOptional<_$typebox.TString>;
        accountId: _$typebox.TOptional<_$typebox.TString>;
        mode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"announce">, _$typebox.TLiteral<"webhook">]>>;
      }>>;
      mode: _$typebox.TLiteral<"webhook">;
    }>]>>;
    failureAlert: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<false>, _$typebox.TObject<{
      after: _$typebox.TOptional<_$typebox.TInteger>;
      channel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"last">, _$typebox.TString]>>;
      to: _$typebox.TOptional<_$typebox.TString>;
      cooldownMs: _$typebox.TOptional<_$typebox.TInteger>;
      includeSkipped: _$typebox.TOptional<_$typebox.TBoolean>;
      mode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"announce">, _$typebox.TLiteral<"webhook">]>>;
      accountId: _$typebox.TOptional<_$typebox.TString>;
    }>]>>;
    agentId: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    sessionKey: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    description: _$typebox.TOptional<_$typebox.TString>;
    enabled: _$typebox.TOptional<_$typebox.TBoolean>;
    deleteAfterRun: _$typebox.TOptional<_$typebox.TBoolean>;
    name: _$typebox.TString;
  }>;
  CronUpdateParams: _$typebox.TUnion<[_$typebox.TObject<{
    id: _$typebox.TString;
  }>, _$typebox.TObject<{
    jobId: _$typebox.TString;
  }>]>;
  CronRemoveParams: _$typebox.TUnion<[_$typebox.TObject<{
    id: _$typebox.TString;
  }>, _$typebox.TObject<{
    jobId: _$typebox.TString;
  }>]>;
  CronRunParams: _$typebox.TUnion<[_$typebox.TObject<{
    id: _$typebox.TString;
  }>, _$typebox.TObject<{
    jobId: _$typebox.TString;
  }>]>;
  CronRunsParams: _$typebox.TObject<{
    scope: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"job">, _$typebox.TLiteral<"all">]>>;
    id: _$typebox.TOptional<_$typebox.TString>;
    jobId: _$typebox.TOptional<_$typebox.TString>;
    limit: _$typebox.TOptional<_$typebox.TInteger>;
    offset: _$typebox.TOptional<_$typebox.TInteger>;
    statuses: _$typebox.TOptional<_$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"ok">, _$typebox.TLiteral<"error">, _$typebox.TLiteral<"skipped">]>>>;
    status: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"all">, _$typebox.TLiteral<"ok">, _$typebox.TLiteral<"error">, _$typebox.TLiteral<"skipped">]>>;
    deliveryStatuses: _$typebox.TOptional<_$typebox.TArray<_$typebox.TUnion<[_$typebox.TLiteral<"delivered">, _$typebox.TLiteral<"not-delivered">, _$typebox.TLiteral<"unknown">, _$typebox.TLiteral<"not-requested">]>>>;
    deliveryStatus: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"delivered">, _$typebox.TLiteral<"not-delivered">, _$typebox.TLiteral<"unknown">, _$typebox.TLiteral<"not-requested">]>>;
    query: _$typebox.TOptional<_$typebox.TString>;
    sortDir: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"asc">, _$typebox.TLiteral<"desc">]>>;
  }>;
  CronRunLogEntry: _$typebox.TObject<{
    ts: _$typebox.TInteger;
    jobId: _$typebox.TString;
    action: _$typebox.TLiteral<"finished">;
    status: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"ok">, _$typebox.TLiteral<"error">, _$typebox.TLiteral<"skipped">]>>;
    error: _$typebox.TOptional<_$typebox.TString>;
    summary: _$typebox.TOptional<_$typebox.TString>;
    diagnostics: _$typebox.TOptional<_$typebox.TObject<{
      summary: _$typebox.TOptional<_$typebox.TString>;
      entries: _$typebox.TArray<_$typebox.TObject<{
        ts: _$typebox.TInteger;
        source: _$typebox.TUnion<[_$typebox.TLiteral<"cron-preflight">, _$typebox.TLiteral<"cron-setup">, _$typebox.TLiteral<"model-preflight">, _$typebox.TLiteral<"agent-run">, _$typebox.TLiteral<"tool">, _$typebox.TLiteral<"exec">, _$typebox.TLiteral<"delivery">]>;
        severity: _$typebox.TUnion<[_$typebox.TLiteral<"info">, _$typebox.TLiteral<"warn">, _$typebox.TLiteral<"error">]>;
        message: _$typebox.TString;
        toolName: _$typebox.TOptional<_$typebox.TString>;
        exitCode: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TNumber, _$typebox.TNull]>>;
        truncated: _$typebox.TOptional<_$typebox.TBoolean>;
      }>>;
    }>>;
    delivered: _$typebox.TOptional<_$typebox.TBoolean>;
    deliveryStatus: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"delivered">, _$typebox.TLiteral<"not-delivered">, _$typebox.TLiteral<"unknown">, _$typebox.TLiteral<"not-requested">]>>;
    deliveryError: _$typebox.TOptional<_$typebox.TString>;
    sessionId: _$typebox.TOptional<_$typebox.TString>;
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    runId: _$typebox.TOptional<_$typebox.TString>;
    runAtMs: _$typebox.TOptional<_$typebox.TInteger>;
    durationMs: _$typebox.TOptional<_$typebox.TInteger>;
    nextRunAtMs: _$typebox.TOptional<_$typebox.TInteger>;
    model: _$typebox.TOptional<_$typebox.TString>;
    provider: _$typebox.TOptional<_$typebox.TString>;
    usage: _$typebox.TOptional<_$typebox.TObject<{
      input_tokens: _$typebox.TOptional<_$typebox.TNumber>;
      output_tokens: _$typebox.TOptional<_$typebox.TNumber>;
      total_tokens: _$typebox.TOptional<_$typebox.TNumber>;
      cache_read_tokens: _$typebox.TOptional<_$typebox.TNumber>;
      cache_write_tokens: _$typebox.TOptional<_$typebox.TNumber>;
    }>>;
    jobName: _$typebox.TOptional<_$typebox.TString>;
  }>;
  LogsTailParams: _$typebox.TObject<{
    cursor: _$typebox.TOptional<_$typebox.TInteger>;
    limit: _$typebox.TOptional<_$typebox.TInteger>;
    maxBytes: _$typebox.TOptional<_$typebox.TInteger>;
  }>;
  LogsTailResult: _$typebox.TObject<{
    file: _$typebox.TString;
    cursor: _$typebox.TInteger;
    size: _$typebox.TInteger;
    lines: _$typebox.TArray<_$typebox.TString>;
    truncated: _$typebox.TOptional<_$typebox.TBoolean>;
    reset: _$typebox.TOptional<_$typebox.TBoolean>;
  }>;
  ExecApprovalsGetParams: _$typebox.TObject<{}>;
  ExecApprovalsSetParams: _$typebox.TObject<{
    file: _$typebox.TObject<{
      version: _$typebox.TLiteral<1>;
      socket: _$typebox.TOptional<_$typebox.TObject<{
        path: _$typebox.TOptional<_$typebox.TString>;
        token: _$typebox.TOptional<_$typebox.TString>;
      }>>;
      defaults: _$typebox.TOptional<_$typebox.TObject<{
        security: _$typebox.TOptional<_$typebox.TString>;
        ask: _$typebox.TOptional<_$typebox.TString>;
        askFallback: _$typebox.TOptional<_$typebox.TString>;
        autoAllowSkills: _$typebox.TOptional<_$typebox.TBoolean>;
      }>>;
      agents: _$typebox.TOptional<_$typebox.TRecord<"^.*$", _$typebox.TObject<{
        allowlist: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
          id: _$typebox.TOptional<_$typebox.TString>;
          pattern: _$typebox.TString;
          source: _$typebox.TOptional<_$typebox.TLiteral<"allow-always">>;
          commandText: _$typebox.TOptional<_$typebox.TString>;
          argPattern: _$typebox.TOptional<_$typebox.TString>;
          lastUsedAt: _$typebox.TOptional<_$typebox.TInteger>;
          lastUsedCommand: _$typebox.TOptional<_$typebox.TString>;
          lastResolvedPath: _$typebox.TOptional<_$typebox.TString>;
        }>>>;
        security: _$typebox.TOptional<_$typebox.TString>;
        ask: _$typebox.TOptional<_$typebox.TString>;
        askFallback: _$typebox.TOptional<_$typebox.TString>;
        autoAllowSkills: _$typebox.TOptional<_$typebox.TBoolean>;
      }>>>;
    }>;
    baseHash: _$typebox.TOptional<_$typebox.TString>;
  }>;
  ExecApprovalsNodeGetParams: _$typebox.TObject<{
    nodeId: _$typebox.TString;
  }>;
  ExecApprovalsNodeSetParams: _$typebox.TObject<{
    nodeId: _$typebox.TString;
    file: _$typebox.TObject<{
      version: _$typebox.TLiteral<1>;
      socket: _$typebox.TOptional<_$typebox.TObject<{
        path: _$typebox.TOptional<_$typebox.TString>;
        token: _$typebox.TOptional<_$typebox.TString>;
      }>>;
      defaults: _$typebox.TOptional<_$typebox.TObject<{
        security: _$typebox.TOptional<_$typebox.TString>;
        ask: _$typebox.TOptional<_$typebox.TString>;
        askFallback: _$typebox.TOptional<_$typebox.TString>;
        autoAllowSkills: _$typebox.TOptional<_$typebox.TBoolean>;
      }>>;
      agents: _$typebox.TOptional<_$typebox.TRecord<"^.*$", _$typebox.TObject<{
        allowlist: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
          id: _$typebox.TOptional<_$typebox.TString>;
          pattern: _$typebox.TString;
          source: _$typebox.TOptional<_$typebox.TLiteral<"allow-always">>;
          commandText: _$typebox.TOptional<_$typebox.TString>;
          argPattern: _$typebox.TOptional<_$typebox.TString>;
          lastUsedAt: _$typebox.TOptional<_$typebox.TInteger>;
          lastUsedCommand: _$typebox.TOptional<_$typebox.TString>;
          lastResolvedPath: _$typebox.TOptional<_$typebox.TString>;
        }>>>;
        security: _$typebox.TOptional<_$typebox.TString>;
        ask: _$typebox.TOptional<_$typebox.TString>;
        askFallback: _$typebox.TOptional<_$typebox.TString>;
        autoAllowSkills: _$typebox.TOptional<_$typebox.TBoolean>;
      }>>>;
    }>;
    baseHash: _$typebox.TOptional<_$typebox.TString>;
  }>;
  ExecApprovalsSnapshot: _$typebox.TObject<{
    path: _$typebox.TString;
    exists: _$typebox.TBoolean;
    hash: _$typebox.TString;
    file: _$typebox.TObject<{
      version: _$typebox.TLiteral<1>;
      socket: _$typebox.TOptional<_$typebox.TObject<{
        path: _$typebox.TOptional<_$typebox.TString>;
        token: _$typebox.TOptional<_$typebox.TString>;
      }>>;
      defaults: _$typebox.TOptional<_$typebox.TObject<{
        security: _$typebox.TOptional<_$typebox.TString>;
        ask: _$typebox.TOptional<_$typebox.TString>;
        askFallback: _$typebox.TOptional<_$typebox.TString>;
        autoAllowSkills: _$typebox.TOptional<_$typebox.TBoolean>;
      }>>;
      agents: _$typebox.TOptional<_$typebox.TRecord<"^.*$", _$typebox.TObject<{
        allowlist: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
          id: _$typebox.TOptional<_$typebox.TString>;
          pattern: _$typebox.TString;
          source: _$typebox.TOptional<_$typebox.TLiteral<"allow-always">>;
          commandText: _$typebox.TOptional<_$typebox.TString>;
          argPattern: _$typebox.TOptional<_$typebox.TString>;
          lastUsedAt: _$typebox.TOptional<_$typebox.TInteger>;
          lastUsedCommand: _$typebox.TOptional<_$typebox.TString>;
          lastResolvedPath: _$typebox.TOptional<_$typebox.TString>;
        }>>>;
        security: _$typebox.TOptional<_$typebox.TString>;
        ask: _$typebox.TOptional<_$typebox.TString>;
        askFallback: _$typebox.TOptional<_$typebox.TString>;
        autoAllowSkills: _$typebox.TOptional<_$typebox.TBoolean>;
      }>>>;
    }>;
  }>;
  ExecApprovalGetParams: _$typebox.TObject<{
    id: _$typebox.TString;
  }>;
  ExecApprovalRequestParams: _$typebox.TObject<{
    id: _$typebox.TOptional<_$typebox.TString>;
    command: _$typebox.TOptional<_$typebox.TString>;
    commandArgv: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    systemRunPlan: _$typebox.TOptional<_$typebox.TObject<{
      argv: _$typebox.TArray<_$typebox.TString>;
      cwd: _$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>;
      commandText: _$typebox.TString;
      commandPreview: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
      agentId: _$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>;
      sessionKey: _$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>;
      mutableFileOperand: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TObject<{
        argvIndex: _$typebox.TInteger;
        path: _$typebox.TString;
        sha256: _$typebox.TString;
      }>, _$typebox.TNull]>>;
    }>>;
    env: _$typebox.TOptional<_$typebox.TRecord<"^.*$", _$typebox.TString>>;
    cwd: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    nodeId: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    host: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    security: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    ask: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    warningText: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    commandSpans: _$typebox.TOptional<_$typebox.TArray<_$typebox.TObject<{
      startIndex: _$typebox.TInteger;
      endIndex: _$typebox.TInteger;
    }>>>;
    agentId: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    resolvedPath: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    sessionKey: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    turnSourceChannel: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    turnSourceTo: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    turnSourceAccountId: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNull]>>;
    turnSourceThreadId: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNumber, _$typebox.TNull]>>;
    timeoutMs: _$typebox.TOptional<_$typebox.TInteger>;
    twoPhase: _$typebox.TOptional<_$typebox.TBoolean>;
  }>;
  ExecApprovalResolveParams: _$typebox.TObject<{
    id: _$typebox.TString;
    decision: _$typebox.TString;
  }>;
  PluginApprovalRequestParams: _$typebox.TObject<{
    pluginId: _$typebox.TOptional<_$typebox.TString>;
    title: _$typebox.TString;
    description: _$typebox.TString;
    severity: _$typebox.TOptional<_$typebox.TString>;
    toolName: _$typebox.TOptional<_$typebox.TString>;
    toolCallId: _$typebox.TOptional<_$typebox.TString>;
    allowedDecisions: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    agentId: _$typebox.TOptional<_$typebox.TString>;
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    turnSourceChannel: _$typebox.TOptional<_$typebox.TString>;
    turnSourceTo: _$typebox.TOptional<_$typebox.TString>;
    turnSourceAccountId: _$typebox.TOptional<_$typebox.TString>;
    turnSourceThreadId: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNumber]>>;
    timeoutMs: _$typebox.TOptional<_$typebox.TInteger>;
    twoPhase: _$typebox.TOptional<_$typebox.TBoolean>;
  }>;
  PluginApprovalResolveParams: _$typebox.TObject<{
    id: _$typebox.TString;
    decision: _$typebox.TString;
  }>;
  PluginControlUiDescriptor: _$typebox.TObject<{
    id: _$typebox.TString;
    pluginId: _$typebox.TString;
    pluginName: _$typebox.TOptional<_$typebox.TString>;
    surface: _$typebox.TUnion<[_$typebox.TLiteral<"session">, _$typebox.TLiteral<"tool">, _$typebox.TLiteral<"run">, _$typebox.TLiteral<"settings">]>;
    label: _$typebox.TString;
    description: _$typebox.TOptional<_$typebox.TString>;
    placement: _$typebox.TOptional<_$typebox.TString>;
    schema: _$typebox.TOptional<_$typebox.TUnknown>;
    requiredScopes: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
  }>;
  PluginsSessionActionFailureResult: _$typebox.TObject<{
    ok: _$typebox.TLiteral<false>;
    error: _$typebox.TString;
    code: _$typebox.TOptional<_$typebox.TString>;
    details: _$typebox.TOptional<_$typebox.TUnknown>;
  }>;
  PluginsSessionActionParams: _$typebox.TObject<{
    pluginId: _$typebox.TString;
    actionId: _$typebox.TString;
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    payload: _$typebox.TOptional<_$typebox.TUnknown>;
  }>;
  PluginsSessionActionResult: _$typebox.TUnion<[_$typebox.TObject<{
    ok: _$typebox.TLiteral<true>;
    result: _$typebox.TOptional<_$typebox.TUnknown>;
    continueAgent: _$typebox.TOptional<_$typebox.TBoolean>;
    reply: _$typebox.TOptional<_$typebox.TUnknown>;
  }>, _$typebox.TObject<{
    ok: _$typebox.TLiteral<false>;
    error: _$typebox.TString;
    code: _$typebox.TOptional<_$typebox.TString>;
    details: _$typebox.TOptional<_$typebox.TUnknown>;
  }>]>;
  PluginsSessionActionSuccessResult: _$typebox.TObject<{
    ok: _$typebox.TLiteral<true>;
    result: _$typebox.TOptional<_$typebox.TUnknown>;
    continueAgent: _$typebox.TOptional<_$typebox.TBoolean>;
    reply: _$typebox.TOptional<_$typebox.TUnknown>;
  }>;
  PluginsUiDescriptorsParams: _$typebox.TObject<{}>;
  PluginsUiDescriptorsResult: _$typebox.TObject<{
    ok: _$typebox.TLiteral<true>;
    descriptors: _$typebox.TArray<_$typebox.TObject<{
      id: _$typebox.TString;
      pluginId: _$typebox.TString;
      pluginName: _$typebox.TOptional<_$typebox.TString>;
      surface: _$typebox.TUnion<[_$typebox.TLiteral<"session">, _$typebox.TLiteral<"tool">, _$typebox.TLiteral<"run">, _$typebox.TLiteral<"settings">]>;
      label: _$typebox.TString;
      description: _$typebox.TOptional<_$typebox.TString>;
      placement: _$typebox.TOptional<_$typebox.TString>;
      schema: _$typebox.TOptional<_$typebox.TUnknown>;
      requiredScopes: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    }>>;
  }>;
  DevicePairListParams: _$typebox.TObject<{}>;
  DevicePairApproveParams: _$typebox.TObject<{
    requestId: _$typebox.TString;
  }>;
  DevicePairRejectParams: _$typebox.TObject<{
    requestId: _$typebox.TString;
  }>;
  DevicePairRemoveParams: _$typebox.TObject<{
    deviceId: _$typebox.TString;
  }>;
  DeviceTokenRotateParams: _$typebox.TObject<{
    deviceId: _$typebox.TString;
    role: _$typebox.TString;
    scopes: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
  }>;
  DeviceTokenRevokeParams: _$typebox.TObject<{
    deviceId: _$typebox.TString;
    role: _$typebox.TString;
  }>;
  DevicePairRequestedEvent: _$typebox.TObject<{
    requestId: _$typebox.TString;
    deviceId: _$typebox.TString;
    publicKey: _$typebox.TString;
    displayName: _$typebox.TOptional<_$typebox.TString>;
    platform: _$typebox.TOptional<_$typebox.TString>;
    deviceFamily: _$typebox.TOptional<_$typebox.TString>;
    clientId: _$typebox.TOptional<_$typebox.TString>;
    clientMode: _$typebox.TOptional<_$typebox.TString>;
    role: _$typebox.TOptional<_$typebox.TString>;
    roles: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    scopes: _$typebox.TOptional<_$typebox.TArray<_$typebox.TString>>;
    remoteIp: _$typebox.TOptional<_$typebox.TString>;
    silent: _$typebox.TOptional<_$typebox.TBoolean>;
    isRepair: _$typebox.TOptional<_$typebox.TBoolean>;
    ts: _$typebox.TInteger;
  }>;
  DevicePairResolvedEvent: _$typebox.TObject<{
    requestId: _$typebox.TString;
    deviceId: _$typebox.TString;
    decision: _$typebox.TString;
    ts: _$typebox.TInteger;
  }>;
  ChatHistoryParams: _$typebox.TObject<{
    sessionKey: _$typebox.TString;
    limit: _$typebox.TOptional<_$typebox.TInteger>;
    maxChars: _$typebox.TOptional<_$typebox.TInteger>;
  }>;
  ChatSendParams: _$typebox.TObject<{
    sessionKey: _$typebox.TString;
    sessionId: _$typebox.TOptional<_$typebox.TString>;
    message: _$typebox.TString;
    thinking: _$typebox.TOptional<_$typebox.TString>;
    fastMode: _$typebox.TOptional<_$typebox.TBoolean>;
    deliver: _$typebox.TOptional<_$typebox.TBoolean>;
    originatingChannel: _$typebox.TOptional<_$typebox.TString>;
    originatingTo: _$typebox.TOptional<_$typebox.TString>;
    originatingAccountId: _$typebox.TOptional<_$typebox.TString>;
    originatingThreadId: _$typebox.TOptional<_$typebox.TString>;
    attachments: _$typebox.TOptional<_$typebox.TArray<_$typebox.TUnknown>>;
    timeoutMs: _$typebox.TOptional<_$typebox.TInteger>;
    systemInputProvenance: _$typebox.TOptional<_$typebox.TObject<{
      kind: _$typebox.TString;
      originSessionId: _$typebox.TOptional<_$typebox.TString>;
      sourceSessionKey: _$typebox.TOptional<_$typebox.TString>;
      sourceChannel: _$typebox.TOptional<_$typebox.TString>;
      sourceTool: _$typebox.TOptional<_$typebox.TString>;
    }>>;
    systemProvenanceReceipt: _$typebox.TOptional<_$typebox.TString>;
    idempotencyKey: _$typebox.TString;
  }>;
  ChatAbortParams: _$typebox.TObject<{
    sessionKey: _$typebox.TString;
    runId: _$typebox.TOptional<_$typebox.TString>;
  }>;
  ChatInjectParams: _$typebox.TObject<{
    sessionKey: _$typebox.TString;
    message: _$typebox.TString;
    label: _$typebox.TOptional<_$typebox.TString>;
  }>;
  ChatDeltaEvent: _$typebox.TObject<{
    state: _$typebox.TLiteral<"delta">;
    message: _$typebox.TOptional<_$typebox.TUnknown>;
    deltaText: _$typebox.TString;
    replace: _$typebox.TOptional<_$typebox.TBoolean>;
    usage: _$typebox.TOptional<_$typebox.TUnknown>;
    runId: _$typebox.TString;
    sessionKey: _$typebox.TString;
    spawnedBy: _$typebox.TOptional<_$typebox.TString>;
    seq: _$typebox.TInteger;
  }>;
  ChatFinalEvent: _$typebox.TObject<{
    state: _$typebox.TLiteral<"final">;
    message: _$typebox.TOptional<_$typebox.TUnknown>;
    usage: _$typebox.TOptional<_$typebox.TUnknown>;
    stopReason: _$typebox.TOptional<_$typebox.TString>;
    runId: _$typebox.TString;
    sessionKey: _$typebox.TString;
    spawnedBy: _$typebox.TOptional<_$typebox.TString>;
    seq: _$typebox.TInteger;
  }>;
  ChatAbortedEvent: _$typebox.TObject<{
    state: _$typebox.TLiteral<"aborted">;
    message: _$typebox.TOptional<_$typebox.TUnknown>;
    stopReason: _$typebox.TOptional<_$typebox.TString>;
    runId: _$typebox.TString;
    sessionKey: _$typebox.TString;
    spawnedBy: _$typebox.TOptional<_$typebox.TString>;
    seq: _$typebox.TInteger;
  }>;
  ChatErrorEvent: _$typebox.TObject<{
    state: _$typebox.TLiteral<"error">;
    message: _$typebox.TOptional<_$typebox.TUnknown>;
    errorMessage: _$typebox.TOptional<_$typebox.TString>;
    errorKind: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"refusal">, _$typebox.TLiteral<"timeout">, _$typebox.TLiteral<"rate_limit">, _$typebox.TLiteral<"context_length">, _$typebox.TLiteral<"unknown">]>>;
    usage: _$typebox.TOptional<_$typebox.TUnknown>;
    stopReason: _$typebox.TOptional<_$typebox.TString>;
    runId: _$typebox.TString;
    sessionKey: _$typebox.TString;
    spawnedBy: _$typebox.TOptional<_$typebox.TString>;
    seq: _$typebox.TInteger;
  }>;
  ChatEvent: _$typebox.TUnion<[_$typebox.TObject<{
    state: _$typebox.TLiteral<"delta">;
    message: _$typebox.TOptional<_$typebox.TUnknown>;
    deltaText: _$typebox.TString;
    replace: _$typebox.TOptional<_$typebox.TBoolean>;
    usage: _$typebox.TOptional<_$typebox.TUnknown>;
    runId: _$typebox.TString;
    sessionKey: _$typebox.TString;
    spawnedBy: _$typebox.TOptional<_$typebox.TString>;
    seq: _$typebox.TInteger;
  }>, _$typebox.TObject<{
    state: _$typebox.TLiteral<"final">;
    message: _$typebox.TOptional<_$typebox.TUnknown>;
    usage: _$typebox.TOptional<_$typebox.TUnknown>;
    stopReason: _$typebox.TOptional<_$typebox.TString>;
    runId: _$typebox.TString;
    sessionKey: _$typebox.TString;
    spawnedBy: _$typebox.TOptional<_$typebox.TString>;
    seq: _$typebox.TInteger;
  }>, _$typebox.TObject<{
    state: _$typebox.TLiteral<"aborted">;
    message: _$typebox.TOptional<_$typebox.TUnknown>;
    stopReason: _$typebox.TOptional<_$typebox.TString>;
    runId: _$typebox.TString;
    sessionKey: _$typebox.TString;
    spawnedBy: _$typebox.TOptional<_$typebox.TString>;
    seq: _$typebox.TInteger;
  }>, _$typebox.TObject<{
    state: _$typebox.TLiteral<"error">;
    message: _$typebox.TOptional<_$typebox.TUnknown>;
    errorMessage: _$typebox.TOptional<_$typebox.TString>;
    errorKind: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TLiteral<"refusal">, _$typebox.TLiteral<"timeout">, _$typebox.TLiteral<"rate_limit">, _$typebox.TLiteral<"context_length">, _$typebox.TLiteral<"unknown">]>>;
    usage: _$typebox.TOptional<_$typebox.TUnknown>;
    stopReason: _$typebox.TOptional<_$typebox.TString>;
    runId: _$typebox.TString;
    sessionKey: _$typebox.TString;
    spawnedBy: _$typebox.TOptional<_$typebox.TString>;
    seq: _$typebox.TInteger;
  }>]>;
  UpdateStatusParams: _$typebox.TObject<{}>;
  UpdateRunParams: _$typebox.TObject<{
    sessionKey: _$typebox.TOptional<_$typebox.TString>;
    deliveryContext: _$typebox.TOptional<_$typebox.TObject<{
      channel: _$typebox.TOptional<_$typebox.TString>;
      to: _$typebox.TOptional<_$typebox.TString>;
      accountId: _$typebox.TOptional<_$typebox.TString>;
      threadId: _$typebox.TOptional<_$typebox.TUnion<[_$typebox.TString, _$typebox.TNumber]>>;
    }>>;
    note: _$typebox.TOptional<_$typebox.TString>;
    continuationMessage: _$typebox.TOptional<_$typebox.TString>;
    restartDelayMs: _$typebox.TOptional<_$typebox.TInteger>;
    timeoutMs: _$typebox.TOptional<_$typebox.TInteger>;
  }>;
  TickEvent: _$typebox.TObject<{
    ts: _$typebox.TInteger;
  }>;
  ShutdownEvent: _$typebox.TObject<{
    reason: _$typebox.TString;
    restartExpectedMs: _$typebox.TOptional<_$typebox.TInteger>;
  }>;
};
//#endregion
//#region src/gateway/protocol/schema/types.d.ts
type ProtocolSchemaName = keyof typeof ProtocolSchemas;
type SchemaType<TName extends ProtocolSchemaName> = Static<(typeof ProtocolSchemas)[TName]>;
type ConnectParams = SchemaType<"ConnectParams">;
type HelloOk = SchemaType<"HelloOk">;
type RequestFrame = SchemaType<"RequestFrame">;
type ResponseFrame = SchemaType<"ResponseFrame">;
type EventFrame = SchemaType<"EventFrame">;
type GatewayFrame = SchemaType<"GatewayFrame">;
type Snapshot = SchemaType<"Snapshot">;
type PresenceEntry = SchemaType<"PresenceEntry">;
type ErrorShape = SchemaType<"ErrorShape">;
type StateVersion = SchemaType<"StateVersion">;
type EnvironmentStatus = SchemaType<"EnvironmentStatus">;
type EnvironmentSummary = SchemaType<"EnvironmentSummary">;
type EnvironmentsListParams = SchemaType<"EnvironmentsListParams">;
type EnvironmentsListResult = SchemaType<"EnvironmentsListResult">;
type EnvironmentsStatusParams = SchemaType<"EnvironmentsStatusParams">;
type EnvironmentsStatusResult = SchemaType<"EnvironmentsStatusResult">;
type AgentEvent = SchemaType<"AgentEvent">;
type AgentIdentityParams = SchemaType<"AgentIdentityParams">;
type AgentIdentityResult = SchemaType<"AgentIdentityResult">;
type PollParams = SchemaType<"PollParams">;
type AgentWaitParams = SchemaType<"AgentWaitParams">;
type WakeParams = SchemaType<"WakeParams">;
type NodePairRequestParams = SchemaType<"NodePairRequestParams">;
type NodePairListParams = SchemaType<"NodePairListParams">;
type NodePairApproveParams = SchemaType<"NodePairApproveParams">;
type NodePairRejectParams = SchemaType<"NodePairRejectParams">;
type NodePairRemoveParams = SchemaType<"NodePairRemoveParams">;
type NodePairVerifyParams = SchemaType<"NodePairVerifyParams">;
type NodeListParams = SchemaType<"NodeListParams">;
type NodeInvokeParams = SchemaType<"NodeInvokeParams">;
type NodeInvokeResultParams = SchemaType<"NodeInvokeResultParams">;
type NodeEventParams = SchemaType<"NodeEventParams">;
type NodeEventResult = SchemaType<"NodeEventResult">;
type NodePresenceAlivePayload = SchemaType<"NodePresenceAlivePayload">;
type NodePresenceAliveReason = SchemaType<"NodePresenceAliveReason">;
type NodePendingDrainParams = SchemaType<"NodePendingDrainParams">;
type NodePendingDrainResult = SchemaType<"NodePendingDrainResult">;
type NodePendingEnqueueParams = SchemaType<"NodePendingEnqueueParams">;
type NodePendingEnqueueResult = SchemaType<"NodePendingEnqueueResult">;
type SessionsListParams = SchemaType<"SessionsListParams">;
type SessionsCleanupParams = SchemaType<"SessionsCleanupParams">;
type SessionsPreviewParams = SchemaType<"SessionsPreviewParams">;
type SessionsDescribeParams = SchemaType<"SessionsDescribeParams">;
type SessionsResolveParams = SchemaType<"SessionsResolveParams">;
type SessionsPatchParams = SchemaType<"SessionsPatchParams">;
type SessionsResetParams = SchemaType<"SessionsResetParams">;
type SessionsDeleteParams = SchemaType<"SessionsDeleteParams">;
type SessionsCompactParams = SchemaType<"SessionsCompactParams">;
type SessionsUsageParams = SchemaType<"SessionsUsageParams">;
type TaskSummary = SchemaType<"TaskSummary">;
type TasksListParams = SchemaType<"TasksListParams">;
type TasksListResult = SchemaType<"TasksListResult">;
type TasksGetParams = SchemaType<"TasksGetParams">;
type TasksGetResult = SchemaType<"TasksGetResult">;
type TasksCancelParams = SchemaType<"TasksCancelParams">;
type TasksCancelResult = SchemaType<"TasksCancelResult">;
type ConfigGetParams = SchemaType<"ConfigGetParams">;
type ConfigSetParams = SchemaType<"ConfigSetParams">;
type ConfigApplyParams = SchemaType<"ConfigApplyParams">;
type ConfigPatchParams = SchemaType<"ConfigPatchParams">;
type ConfigSchemaParams = SchemaType<"ConfigSchemaParams">;
type ConfigSchemaResponse = SchemaType<"ConfigSchemaResponse">;
type UpdateStatusParams = SchemaType<"UpdateStatusParams">;
type WizardStartParams = SchemaType<"WizardStartParams">;
type WizardNextParams = SchemaType<"WizardNextParams">;
type WizardCancelParams = SchemaType<"WizardCancelParams">;
type WizardStatusParams = SchemaType<"WizardStatusParams">;
type WizardStep = SchemaType<"WizardStep">;
type WizardNextResult = SchemaType<"WizardNextResult">;
type WizardStartResult = SchemaType<"WizardStartResult">;
type WizardStatusResult = SchemaType<"WizardStatusResult">;
type TalkModeParams = SchemaType<"TalkModeParams">;
type TalkCatalogParams = SchemaType<"TalkCatalogParams">;
type TalkCatalogResult = SchemaType<"TalkCatalogResult">;
type TalkConfigParams = SchemaType<"TalkConfigParams">;
type TalkConfigResult = SchemaType<"TalkConfigResult">;
type TalkClientCreateParams = SchemaType<"TalkClientCreateParams">;
type TalkClientCreateResult = SchemaType<"TalkClientCreateResult">;
type TalkClientToolCallParams = SchemaType<"TalkClientToolCallParams">;
type TalkClientToolCallResult = SchemaType<"TalkClientToolCallResult">;
type TalkSessionCreateParams = SchemaType<"TalkSessionCreateParams">;
type TalkSessionCreateResult = SchemaType<"TalkSessionCreateResult">;
type TalkSessionJoinParams = SchemaType<"TalkSessionJoinParams">;
type TalkSessionJoinResult = SchemaType<"TalkSessionJoinResult">;
type TalkSessionAppendAudioParams = SchemaType<"TalkSessionAppendAudioParams">;
type TalkSessionTurnParams = SchemaType<"TalkSessionTurnParams">;
type TalkSessionCancelTurnParams = SchemaType<"TalkSessionCancelTurnParams">;
type TalkSessionCancelOutputParams = SchemaType<"TalkSessionCancelOutputParams">;
type TalkSessionTurnResult = SchemaType<"TalkSessionTurnResult">;
type TalkSessionSubmitToolResultParams = SchemaType<"TalkSessionSubmitToolResultParams">;
type TalkSessionCloseParams = SchemaType<"TalkSessionCloseParams">;
type TalkSessionOkResult = SchemaType<"TalkSessionOkResult">;
type TalkSpeakParams = SchemaType<"TalkSpeakParams">;
type TalkSpeakResult = SchemaType<"TalkSpeakResult">;
type ChannelsStatusParams = SchemaType<"ChannelsStatusParams">;
type ChannelsStatusResult = SchemaType<"ChannelsStatusResult">;
type ChannelsStartParams = SchemaType<"ChannelsStartParams">;
type ChannelsStopParams = SchemaType<"ChannelsStopParams">;
type ChannelsLogoutParams = SchemaType<"ChannelsLogoutParams">;
type WebLoginStartParams = SchemaType<"WebLoginStartParams">;
type WebLoginWaitParams = SchemaType<"WebLoginWaitParams">;
type AgentSummary = SchemaType<"AgentSummary">;
type AgentsFileEntry = SchemaType<"AgentsFileEntry">;
type AgentsCreateParams = SchemaType<"AgentsCreateParams">;
type AgentsCreateResult = SchemaType<"AgentsCreateResult">;
type AgentsUpdateParams = SchemaType<"AgentsUpdateParams">;
type AgentsUpdateResult = SchemaType<"AgentsUpdateResult">;
type AgentsDeleteParams = SchemaType<"AgentsDeleteParams">;
type AgentsDeleteResult = SchemaType<"AgentsDeleteResult">;
type AgentsFilesListParams = SchemaType<"AgentsFilesListParams">;
type AgentsFilesListResult = SchemaType<"AgentsFilesListResult">;
type AgentsFilesGetParams = SchemaType<"AgentsFilesGetParams">;
type AgentsFilesGetResult = SchemaType<"AgentsFilesGetResult">;
type AgentsFilesSetParams = SchemaType<"AgentsFilesSetParams">;
type AgentsFilesSetResult = SchemaType<"AgentsFilesSetResult">;
type ArtifactSummary = SchemaType<"ArtifactSummary">;
type ArtifactsListParams = SchemaType<"ArtifactsListParams">;
type ArtifactsListResult = SchemaType<"ArtifactsListResult">;
type ArtifactsGetParams = SchemaType<"ArtifactsGetParams">;
type ArtifactsGetResult = SchemaType<"ArtifactsGetResult">;
type ArtifactsDownloadParams = SchemaType<"ArtifactsDownloadParams">;
type ArtifactsDownloadResult = SchemaType<"ArtifactsDownloadResult">;
type AgentsListParams = SchemaType<"AgentsListParams">;
type AgentsListResult = SchemaType<"AgentsListResult">;
type CommandEntry = SchemaType<"CommandEntry">;
type CommandsListParams = SchemaType<"CommandsListParams">;
type CommandsListResult = SchemaType<"CommandsListResult">;
type PluginsSessionActionParams = SchemaType<"PluginsSessionActionParams">;
type PluginsSessionActionResult = SchemaType<"PluginsSessionActionResult">;
type SkillsStatusParams = SchemaType<"SkillsStatusParams">;
type ToolsCatalogParams = SchemaType<"ToolsCatalogParams">;
type ToolsCatalogResult = SchemaType<"ToolsCatalogResult">;
type ToolsEffectiveParams = SchemaType<"ToolsEffectiveParams">;
type ToolsEffectiveResult = SchemaType<"ToolsEffectiveResult">;
type ToolsInvokeParams = SchemaType<"ToolsInvokeParams">;
type ToolsInvokeResult = SchemaType<"ToolsInvokeResult">;
type SkillsBinsParams = SchemaType<"SkillsBinsParams">;
type SkillsBinsResult = SchemaType<"SkillsBinsResult">;
type SkillsSearchParams = SchemaType<"SkillsSearchParams">;
type SkillsSearchResult = SchemaType<"SkillsSearchResult">;
type SkillsDetailParams = SchemaType<"SkillsDetailParams">;
type SkillsDetailResult = SchemaType<"SkillsDetailResult">;
type SkillsUploadBeginParams = SchemaType<"SkillsUploadBeginParams">;
type SkillsUploadChunkParams = SchemaType<"SkillsUploadChunkParams">;
type SkillsUploadCommitParams = SchemaType<"SkillsUploadCommitParams">;
type SkillsInstallParams = SchemaType<"SkillsInstallParams">;
type SkillsUpdateParams = SchemaType<"SkillsUpdateParams">;
type CronJob = SchemaType<"CronJob">;
type CronListParams = SchemaType<"CronListParams">;
type CronStatusParams = SchemaType<"CronStatusParams">;
type CronGetParams = SchemaType<"CronGetParams">;
type CronAddParams = SchemaType<"CronAddParams">;
type CronUpdateParams = SchemaType<"CronUpdateParams">;
type CronRemoveParams = SchemaType<"CronRemoveParams">;
type CronRunParams = SchemaType<"CronRunParams">;
type CronRunsParams = SchemaType<"CronRunsParams">;
type CronRunLogEntry = SchemaType<"CronRunLogEntry">;
type LogsTailParams = SchemaType<"LogsTailParams">;
type LogsTailResult = SchemaType<"LogsTailResult">;
type ExecApprovalsGetParams = SchemaType<"ExecApprovalsGetParams">;
type ExecApprovalsSetParams = SchemaType<"ExecApprovalsSetParams">;
type ExecApprovalsSnapshot = SchemaType<"ExecApprovalsSnapshot">;
type ExecApprovalGetParams = SchemaType<"ExecApprovalGetParams">;
type ExecApprovalRequestParams = SchemaType<"ExecApprovalRequestParams">;
type ExecApprovalResolveParams = SchemaType<"ExecApprovalResolveParams">;
type DevicePairListParams = SchemaType<"DevicePairListParams">;
type DevicePairApproveParams = SchemaType<"DevicePairApproveParams">;
type DevicePairRejectParams = SchemaType<"DevicePairRejectParams">;
type ChatInjectParams = SchemaType<"ChatInjectParams">;
type ChatEvent = SchemaType<"ChatEvent">;
type UpdateRunParams = SchemaType<"UpdateRunParams">;
type TickEvent = SchemaType<"TickEvent">;
type ShutdownEvent = SchemaType<"ShutdownEvent">;
//#endregion
export { CronStatusParams as $, UpdateRunParams as $n, SessionsResolveParams as $t, ChannelsStatusParams as A, TalkSessionCreateResult as An, NodePairRemoveParams as At, ConfigPatchParams as B, TasksCancelParams as Bn, PluginsSessionActionResult as Bt, ArtifactsDownloadResult as C, TalkConfigResult as Cn, NodeEventResult as Ct, ArtifactsListResult as D, TalkSessionCancelTurnParams as Dn, NodePairApproveParams as Dt, ArtifactsListParams as E, TalkSessionCancelOutputParams as En, NodeListParams as Et, CommandEntry as F, TalkSessionTurnParams as Fn, NodePendingEnqueueParams as Ft, CronAddParams as G, TasksListResult as Gn, SessionsCleanupParams as Gt, ConfigSchemaResponse as H, TasksGetParams as Hn, PresenceEntry as Ht, CommandsListParams as I, TalkSessionTurnResult as In, NodePendingEnqueueResult as It, CronListParams as J, ToolsCatalogResult as Jn, SessionsDescribeParams as Jt, CronGetParams as K, TickEvent as Kn, SessionsCompactParams as Kt, CommandsListResult as L, TalkSpeakParams as Ln, NodePresenceAlivePayload as Lt, ChannelsStopParams as M, TalkSessionJoinResult as Mn, NodePairVerifyParams as Mt, ChatEvent as N, TalkSessionOkResult as Nn, NodePendingDrainParams as Nt, ChannelsLogoutParams as O, TalkSessionCloseParams as On, NodePairListParams as Ot, ChatInjectParams as P, TalkSessionSubmitToolResultParams as Pn, NodePendingDrainResult as Pt, CronRunsParams as Q, ToolsInvokeResult as Qn, SessionsResetParams as Qt, ConfigApplyParams as R, TalkSpeakResult as Rn, NodePresenceAliveReason as Rt, ArtifactsDownloadParams as S, TalkConfigParams as Sn, NodeEventParams as St, ArtifactsGetResult as T, TalkSessionAppendAudioParams as Tn, NodeInvokeResultParams as Tt, ConfigSetParams as U, TasksGetResult as Un, RequestFrame as Ut, ConfigSchemaParams as V, TasksCancelResult as Vn, PollParams as Vt, ConnectParams as W, TasksListParams as Wn, ResponseFrame as Wt, CronRunLogEntry as X, ToolsEffectiveResult as Xn, SessionsPatchParams as Xt, CronRemoveParams as Y, ToolsEffectiveParams as Yn, SessionsListParams as Yt, CronRunParams as Z, ToolsInvokeParams as Zn, SessionsPreviewParams as Zt, AgentsListParams as _, TalkCatalogResult as _n, ExecApprovalsSnapshot as _t, AgentWaitParams as a, SkillsDetailResult as an, WizardNextParams as ar, EnvironmentSummary as at, AgentsUpdateResult as b, TalkClientToolCallParams as bn, LogsTailParams as bt, AgentsDeleteParams as c, SkillsSearchResult as cn, WizardStartResult as cr, EnvironmentsStatusParams as ct, AgentsFilesGetParams as d, SkillsUploadBeginParams as dn, WizardStep as dr, EventFrame as dt, SessionsUsageParams as en, UpdateStatusParams as er, CronUpdateParams as et, AgentsFilesGetResult as f, SkillsUploadChunkParams as fn, ProtocolSchemas as fr, ExecApprovalGetParams as ft, AgentsFilesSetResult as g, TalkCatalogParams as gn, ExecApprovalsSetParams as gt, AgentsFilesSetParams as h, StateVersion as hn, PROTOCOL_VERSION as hr, ExecApprovalsGetParams as ht, AgentSummary as i, SkillsDetailParams as in, WizardCancelParams as ir, EnvironmentStatus as it, ChannelsStatusResult as j, TalkSessionJoinParams as jn, NodePairRequestParams as jt, ChannelsStartParams as k, TalkSessionCreateParams as kn, NodePairRejectParams as kt, AgentsDeleteResult as l, SkillsStatusParams as ln, WizardStatusParams as lr, EnvironmentsStatusResult as lt, AgentsFilesListResult as m, Snapshot as mn, MIN_PROBE_PROTOCOL_VERSION as mr, ExecApprovalResolveParams as mt, AgentIdentityParams as n, SkillsBinsParams as nn, WebLoginStartParams as nr, DevicePairListParams as nt, AgentsCreateParams as o, SkillsInstallParams as on, WizardNextResult as or, EnvironmentsListParams as ot, AgentsFilesListParams as p, SkillsUploadCommitParams as pn, MIN_CLIENT_PROTOCOL_VERSION as pr, ExecApprovalRequestParams as pt, CronJob as q, ToolsCatalogParams as qn, SessionsDeleteParams as qt, AgentIdentityResult as r, SkillsBinsResult as rn, WebLoginWaitParams as rr, DevicePairRejectParams as rt, AgentsCreateResult as s, SkillsSearchParams as sn, WizardStartParams as sr, EnvironmentsListResult as st, AgentEvent as t, ShutdownEvent as tn, WakeParams as tr, DevicePairApproveParams as tt, AgentsFileEntry as u, SkillsUpdateParams as un, WizardStatusResult as ur, ErrorShape as ut, AgentsListResult as v, TalkClientCreateParams as vn, GatewayFrame as vt, ArtifactsGetParams as w, TalkModeParams as wn, NodeInvokeParams as wt, ArtifactSummary as x, TalkClientToolCallResult as xn, LogsTailResult as xt, AgentsUpdateParams as y, TalkClientCreateResult as yn, HelloOk as yt, ConfigGetParams as z, TaskSummary as zn, PluginsSessionActionParams as zt };