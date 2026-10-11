import Foundation
import OpenClawKit

extension OpenClawChatSQLiteTranscriptCache {
    // MARK: - Portable cache record shaping

    /// Cache format v1 stores one JSON document per session/message row. Large
    /// attachment bodies and ordinary tool arguments are never cache data.
    static func cacheableMessages(_ messages: [OpenClawChatMessage]) -> [OpenClawChatMessage] {
        messages.suffix(maxCachedMessagesPerSession).map { message in
            var cached = message
            cached.activity = nil
            cached.details = self.cacheableDetails(message.details)
            cached.content = message.content.map { item in
                var cached = item
                cached.thinkingSignature = nil
                cached.playback = nil
                cached.content = nil
                cached.preview = nil
                cached.runId = nil
                cached.arguments = self.cacheableToolArguments(item)
                cached.details = self.cacheableDetails(item.details)
                return cached
            }
            return cached
        }
    }

    private static func cacheableDetails(_ details: AnyCodable?) -> AnyCodable? {
        guard let diff = details?.dictionaryValue?["diff"]?.stringValue else { return nil }
        let capped = self.cacheableText(diff)
        guard !capped.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return AnyCodable(["diff": AnyCodable(capped)])
    }

    private static func cacheableToolArguments(_ item: OpenClawChatMessageContent) -> AnyCodable? {
        guard let type = item.type?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              ["toolcall", "tool_call", "tooluse", "tool_use"].contains(type)
        else { return nil }

        if item.name?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "tool_call",
           let id = item.arguments?.dictionaryValue?["id"]?.stringValue?
               .trimmingCharacters(in: .whitespacesAndNewlines),
               !id.isEmpty
        {
            let call = ToolDisplayRegistry.displayCall(name: item.name, args: item.arguments)
            var arguments = ["id": AnyCodable(id)]
            arguments["args"] = self.cacheablePatchArguments(name: call.name, args: call.args)
            return AnyCodable(arguments)
        }
        return self.cacheablePatchArguments(name: item.name, args: item.arguments)
    }

    private static func cacheablePatchArguments(name: String?, args: AnyCodable?) -> AnyCodable? {
        guard let name = name?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              ["apply_patch", "applypatch", "patch"].contains(name),
              let arguments = args?.dictionaryValue
        else { return nil }

        for key in ["input", "patch", "diff"] {
            guard let value = arguments[key]?.stringValue,
                  !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { continue }
            return AnyCodable([key: AnyCodable(self.cacheableText(value))])
        }
        return nil
    }

    private static func cacheableText(_ value: String) -> String {
        let limit = 64000
        let truncationMarker = "\n...(truncated)..."
        let units = value.utf16
        guard units.count > limit else { return value }
        var end = units.index(units.startIndex, offsetBy: limit - truncationMarker.utf16.count)
        if String.Index(end, within: value) == nil {
            end = units.index(before: end)
        }
        guard let stringEnd = String.Index(end, within: value) else { return truncationMarker }
        return String(value[..<stringEnd]) + truncationMarker
    }
}
