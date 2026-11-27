import AVFoundation
import Foundation
import OpenClawKit
import Speech

struct TalkSpeechLanguageSelection: Equatable {
    /// Provider synthesis accepts a two-letter language, while the system
    /// voice accepts a BCP 47 locale. Keep both forms so fallback stays correct.
    let provider: String?
    let systemVoice: String?
}

enum TalkSpeechLocale {
    static let fallbackLocaleID = "en-US"

    static func resolvedLocaleID(
        gatewaySelection: String?,
        deviceLocaleID: String = Locale.autoupdatingCurrent.identifier,
        fallbackLocaleID: String = Self.fallbackLocaleID,
        supportedLocaleIDs: Set<String>) -> String?
    {
        TalkConfigParsing.resolvedSpeechRecognitionLocaleID(
            preferredLocaleIDs: [
                TalkConfigParsing.normalizedExplicitSpeechLocaleID(gatewaySelection),
                deviceLocaleID,
            ],
            fallbackLocaleID: fallbackLocaleID,
            supportedLocaleIDs: supportedLocaleIDs)
    }

    static func resolvedLanguages(
        directiveLanguage: String?,
        gatewaySelection: String?,
        isSystemVoiceAvailable: (String) -> Bool = TalkSpeechLocale.isSystemVoiceAvailable)
        -> TalkSpeechLanguageSelection
    {
        TalkSpeechLanguageSelection(
            provider: ElevenLabsTTSClient.validatedLanguage(directiveLanguage),
            systemVoice: TalkSpeechLocale.resolvedSynthesisLocaleID(
                directiveLanguage: directiveLanguage,
                gatewaySelection: gatewaySelection,
                isVoiceAvailable: isSystemVoiceAvailable))
    }

    static func resolvedSynthesisLocaleID(
        directiveLanguage: String?,
        gatewaySelection: String?,
        isVoiceAvailable: (String) -> Bool = TalkSpeechLocale.isSystemVoiceAvailable) -> String?
    {
        // A missing higher-priority voice must not mask a later configured voice.
        // Return nil only after every candidate fails so synthesis uses the device default.
        [directiveLanguage, gatewaySelection]
            .compactMap { TalkConfigParsing.normalizedExplicitSpeechLocaleID($0) }
            .first(where: isVoiceAvailable)
    }

    static func isSystemVoiceAvailable(_ localeID: String) -> Bool {
        AVSpeechSynthesisVoice(language: localeID) != nil
    }

    static func makeRecognizer(
        gatewaySelection: String?,
        supportedLocales: Set<Locale> = SFSpeechRecognizer.supportedLocales()) -> (
        recognizer: SFSpeechRecognizer?,
        localeID: String?)
    {
        let supportedIDs = Set(supportedLocales.map(\.identifier))
        if let localeID = self.resolvedLocaleID(
            gatewaySelection: gatewaySelection,
            supportedLocaleIDs: supportedIDs),
            let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeID))
        {
            return (recognizer, localeID)
        }

        let recognizer = SFSpeechRecognizer()
        return (recognizer, recognizer?.locale.identifier)
    }
}
