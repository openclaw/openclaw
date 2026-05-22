import { Type } from "typebox";
export declare const ModelChoiceSchema: Type.TObject<{
    id: Type.TString;
    name: Type.TString;
    provider: Type.TString;
    alias: Type.TOptional<Type.TString>;
    contextWindow: Type.TOptional<Type.TInteger>;
    reasoning: Type.TOptional<Type.TBoolean>;
}>;
export declare const AgentSummarySchema: Type.TObject<{
    id: Type.TString;
    name: Type.TOptional<Type.TString>;
    identity: Type.TOptional<Type.TObject<{
        name: Type.TOptional<Type.TString>;
        theme: Type.TOptional<Type.TString>;
        emoji: Type.TOptional<Type.TString>;
        avatar: Type.TOptional<Type.TString>;
        avatarUrl: Type.TOptional<Type.TString>;
    }>>;
    workspace: Type.TOptional<Type.TString>;
    model: Type.TOptional<Type.TObject<{
        primary: Type.TOptional<Type.TString>;
        fallbacks: Type.TOptional<Type.TArray<Type.TString>>;
    }>>;
    agentRuntime: Type.TOptional<Type.TObject<{
        id: Type.TString;
        fallback: Type.TOptional<Type.TUnion<[Type.TLiteral<"pi">, Type.TLiteral<"none">]>>;
        source: Type.TUnion<[Type.TLiteral<"env">, Type.TLiteral<"agent">, Type.TLiteral<"defaults">, Type.TLiteral<"implicit">]>;
    }>>;
}>;
export declare const AgentsListParamsSchema: Type.TObject<{}>;
export declare const AgentsListResultSchema: Type.TObject<{
    defaultId: Type.TString;
    mainKey: Type.TString;
    scope: Type.TUnion<[Type.TLiteral<"per-sender">, Type.TLiteral<"global">]>;
    agents: Type.TArray<Type.TObject<{
        id: Type.TString;
        name: Type.TOptional<Type.TString>;
        identity: Type.TOptional<Type.TObject<{
            name: Type.TOptional<Type.TString>;
            theme: Type.TOptional<Type.TString>;
            emoji: Type.TOptional<Type.TString>;
            avatar: Type.TOptional<Type.TString>;
            avatarUrl: Type.TOptional<Type.TString>;
        }>>;
        workspace: Type.TOptional<Type.TString>;
        model: Type.TOptional<Type.TObject<{
            primary: Type.TOptional<Type.TString>;
            fallbacks: Type.TOptional<Type.TArray<Type.TString>>;
        }>>;
        agentRuntime: Type.TOptional<Type.TObject<{
            id: Type.TString;
            fallback: Type.TOptional<Type.TUnion<[Type.TLiteral<"pi">, Type.TLiteral<"none">]>>;
            source: Type.TUnion<[Type.TLiteral<"env">, Type.TLiteral<"agent">, Type.TLiteral<"defaults">, Type.TLiteral<"implicit">]>;
        }>>;
    }>>;
}>;
export declare const AgentsCreateParamsSchema: Type.TObject<{
    name: Type.TString;
    workspace: Type.TString;
    model: Type.TOptional<Type.TString>;
    emoji: Type.TOptional<Type.TString>;
    avatar: Type.TOptional<Type.TString>;
}>;
export declare const AgentsCreateResultSchema: Type.TObject<{
    ok: Type.TLiteral<true>;
    agentId: Type.TString;
    name: Type.TString;
    workspace: Type.TString;
    model: Type.TOptional<Type.TString>;
}>;
export declare const AgentsUpdateParamsSchema: Type.TObject<{
    agentId: Type.TString;
    name: Type.TOptional<Type.TString>;
    workspace: Type.TOptional<Type.TString>;
    model: Type.TOptional<Type.TString>;
    emoji: Type.TOptional<Type.TString>;
    avatar: Type.TOptional<Type.TString>;
}>;
export declare const AgentsUpdateResultSchema: Type.TObject<{
    ok: Type.TLiteral<true>;
    agentId: Type.TString;
}>;
export declare const AgentsDeleteParamsSchema: Type.TObject<{
    agentId: Type.TString;
    deleteFiles: Type.TOptional<Type.TBoolean>;
}>;
export declare const AgentsDeleteResultSchema: Type.TObject<{
    ok: Type.TLiteral<true>;
    agentId: Type.TString;
    removedBindings: Type.TInteger;
}>;
export declare const AgentsFileEntrySchema: Type.TObject<{
    name: Type.TString;
    path: Type.TString;
    missing: Type.TBoolean;
    size: Type.TOptional<Type.TInteger>;
    updatedAtMs: Type.TOptional<Type.TInteger>;
    content: Type.TOptional<Type.TString>;
}>;
export declare const AgentsFilesListParamsSchema: Type.TObject<{
    agentId: Type.TString;
}>;
export declare const AgentsFilesListResultSchema: Type.TObject<{
    agentId: Type.TString;
    workspace: Type.TString;
    files: Type.TArray<Type.TObject<{
        name: Type.TString;
        path: Type.TString;
        missing: Type.TBoolean;
        size: Type.TOptional<Type.TInteger>;
        updatedAtMs: Type.TOptional<Type.TInteger>;
        content: Type.TOptional<Type.TString>;
    }>>;
}>;
export declare const AgentsFilesGetParamsSchema: Type.TObject<{
    agentId: Type.TString;
    name: Type.TString;
}>;
export declare const AgentsFilesGetResultSchema: Type.TObject<{
    agentId: Type.TString;
    workspace: Type.TString;
    file: Type.TObject<{
        name: Type.TString;
        path: Type.TString;
        missing: Type.TBoolean;
        size: Type.TOptional<Type.TInteger>;
        updatedAtMs: Type.TOptional<Type.TInteger>;
        content: Type.TOptional<Type.TString>;
    }>;
}>;
export declare const AgentsFilesSetParamsSchema: Type.TObject<{
    agentId: Type.TString;
    name: Type.TString;
    content: Type.TString;
}>;
export declare const AgentsFilesSetResultSchema: Type.TObject<{
    ok: Type.TLiteral<true>;
    agentId: Type.TString;
    workspace: Type.TString;
    file: Type.TObject<{
        name: Type.TString;
        path: Type.TString;
        missing: Type.TBoolean;
        size: Type.TOptional<Type.TInteger>;
        updatedAtMs: Type.TOptional<Type.TInteger>;
        content: Type.TOptional<Type.TString>;
    }>;
}>;
export declare const ModelsListParamsSchema: Type.TObject<{
    view: Type.TOptional<Type.TUnion<[Type.TLiteral<"default">, Type.TLiteral<"configured">, Type.TLiteral<"all">]>>;
}>;
export declare const ModelsListResultSchema: Type.TObject<{
    models: Type.TArray<Type.TObject<{
        id: Type.TString;
        name: Type.TString;
        provider: Type.TString;
        alias: Type.TOptional<Type.TString>;
        contextWindow: Type.TOptional<Type.TInteger>;
        reasoning: Type.TOptional<Type.TBoolean>;
    }>>;
}>;
export declare const SkillsStatusParamsSchema: Type.TObject<{
    agentId: Type.TOptional<Type.TString>;
}>;
export declare const SkillsBinsParamsSchema: Type.TObject<{}>;
export declare const SkillsBinsResultSchema: Type.TObject<{
    bins: Type.TArray<Type.TString>;
}>;
export declare const SkillsInstallParamsSchema: Type.TUnion<[Type.TObject<{
    name: Type.TString;
    installId: Type.TString;
    dangerouslyForceUnsafeInstall: Type.TOptional<Type.TBoolean>;
    timeoutMs: Type.TOptional<Type.TInteger>;
}>, Type.TObject<{
    source: Type.TLiteral<"clawhub">;
    slug: Type.TString;
    version: Type.TOptional<Type.TString>;
    force: Type.TOptional<Type.TBoolean>;
    timeoutMs: Type.TOptional<Type.TInteger>;
}>]>;
export declare const SkillsUpdateParamsSchema: Type.TUnion<[Type.TObject<{
    skillKey: Type.TString;
    enabled: Type.TOptional<Type.TBoolean>;
    apiKey: Type.TOptional<Type.TString>;
    env: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
}>, Type.TObject<{
    source: Type.TLiteral<"clawhub">;
    slug: Type.TOptional<Type.TString>;
    all: Type.TOptional<Type.TBoolean>;
}>]>;
export declare const SkillsSearchParamsSchema: Type.TObject<{
    query: Type.TOptional<Type.TString>;
    limit: Type.TOptional<Type.TInteger>;
}>;
export declare const SkillsSearchResultSchema: Type.TObject<{
    results: Type.TArray<Type.TObject<{
        score: Type.TNumber;
        slug: Type.TString;
        displayName: Type.TString;
        summary: Type.TOptional<Type.TString>;
        version: Type.TOptional<Type.TString>;
        updatedAt: Type.TOptional<Type.TInteger>;
    }>>;
}>;
export declare const SkillsDetailParamsSchema: Type.TObject<{
    slug: Type.TString;
}>;
export declare const SkillsDetailResultSchema: Type.TObject<{
    skill: Type.TUnion<[Type.TObject<{
        slug: Type.TString;
        displayName: Type.TString;
        summary: Type.TOptional<Type.TString>;
        tags: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
        createdAt: Type.TInteger;
        updatedAt: Type.TInteger;
    }>, Type.TNull]>;
    latestVersion: Type.TOptional<Type.TUnion<[Type.TObject<{
        version: Type.TString;
        createdAt: Type.TInteger;
        changelog: Type.TOptional<Type.TString>;
    }>, Type.TNull]>>;
    metadata: Type.TOptional<Type.TUnion<[Type.TObject<{
        os: Type.TOptional<Type.TUnion<[Type.TArray<Type.TString>, Type.TNull]>>;
        systems: Type.TOptional<Type.TUnion<[Type.TArray<Type.TString>, Type.TNull]>>;
    }>, Type.TNull]>>;
    owner: Type.TOptional<Type.TUnion<[Type.TObject<{
        handle: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        displayName: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        image: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    }>, Type.TNull]>>;
}>;
export declare const ToolsCatalogParamsSchema: Type.TObject<{
    agentId: Type.TOptional<Type.TString>;
    includePlugins: Type.TOptional<Type.TBoolean>;
}>;
export declare const ToolsEffectiveParamsSchema: Type.TObject<{
    agentId: Type.TOptional<Type.TString>;
    sessionKey: Type.TString;
}>;
export declare const ToolsInvokeParamsSchema: Type.TObject<{
    name: Type.TString;
    args: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
    sessionKey: Type.TOptional<Type.TString>;
    agentId: Type.TOptional<Type.TString>;
    confirm: Type.TOptional<Type.TBoolean>;
    idempotencyKey: Type.TOptional<Type.TString>;
}>;
export declare const ToolCatalogProfileSchema: Type.TObject<{
    id: Type.TUnion<[Type.TLiteral<"minimal">, Type.TLiteral<"coding">, Type.TLiteral<"messaging">, Type.TLiteral<"full">]>;
    label: Type.TString;
}>;
export declare const ToolCatalogEntrySchema: Type.TObject<{
    id: Type.TString;
    label: Type.TString;
    description: Type.TString;
    source: Type.TUnion<[Type.TLiteral<"core">, Type.TLiteral<"plugin">]>;
    pluginId: Type.TOptional<Type.TString>;
    optional: Type.TOptional<Type.TBoolean>;
    risk: Type.TOptional<Type.TUnion<[Type.TLiteral<"low">, Type.TLiteral<"medium">, Type.TLiteral<"high">]>>;
    tags: Type.TOptional<Type.TArray<Type.TString>>;
    defaultProfiles: Type.TArray<Type.TUnion<[Type.TLiteral<"minimal">, Type.TLiteral<"coding">, Type.TLiteral<"messaging">, Type.TLiteral<"full">]>>;
}>;
export declare const ToolCatalogGroupSchema: Type.TObject<{
    id: Type.TString;
    label: Type.TString;
    source: Type.TUnion<[Type.TLiteral<"core">, Type.TLiteral<"plugin">]>;
    pluginId: Type.TOptional<Type.TString>;
    tools: Type.TArray<Type.TObject<{
        id: Type.TString;
        label: Type.TString;
        description: Type.TString;
        source: Type.TUnion<[Type.TLiteral<"core">, Type.TLiteral<"plugin">]>;
        pluginId: Type.TOptional<Type.TString>;
        optional: Type.TOptional<Type.TBoolean>;
        risk: Type.TOptional<Type.TUnion<[Type.TLiteral<"low">, Type.TLiteral<"medium">, Type.TLiteral<"high">]>>;
        tags: Type.TOptional<Type.TArray<Type.TString>>;
        defaultProfiles: Type.TArray<Type.TUnion<[Type.TLiteral<"minimal">, Type.TLiteral<"coding">, Type.TLiteral<"messaging">, Type.TLiteral<"full">]>>;
    }>>;
}>;
export declare const ToolsCatalogResultSchema: Type.TObject<{
    agentId: Type.TString;
    profiles: Type.TArray<Type.TObject<{
        id: Type.TUnion<[Type.TLiteral<"minimal">, Type.TLiteral<"coding">, Type.TLiteral<"messaging">, Type.TLiteral<"full">]>;
        label: Type.TString;
    }>>;
    groups: Type.TArray<Type.TObject<{
        id: Type.TString;
        label: Type.TString;
        source: Type.TUnion<[Type.TLiteral<"core">, Type.TLiteral<"plugin">]>;
        pluginId: Type.TOptional<Type.TString>;
        tools: Type.TArray<Type.TObject<{
            id: Type.TString;
            label: Type.TString;
            description: Type.TString;
            source: Type.TUnion<[Type.TLiteral<"core">, Type.TLiteral<"plugin">]>;
            pluginId: Type.TOptional<Type.TString>;
            optional: Type.TOptional<Type.TBoolean>;
            risk: Type.TOptional<Type.TUnion<[Type.TLiteral<"low">, Type.TLiteral<"medium">, Type.TLiteral<"high">]>>;
            tags: Type.TOptional<Type.TArray<Type.TString>>;
            defaultProfiles: Type.TArray<Type.TUnion<[Type.TLiteral<"minimal">, Type.TLiteral<"coding">, Type.TLiteral<"messaging">, Type.TLiteral<"full">]>>;
        }>>;
    }>>;
}>;
export declare const ToolsEffectiveEntrySchema: Type.TObject<{
    id: Type.TString;
    label: Type.TString;
    description: Type.TString;
    rawDescription: Type.TString;
    source: Type.TUnion<[Type.TLiteral<"core">, Type.TLiteral<"plugin">, Type.TLiteral<"channel">]>;
    pluginId: Type.TOptional<Type.TString>;
    channelId: Type.TOptional<Type.TString>;
    risk: Type.TOptional<Type.TUnion<[Type.TLiteral<"low">, Type.TLiteral<"medium">, Type.TLiteral<"high">]>>;
    tags: Type.TOptional<Type.TArray<Type.TString>>;
}>;
export declare const ToolsEffectiveGroupSchema: Type.TObject<{
    id: Type.TUnion<[Type.TLiteral<"core">, Type.TLiteral<"plugin">, Type.TLiteral<"channel">]>;
    label: Type.TString;
    source: Type.TUnion<[Type.TLiteral<"core">, Type.TLiteral<"plugin">, Type.TLiteral<"channel">]>;
    tools: Type.TArray<Type.TObject<{
        id: Type.TString;
        label: Type.TString;
        description: Type.TString;
        rawDescription: Type.TString;
        source: Type.TUnion<[Type.TLiteral<"core">, Type.TLiteral<"plugin">, Type.TLiteral<"channel">]>;
        pluginId: Type.TOptional<Type.TString>;
        channelId: Type.TOptional<Type.TString>;
        risk: Type.TOptional<Type.TUnion<[Type.TLiteral<"low">, Type.TLiteral<"medium">, Type.TLiteral<"high">]>>;
        tags: Type.TOptional<Type.TArray<Type.TString>>;
    }>>;
}>;
export declare const ToolsEffectiveResultSchema: Type.TObject<{
    agentId: Type.TString;
    profile: Type.TString;
    groups: Type.TArray<Type.TObject<{
        id: Type.TUnion<[Type.TLiteral<"core">, Type.TLiteral<"plugin">, Type.TLiteral<"channel">]>;
        label: Type.TString;
        source: Type.TUnion<[Type.TLiteral<"core">, Type.TLiteral<"plugin">, Type.TLiteral<"channel">]>;
        tools: Type.TArray<Type.TObject<{
            id: Type.TString;
            label: Type.TString;
            description: Type.TString;
            rawDescription: Type.TString;
            source: Type.TUnion<[Type.TLiteral<"core">, Type.TLiteral<"plugin">, Type.TLiteral<"channel">]>;
            pluginId: Type.TOptional<Type.TString>;
            channelId: Type.TOptional<Type.TString>;
            risk: Type.TOptional<Type.TUnion<[Type.TLiteral<"low">, Type.TLiteral<"medium">, Type.TLiteral<"high">]>>;
            tags: Type.TOptional<Type.TArray<Type.TString>>;
        }>>;
    }>>;
}>;
export declare const ToolsInvokeErrorSchema: Type.TObject<{
    code: Type.TString;
    message: Type.TString;
    details: Type.TOptional<Type.TUnknown>;
}>;
export declare const ToolsInvokeResultSchema: Type.TObject<{
    ok: Type.TBoolean;
    toolName: Type.TString;
    output: Type.TOptional<Type.TUnknown>;
    requiresApproval: Type.TOptional<Type.TBoolean>;
    approvalId: Type.TOptional<Type.TString>;
    source: Type.TOptional<Type.TUnion<[Type.TLiteral<"core">, Type.TLiteral<"plugin">, Type.TLiteral<"mcp">, Type.TLiteral<"channel">, Type.TString]>>;
    error: Type.TOptional<Type.TObject<{
        code: Type.TString;
        message: Type.TString;
        details: Type.TOptional<Type.TUnknown>;
    }>>;
}>;
