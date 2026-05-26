type PluginRegistrationContractParams = {
    pluginId: string;
    cliBackendIds?: string[];
    providerIds?: string[];
    webFetchProviderIds?: string[];
    webSearchProviderIds?: string[];
    speechProviderIds?: string[];
    realtimeTranscriptionProviderIds?: string[];
    realtimeVoiceProviderIds?: string[];
    mediaUnderstandingProviderIds?: string[];
    imageGenerationProviderIds?: string[];
    videoGenerationProviderIds?: string[];
    musicGenerationProviderIds?: string[];
    toolNames?: string[];
    requireSpeechVoices?: boolean;
    requireDescribeImages?: boolean;
    requireGenerateImage?: boolean;
    requireGenerateVideo?: boolean;
    manifestAuthChoice?: {
        pluginId: string;
        choiceId: string;
        choiceLabel: string;
        groupId: string;
        groupLabel: string;
        groupHint: string;
    };
};
export declare function describePluginRegistrationContract(params: PluginRegistrationContractParams): void;
export {};
