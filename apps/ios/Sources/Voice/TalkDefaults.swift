import Foundation

enum TalkDefaults {
    static let silenceTimeoutMs = 900
    /// Default speech recognition locale. "auto" = device locale.
    static let speechLocale = "auto"

    /// Supported speech locales shown in the in-app picker.
    /// Apple SFSpeechRecognizer supports 50+ locales; this list covers the most common ones.
    /// "auto" uses the device's primary language.
    static let supportedSpeechLocales: [(id: String, label: String)] = [
        ("auto", "Auto (Device)"),
        ("en-US", "English (US)"),
        ("en-GB", "English (UK)"),
        ("ru-RU", "Русский"),
        ("uk-UA", "Українська"),
        ("de-DE", "Deutsch"),
        ("fr-FR", "Français"),
        ("es-ES", "Español"),
        ("it-IT", "Italiano"),
        ("pt-BR", "Português (BR)"),
        ("zh-Hans", "中文 (简体)"),
        ("zh-Hant", "中文 (繁體)"),
        ("ja-JP", "日本語"),
        ("ko-KR", "한국어"),
        ("ar-SA", "العربية"),
        ("hi-IN", "हिन्दी"),
        ("tr-TR", "Türkçe"),
        ("pl-PL", "Polski"),
        ("nl-NL", "Nederlands"),
        ("sv-SE", "Svenska"),
    ]

    /// Resolve "auto" to the device's primary locale identifier.
    static func resolvedSpeechLocale(_ raw: String) -> Locale {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed == "auto" {
            return Locale.current
        }
        return Locale(identifier: trimmed)
    }
}
