import AppKit

enum VoiceOverlayTextFormatting {
    static func delta(after committed: String, current: String) -> String {
        if current.hasPrefix(committed) {
            let start = current.index(current.startIndex, offsetBy: committed.count)
            return String(current[start...])
        }
        return current
    }

    static func makeAttributed(committed: String, volatile: String, isFinal: Bool) -> NSAttributedString {
        var attributes: [NSAttributedString.Key: Any] = [
            .foregroundColor: NSColor.labelColor,
            .font: NSFont.systemFont(ofSize: 13, weight: .regular),
        ]
        let full = NSMutableAttributedString(string: committed, attributes: attributes)
        attributes[.foregroundColor] = isFinal ? NSColor.labelColor : NSColor.tertiaryLabelColor
        full.append(NSAttributedString(string: volatile, attributes: attributes))
        return full
    }
}
