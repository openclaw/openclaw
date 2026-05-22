export declare const pluginRegistrationContractCases: {
    anthropic: {
        pluginId: string;
        providerIds: string[];
        mediaUnderstandingProviderIds: string[];
        cliBackendIds: string[];
        requireDescribeImages: true;
    };
    brave: {
        pluginId: string;
        webSearchProviderIds: string[];
    };
    comfy: {
        pluginId: string;
        providerIds: string[];
        imageGenerationProviderIds: string[];
        musicGenerationProviderIds: string[];
        videoGenerationProviderIds: string[];
        requireGenerateImage: true;
        requireGenerateVideo: true;
    };
    deepgram: {
        pluginId: string;
        mediaUnderstandingProviderIds: string[];
    };
    duckduckgo: {
        pluginId: string;
        webSearchProviderIds: string[];
    };
    elevenlabs: {
        pluginId: string;
        speechProviderIds: string[];
        requireSpeechVoices: true;
    };
    exa: {
        pluginId: string;
        webSearchProviderIds: string[];
    };
    fal: {
        pluginId: string;
        providerIds: string[];
        imageGenerationProviderIds: string[];
    };
    firecrawl: {
        pluginId: string;
        webFetchProviderIds: string[];
        webSearchProviderIds: string[];
        toolNames: string[];
    };
    google: {
        pluginId: string;
        providerIds: string[];
        webSearchProviderIds: string[];
        realtimeVoiceProviderIds: string[];
        speechProviderIds: string[];
        mediaUnderstandingProviderIds: string[];
        imageGenerationProviderIds: string[];
        requireDescribeImages: true;
        requireGenerateImage: true;
    };
    groq: {
        pluginId: string;
        mediaUnderstandingProviderIds: string[];
    };
    microsoft: {
        pluginId: string;
        speechProviderIds: string[];
        requireSpeechVoices: true;
    };
    minimax: {
        pluginId: string;
        providerIds: string[];
        mediaUnderstandingProviderIds: string[];
        imageGenerationProviderIds: string[];
        requireDescribeImages: true;
        requireGenerateImage: true;
    };
    mistral: {
        pluginId: string;
        mediaUnderstandingProviderIds: string[];
    };
    moonshot: {
        pluginId: string;
        providerIds: string[];
        webSearchProviderIds: string[];
        mediaUnderstandingProviderIds: string[];
        requireDescribeImages: true;
        manifestAuthChoice: {
            pluginId: string;
            choiceId: string;
            choiceLabel: string;
            groupId: string;
            groupLabel: string;
            groupHint: string;
        };
    };
    openai: {
        pluginId: string;
        providerIds: string[];
        speechProviderIds: string[];
        realtimeTranscriptionProviderIds: string[];
        realtimeVoiceProviderIds: string[];
        mediaUnderstandingProviderIds: string[];
        imageGenerationProviderIds: string[];
        requireSpeechVoices: true;
        requireDescribeImages: true;
        requireGenerateImage: true;
    };
    openrouter: {
        pluginId: string;
        providerIds: string[];
        mediaUnderstandingProviderIds: string[];
        imageGenerationProviderIds: string[];
        videoGenerationProviderIds: string[];
        requireDescribeImages: true;
        requireGenerateImage: true;
        requireGenerateVideo: true;
    };
    perplexity: {
        pluginId: string;
        webSearchProviderIds: string[];
    };
    senseaudio: {
        pluginId: string;
        mediaUnderstandingProviderIds: string[];
    };
    tavily: {
        pluginId: string;
        webSearchProviderIds: string[];
        toolNames: string[];
    };
    "tts-local-cli": {
        pluginId: string;
        speechProviderIds: string[];
    };
    xai: {
        pluginId: string;
        providerIds: string[];
        webSearchProviderIds: string[];
        realtimeTranscriptionProviderIds: string[];
        mediaUnderstandingProviderIds: string[];
    };
    zai: {
        pluginId: string;
        mediaUnderstandingProviderIds: string[];
        requireDescribeImages: true;
    };
};
