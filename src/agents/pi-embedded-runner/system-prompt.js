import { buildAgentSystemPrompt } from "../system-prompt.js";
export function buildEmbeddedSystemPrompt(params) {
    return buildAgentSystemPrompt({
        workspaceDir: params.workspaceDir,
        defaultThinkLevel: params.defaultThinkLevel,
        reasoningLevel: params.reasoningLevel,
        extraSystemPrompt: params.extraSystemPrompt,
        ownerNumbers: params.ownerNumbers,
        ownerDisplay: params.ownerDisplay,
        ownerDisplaySecret: params.ownerDisplaySecret,
        reasoningTagHint: params.reasoningTagHint,
        heartbeatPrompt: params.heartbeatPrompt,
        skillsPrompt: params.skillsPrompt,
        docsPath: params.docsPath,
        sourcePath: params.sourcePath,
        ttsHint: params.ttsHint,
        workspaceNotes: params.workspaceNotes,
        reactionGuidance: params.reactionGuidance,
        promptMode: params.promptMode,
        acpEnabled: params.acpEnabled,
        runtimeInfo: params.runtimeInfo,
        messageToolHints: params.messageToolHints,
        sandboxInfo: params.sandboxInfo,
        toolNames: params.tools.map((tool) => tool.name),
        modelAliasLines: params.modelAliasLines,
        userTimezone: params.userTimezone,
        userTime: params.userTime,
        userTimeFormat: params.userTimeFormat,
        contextFiles: params.contextFiles,
        includeMemorySection: params.includeMemorySection,
        memoryCitationsMode: params.memoryCitationsMode,
        promptContribution: params.promptContribution,
    });
}
export function createSystemPromptOverride(systemPrompt) {
    const override = systemPrompt.trim();
    return (_defaultPrompt) => override;
}
export function applySystemPromptOverrideToSession(session, override) {
    const prompt = typeof override === "function" ? override() : override.trim();
    session.agent.state.systemPrompt = prompt;
    const mutableSession = session;
    mutableSession._baseSystemPrompt = prompt;
    mutableSession._rebuildSystemPrompt = () => prompt;
}
