import Foundation
import Testing
import OpenClawKit
@testable import OpenClaw

@Suite struct TalkModeGatewayConfigParsingTests {
    private let defaultProvider = "elevenlabs"
    private let defaultSilenceTimeoutMs = 1500

    @Test func returnsNilPreferredModelWhenConfigIsEmpty() {
        let config: [String: Any] = [
            "talk": [
                "resolved": [
                    "provider": "mistral",
                    "config": [:]
                ]
            ]
        ]
        
        let state = TalkModeGatewayConfigParser.parse(
            config: config,
            defaultProvider: defaultProvider,
            defaultSilenceTimeoutMs: defaultSilenceTimeoutMs
        )
        
        #expect(state.activeProvider == "mistral")
        #expect(state.preferredModelId == nil)
    }

    @Test func extractsPreferredModelFromResolvedConfig() {
        let config: [String: Any] = [
            "talk": [
                "resolved": [
                    "provider": "mistral",
                    "config": [
                        "modelId": "custom-mistral-model"
                    ]
                ]
            ]
        ]
        
        let state = TalkModeGatewayConfigParser.parse(
            config: config,
            defaultProvider: defaultProvider,
            defaultSilenceTimeoutMs: defaultSilenceTimeoutMs
        )
        
        #expect(state.activeProvider == "mistral")
        #expect(state.preferredModelId == "custom-mistral-model")
    }

    @Test func extractsPreferredModelFromLegacyTalkRoot() {
        let config: [String: Any] = [
            "talk": [
                "modelId": "legacy-root-model",
                "resolved": [
                    "provider": "elevenlabs",
                    "config": [:]
                ]
            ]
        ]
        
        let state = TalkModeGatewayConfigParser.parse(
            config: config,
            defaultProvider: defaultProvider,
            defaultSilenceTimeoutMs: defaultSilenceTimeoutMs
        )
        
        #expect(state.preferredModelId == "legacy-root-model")
    }

    @Test func extractsMistralBaseUrl() {
        let config: [String: Any] = [
            "talk": [
                "resolved": [
                    "provider": "mistral",
                    "config": [
                        "baseUrl": "https://proxy.example.com/v1"
                    ]
                ]
            ]
        ]
        
        let state = TalkModeGatewayConfigParser.parse(
            config: config,
            defaultProvider: defaultProvider,
            defaultSilenceTimeoutMs: defaultSilenceTimeoutMs
        )
        
        #expect(state.mistralBaseUrl == "https://proxy.example.com/v1")
    }
}
