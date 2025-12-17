import Foundation

struct DevicePresentation: Sendable {
    let title: String
    let symbol: String?
}

enum DeviceModelCatalog {
    static func presentation(deviceFamily: String?, modelIdentifier: String?) -> DevicePresentation? {
        let family = (deviceFamily ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let model = (modelIdentifier ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        let modelEntry = model.isEmpty ? nil : modelIdentifierTable[model]
        let symbol = modelEntry?.symbol ?? fallbackSymbol(for: family, modelIdentifier: model)

        let title = if let name = modelEntry?.name, !name.isEmpty {
            name
        } else if !family.isEmpty, !model.isEmpty {
            "\(family) (\(model))"
        } else if !family.isEmpty {
            family
        } else if !model.isEmpty {
            model
        } else {
            ""
        }

        if title.isEmpty { return nil }
        return DevicePresentation(title: title, symbol: symbol)
    }

    private static func fallbackSymbol(for familyRaw: String, modelIdentifier: String) -> String? {
        let family = familyRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        if family.isEmpty { return nil }
        switch family.lowercased() {
        case "ipad":
            return "ipad"
        case "iphone":
            return "iphone"
        case "mac":
            return "laptopcomputer"
        case "android":
            // Prefer tablet glyph when we know it's an Android tablet. (No attempt to infer phone/tablet here.)
            return "cpu"
        case "linux":
            return "cpu"
        default:
            return "cpu"
        }
    }

    private struct ModelEntry: Sendable {
        let name: String
        let symbol: String?
    }

    // Friendly model names for a small set of known identifiers.
    // Extend this table as needed; unknown identifiers fall back to the raw value.
    private static let modelIdentifierTable: [String: ModelEntry] = [
        // iPad
        "iPad16,5": .init(name: "iPad Pro 11-inch (M4)", symbol: "ipad"),
        "iPad16,6": .init(name: "iPad Pro 13-inch (M4)", symbol: "ipad"),

        // Mac
        "Mac16,6": .init(name: "MacBook Pro (14-inch, 2024)", symbol: "laptopcomputer"),
        "Mac16,8": .init(name: "MacBook Pro (16-inch, 2024)", symbol: "laptopcomputer"),
    ]
}

