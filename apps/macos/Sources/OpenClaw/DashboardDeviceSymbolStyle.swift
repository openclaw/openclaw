import AppKit

enum DashboardDeviceSymbolStyle {
    @MainActor
    static func css() -> String {
        // Resolve on the Mac host, never bundle Apple's symbol assets in the web UI.
        let symbols = [("laptop", "laptopcomputer"), ("mini", "macmini"), ("studio", "macstudio")]
        return symbols.compactMap { form, symbol -> String? in
            guard let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 40, weight: .regular)),
                let tiff = image.tiffRepresentation,
                let bitmap = NSBitmapImageRep(data: tiff),
                let png = bitmap.representation(using: .png, properties: [:])
            else { return nil }
            let selector = "html.openclaw-native-macos .new-session-page__device-icon[data-form=\"\(form)\"]"
            return """
            \(selector) {
              background-color: currentColor;
              mask: url("data:image/png;base64,\(png.base64EncodedString())") center / contain no-repeat;
            }
            \(selector) > svg { visibility: hidden; }
            """
        }.joined(separator: "\n")
    }
}
