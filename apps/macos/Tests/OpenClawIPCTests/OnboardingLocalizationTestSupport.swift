import Foundation
import Testing

func makeOnboardingLocalizationBundle(at root: URL) throws -> Bundle {
    let translations = [
        "This device needs pairing approval": "Dieses Ger\u{00e4}t muss gekoppelt werden",
        "Approve this device from an already-paired OpenClaw client. " +
            "In your OpenClaw chat, run `/pair approve`, then click **Check connection** again.":
            "F\u{00fc}hre `/pair approve` aus und klicke auf **Verbindung pr\u{00fc}fen**.",
        "If you do not have another paired OpenClaw client yet, " +
            "approve the pending request on the gateway host with `openclaw devices approve`.":
            "Best\u{00e4}tige mit `openclaw devices approve`.",
        "Pairing required. In an already-paired OpenClaw client, " +
            "run /pair approve, then check the connection again.":
            "Kopplung erforderlich. F\u{00fc}hre /pair approve aus.",
        "Connected via paired device": "\u{00dc}ber gekoppeltes Ger\u{00e4}t verbunden",
        "Connected with setup code": "Mit Einrichtungscode verbunden",
        "Connected with gateway token": "Mit Gateway-Token verbunden",
        "This app used a stored device token. New or unpaired devices may still need the gateway token.":
            "Diese App verwendet ein gespeichertes Ger\u{00e4}te-Token.",
        "This app is still using the temporary setup code. " +
            "Approve pairing to finish provisioning device-scoped auth.":
            "Best\u{00e4}tige die Kopplung, um den Einrichtungscode abzul\u{00f6}sen.",
        "Gateway authentication required": "Gateway-Anmeldung erforderlich",
        "Back to Gateway": "Zur\u{00fc}ck zum Gateway",
        "Try again": "Erneut versuchen",
    ]
    let info: [String: Any] = [
        "CFBundleIdentifier": "test.openclaw.onboarding.\(UUID().uuidString)",
        "CFBundlePackageType": "BNDL",
        "CFBundleDevelopmentRegion": "en",
        "CFBundleLocalizations": ["en", "de"],
    ]
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        .write(to: root.appendingPathComponent("Info.plist"))
    for language in ["en", "de"] {
        let directory = root.appendingPathComponent("\(language).lproj")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let strings = language == "de"
            ? translations
            : Dictionary(uniqueKeysWithValues: translations.keys.map { ($0, $0) })
        try PropertyListSerialization.data(fromPropertyList: strings, format: .xml, options: 0)
            .write(to: directory.appendingPathComponent("Localizable.strings"))
    }
    let bundle = try #require(Bundle(url: root))
    let german = try #require(Bundle(url: root.appendingPathComponent("de.lproj")))
    try #require(german.localizedString(forKey: "Try again", value: nil, table: nil) == "Erneut versuchen")
    return bundle
}

func onboardingResource(
    _ value: LocalizedStringResource,
    bundle: Bundle,
    locale: String = "de") -> LocalizedStringResource
{
    let resource = LocalizedStringResource(
        value.defaultValue,
        table: value.table,
        locale: Locale(identifier: locale),
        bundle: .atURL(bundle.bundleURL))
    #expect(resource.key == value.key)
    return resource
}
