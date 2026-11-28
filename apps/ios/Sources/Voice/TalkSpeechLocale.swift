import AVFoundation
import Foundation
import OpenClawKit
import Speech
import UIKit

struct TalkSpeechLanguageSelection: Equatable {
    /// Provider synthesis accepts a two-letter language, while the system
    /// voice accepts a BCP 47 locale. Keep both forms so fallback stays correct.
    let provider: String?
    let systemVoice: String?
}

enum TalkSpeechLocale {
    static let fallbackLocaleID = "en-US"

    /// The phone's Talk language. Absent means Automatic.
    static let phoneSelectionKey = "talk.recognitionLanguage"

    /// Which language Talk listens in. An explicit choice on the phone wins, then the Gateway's
    /// `talk.speechLocale`, then Automatic. The Speech framework cannot tell which language is being
    /// spoken, so Automatic does not detect: it takes the first of the phone's preferred languages,
    /// then its keyboards, that the recognizer supports, and US English if none is.
    static func resolvedLocaleID(
        phoneSelection: String?,
        gatewaySelection: String?,
        automaticCandidates: [String],
        fallbackLocaleID: String = Self.fallbackLocaleID,
        supportedLocaleIDs: Set<String>) -> String?
    {
        let ordered = [phoneSelection, gatewaySelection].compactMap {
            TalkConfigParsing.normalizedExplicitSpeechLocaleID($0)
        } + automaticCandidates + [fallbackLocaleID]
        for candidate in ordered {
            if let match = self.supportedMatch(for: candidate, in: supportedLocaleIDs) {
                return match
            }
        }
        return nil
    }

    /// The phone's preferred languages in order, then its keyboards' languages, without repeats.
    static func automaticCandidates(preferredLanguages: [String], keyboardLanguages: [String]) -> [String] {
        var seen = Set<String>()
        return (preferredLanguages + keyboardLanguages)
            .compactMap(TalkConfigParsing.normalizedSpeechLocaleID)
            .filter { seen.insert($0).inserted }
    }

    /// The supported locale for an identifier: itself, else the same language in its usual region
    /// ("en-BR" and "pt" find "en-US" and "pt-BR"), else that language in any region.
    static func supportedMatch(for localeID: String, in supportedLocaleIDs: Set<String>) -> String? {
        let supported = Set(supportedLocaleIDs.compactMap(TalkConfigParsing.normalizedSpeechLocaleID))
        guard let wanted = TalkConfigParsing.normalizedSpeechLocaleID(localeID) else { return nil }
        if supported.contains(wanted) { return wanted }
        let language = Locale.Language(identifier: wanted)
        guard let code = language.languageCode?.identifier else { return nil }
        let sameLanguage = supported.filter { Locale.Language(identifier: $0).languageCode?.identifier == code }
        if let region = Locale.Language(identifier: code).maximalIdentifier.split(separator: "-").last,
           let usual = sameLanguage.first(where: { $0.hasSuffix("-\(region)") })
        {
            return usual
        }
        return sameLanguage.min()
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
        phoneSelection: String? = UserDefaults.standard.string(forKey: Self.phoneSelectionKey),
        automaticCandidates: [String],
        supportedLocales: Set<Locale> = SFSpeechRecognizer.supportedLocales()) -> (
        recognizer: SFSpeechRecognizer?,
        localeID: String?)
    {
        let supportedIDs = Set(supportedLocales.map(\.identifier))
        if let localeID = self.resolvedLocaleID(
            phoneSelection: phoneSelection,
            gatewaySelection: gatewaySelection,
            automaticCandidates: automaticCandidates,
            supportedLocaleIDs: supportedIDs),
            let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeID))
        {
            return (recognizer, localeID)
        }

        let recognizer = SFSpeechRecognizer()
        return (recognizer, recognizer?.locale.identifier)
    }

    /// The languages of the phone's keyboards, as a signal for Automatic.
    @MainActor
    static var keyboardLanguages: [String] {
        UITextInputMode.activeInputModes.compactMap(\.primaryLanguage)
    }

    /// The phone's own Automatic candidates: Settings > General > Language & Region, then keyboards.
    @MainActor
    static var phoneAutomaticCandidates: [String] {
        self.automaticCandidates(
            preferredLanguages: Locale.preferredLanguages,
            keyboardLanguages: self.keyboardLanguages)
    }

    /// The Language picker's choices: the phone's own languages first, then every other language the
    /// recognizer supports, each named in its own language as iOS lists them.
    struct Choice: Identifiable, Equatable {
        let id: String
        let name: String
    }

    @MainActor
    static func choices(
        automaticCandidates: [String] = Self.phoneAutomaticCandidates,
        supportedLocaleIDs: Set<String> = Set(SFSpeechRecognizer.supportedLocales().map(\.identifier)))
        -> (phone: [Choice], others: [Choice])
    {
        var phoneIDs: [String] = []
        for candidate in automaticCandidates {
            if let match = self.supportedMatch(for: candidate, in: supportedLocaleIDs), !phoneIDs.contains(match) {
                phoneIDs.append(match)
            }
        }
        let all = supportedLocaleIDs.compactMap(TalkConfigParsing.normalizedSpeechLocaleID)
        let others = Set(all).subtracting(phoneIDs).map(self.choice).sorted {
            $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
        return (phoneIDs.map(self.choice), others)
    }

    private static func choice(_ id: String) -> Choice {
        let locale = Locale(identifier: id)
        let name = locale.localizedString(forIdentifier: id) ?? id
        return Choice(id: id, name: name.prefix(1).uppercased(with: locale) + name.dropFirst())
    }
}
