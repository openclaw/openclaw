import Foundation

public enum OpenClawSidebarAgentAvatarSource {
    public static let maximumBytes = 2 * 1024 * 1024
    static let maximumCharacters = ((maximumBytes + 2) / 3) * 4 + "data:image/svg+xml;base64,".utf16.count

    static func inlineData(_ source: String) -> Data? {
        guard source.utf16.count <= self.maximumCharacters,
              source.lowercased().hasPrefix("data:image/"), let comma = source.firstIndex(of: ",")
        else { return nil }
        let payload = String(source[source.index(after: comma)...])
        let data = source[..<comma].lowercased().hasSuffix(";base64")
            ? Data(base64Encoded: payload) : self.percentDecodedData(payload)
        guard let data, !data.isEmpty, data.count <= self.maximumBytes else { return nil }
        return data
    }

    private static func percentDecodedData(_ payload: String) -> Data? {
        let bytes = Array(payload.utf8)
        var result = Data()
        var index = 0
        while index < bytes.count {
            if bytes[index] == 37 {
                guard index + 2 < bytes.count,
                      let hex = String(bytes: bytes[(index + 1)...(index + 2)], encoding: .utf8),
                      let byte = UInt8(hex, radix: 16)
                else { return nil }
                result.append(byte)
                index += 3
            } else {
                result.append(bytes[index])
                index += 1
            }
        }
        return result
    }

    public static func resourceURL(_ source: String, context: OpenClawChatSourceContext) -> URL? {
        // ui/src/lib/identity-avatar.ts:27: only canonical, already-mounted Gateway avatar routes are trusted.
        guard source.hasPrefix("/"), !source.hasPrefix("//"), !source.contains("\\"),
              let path = URLComponents(string: source), path.string == source, path.scheme == nil, path.host == nil,
              var origin = URLComponents(url: context.gatewayURL, resolvingAgainstBaseURL: false)
        else { return nil }
        let prefix = context.basePath + "/avatar/"
        guard path.percentEncodedPath.hasPrefix(prefix) else { return nil }
        let agent = String(path.percentEncodedPath.dropFirst(prefix.count))
        guard !agent.isEmpty, !agent.contains("/"), let decoded = agent.removingPercentEncoding,
              ![".", ".."].contains(decoded) else { return nil }
        origin.percentEncodedPath = path.percentEncodedPath
        origin.percentEncodedQuery = path.percentEncodedQuery
        origin.fragment = nil
        return origin.url
    }
}

#if os(macOS)
import SwiftUI

struct ChatSidebarAgentAvatarProvider {
    struct Scope: Equatable {
        let owner: ObjectIdentifier
        let revision: Int
    }

    let scope: Scope
    let transport: any OpenClawChatSidebarTransport
}

extension EnvironmentValues {
    @Entry var sidebarAgentAvatarProvider: ChatSidebarAgentAvatarProvider?
}

extension View {
    @MainActor
    func sidebarAgentAvatars(
        owner: OpenClawChatSessionSidebarData?,
        transport: any OpenClawChatTransport) -> some View
    {
        let provider = owner.flatMap { owner in
            (transport as? any OpenClawChatSidebarTransport).map {
                ChatSidebarAgentAvatarProvider(
                    scope: .init(owner: ObjectIdentifier(owner), revision: owner.scopeRevision), transport: $0)
            }
        }
        return self.environment(\.sidebarAgentAvatarProvider, provider)
    }
}
#endif
