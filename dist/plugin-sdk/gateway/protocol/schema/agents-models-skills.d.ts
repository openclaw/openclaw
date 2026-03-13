export declare const ModelChoiceSchema: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
    name: import("@sinclair/typebox").TString;
    provider: import("@sinclair/typebox").TString;
    contextWindow: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    reasoning: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>;
export declare const AgentSummarySchema: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
    name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    identity: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        theme: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        emoji: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        avatar: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        avatarUrl: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>;
}>;
export declare const AgentsListParamsSchema: import("@sinclair/typebox").TObject<{}>;
export declare const AgentsListResultSchema: import("@sinclair/typebox").TObject<{
    defaultId: import("@sinclair/typebox").TString;
    mainKey: import("@sinclair/typebox").TString;
    scope: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"per-sender">, import("@sinclair/typebox").TLiteral<"global">]>;
    agents: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        identity: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            theme: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            emoji: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            avatar: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            avatarUrl: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>>;
    }>>;
}>;
export declare const AgentsCreateParamsSchema: import("@sinclair/typebox").TObject<{
    name: import("@sinclair/typebox").TString;
    workspace: import("@sinclair/typebox").TString;
    emoji: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    avatar: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const AgentsCreateResultSchema: import("@sinclair/typebox").TObject<{
    ok: import("@sinclair/typebox").TLiteral<true>;
    agentId: import("@sinclair/typebox").TString;
    name: import("@sinclair/typebox").TString;
    workspace: import("@sinclair/typebox").TString;
}>;
export declare const AgentsUpdateParamsSchema: import("@sinclair/typebox").TObject<{
    agentId: import("@sinclair/typebox").TString;
    name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    workspace: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    model: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    avatar: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const AgentsUpdateResultSchema: import("@sinclair/typebox").TObject<{
    ok: import("@sinclair/typebox").TLiteral<true>;
    agentId: import("@sinclair/typebox").TString;
}>;
export declare const AgentsDeleteParamsSchema: import("@sinclair/typebox").TObject<{
    agentId: import("@sinclair/typebox").TString;
    deleteFiles: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>;
export declare const AgentsDeleteResultSchema: import("@sinclair/typebox").TObject<{
    ok: import("@sinclair/typebox").TLiteral<true>;
    agentId: import("@sinclair/typebox").TString;
    removedBindings: import("@sinclair/typebox").TInteger;
}>;
export declare const AgentsFileEntrySchema: import("@sinclair/typebox").TObject<{
    name: import("@sinclair/typebox").TString;
    path: import("@sinclair/typebox").TString;
    missing: import("@sinclair/typebox").TBoolean;
    size: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    updatedAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    content: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const AgentsFilesListParamsSchema: import("@sinclair/typebox").TObject<{
    agentId: import("@sinclair/typebox").TString;
}>;
export declare const AgentsFilesListResultSchema: import("@sinclair/typebox").TObject<{
    agentId: import("@sinclair/typebox").TString;
    workspace: import("@sinclair/typebox").TString;
    files: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        name: import("@sinclair/typebox").TString;
        path: import("@sinclair/typebox").TString;
        missing: import("@sinclair/typebox").TBoolean;
        size: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        updatedAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        content: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>;
}>;
export declare const AgentsFilesGetParamsSchema: import("@sinclair/typebox").TObject<{
    agentId: import("@sinclair/typebox").TString;
    name: import("@sinclair/typebox").TString;
}>;
export declare const AgentsFilesGetResultSchema: import("@sinclair/typebox").TObject<{
    agentId: import("@sinclair/typebox").TString;
    workspace: import("@sinclair/typebox").TString;
    file: import("@sinclair/typebox").TObject<{
        name: import("@sinclair/typebox").TString;
        path: import("@sinclair/typebox").TString;
        missing: import("@sinclair/typebox").TBoolean;
        size: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        updatedAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        content: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
}>;
export declare const AgentsFilesSetParamsSchema: import("@sinclair/typebox").TObject<{
    agentId: import("@sinclair/typebox").TString;
    name: import("@sinclair/typebox").TString;
    content: import("@sinclair/typebox").TString;
}>;
export declare const AgentsFilesSetResultSchema: import("@sinclair/typebox").TObject<{
    ok: import("@sinclair/typebox").TLiteral<true>;
    agentId: import("@sinclair/typebox").TString;
    workspace: import("@sinclair/typebox").TString;
    file: import("@sinclair/typebox").TObject<{
        name: import("@sinclair/typebox").TString;
        path: import("@sinclair/typebox").TString;
        missing: import("@sinclair/typebox").TBoolean;
        size: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        updatedAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        content: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
}>;
export declare const ModelsListParamsSchema: import("@sinclair/typebox").TObject<{}>;
export declare const ModelsListResultSchema: import("@sinclair/typebox").TObject<{
    models: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        name: import("@sinclair/typebox").TString;
        provider: import("@sinclair/typebox").TString;
        contextWindow: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        reasoning: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>>;
}>;
export declare const SkillsStatusParamsSchema: import("@sinclair/typebox").TObject<{
    agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const SkillsBinsParamsSchema: import("@sinclair/typebox").TObject<{}>;
export declare const SkillsBinsResultSchema: import("@sinclair/typebox").TObject<{
    bins: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
}>;
export declare const SkillsInstallParamsSchema: import("@sinclair/typebox").TObject<{
    name: import("@sinclair/typebox").TString;
    installId: import("@sinclair/typebox").TString;
    timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
}>;
export declare const SkillsUpdateParamsSchema: import("@sinclair/typebox").TObject<{
    skillKey: import("@sinclair/typebox").TString;
    enabled: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    apiKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    env: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TString>>;
}>;
export declare const ToolsCatalogParamsSchema: import("@sinclair/typebox").TObject<{
    agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    includePlugins: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>;
export declare const ToolCatalogProfileSchema: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"minimal">, import("@sinclair/typebox").TLiteral<"coding">, import("@sinclair/typebox").TLiteral<"messaging">, import("@sinclair/typebox").TLiteral<"full">]>;
    label: import("@sinclair/typebox").TString;
}>;
export declare const ToolCatalogEntrySchema: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
    label: import("@sinclair/typebox").TString;
    description: import("@sinclair/typebox").TString;
    source: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"core">, import("@sinclair/typebox").TLiteral<"plugin">]>;
    pluginId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    optional: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    defaultProfiles: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"minimal">, import("@sinclair/typebox").TLiteral<"coding">, import("@sinclair/typebox").TLiteral<"messaging">, import("@sinclair/typebox").TLiteral<"full">]>>;
}>;
export declare const ToolCatalogGroupSchema: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
    label: import("@sinclair/typebox").TString;
    source: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"core">, import("@sinclair/typebox").TLiteral<"plugin">]>;
    pluginId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    tools: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        label: import("@sinclair/typebox").TString;
        description: import("@sinclair/typebox").TString;
        source: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"core">, import("@sinclair/typebox").TLiteral<"plugin">]>;
        pluginId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        optional: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        defaultProfiles: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"minimal">, import("@sinclair/typebox").TLiteral<"coding">, import("@sinclair/typebox").TLiteral<"messaging">, import("@sinclair/typebox").TLiteral<"full">]>>;
    }>>;
}>;
export declare const ToolsCatalogResultSchema: import("@sinclair/typebox").TObject<{
    agentId: import("@sinclair/typebox").TString;
    profiles: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"minimal">, import("@sinclair/typebox").TLiteral<"coding">, import("@sinclair/typebox").TLiteral<"messaging">, import("@sinclair/typebox").TLiteral<"full">]>;
        label: import("@sinclair/typebox").TString;
    }>>;
    groups: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        label: import("@sinclair/typebox").TString;
        source: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"core">, import("@sinclair/typebox").TLiteral<"plugin">]>;
        pluginId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        tools: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
            id: import("@sinclair/typebox").TString;
            label: import("@sinclair/typebox").TString;
            description: import("@sinclair/typebox").TString;
            source: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"core">, import("@sinclair/typebox").TLiteral<"plugin">]>;
            pluginId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            optional: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            defaultProfiles: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"minimal">, import("@sinclair/typebox").TLiteral<"coding">, import("@sinclair/typebox").TLiteral<"messaging">, import("@sinclair/typebox").TLiteral<"full">]>>;
        }>>;
    }>>;
}>;
