import SwiftUI
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatModelPickerPhoneTests {
    @Test func `provider marks resolve through the Control UI aliases and ship in the app`() {
        #expect(ChatProviderMarks.iconName(for: "anthropic") == "claude")
        #expect(ChatProviderMarks.iconName(for: "OpenAI") == "codex")
        #expect(ChatProviderMarks.iconName(for: "acp-kimi") == "kimi")
        #expect(ChatProviderMarks.assetName(for: "clawrouter") == "ProviderIcon-clawrouter")
        #expect(ChatProviderMarks.assetName(for: "z-ai") == "ProviderIcon-zai")
        // No shipped mark: the picker draws a neutral glyph instead.
        #expect(ChatProviderMarks.iconName(for: "azure-openai") == nil)
        #expect(ChatProviderMarks.assetName(for: "azure-openai") == nil)
    }

    @Test func `effort levels read as the Control UI writes them`() {
        let labels = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "adaptive", "turbo"]
            .map { OpenClawChatThinkingLevelOption(id: $0, label: $0).displayLabel }
        #expect(labels == [
            "Off", "Minimal", "Low", "Medium", "High", "Extra high", "Maximum", "Ultra", "Adaptive", "Turbo",
        ])
    }
}
