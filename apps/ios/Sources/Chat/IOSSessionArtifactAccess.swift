import OpenClawChatUI
import OpenClawProtocol

/// A catalog and its downloads remain bound to the session and physical Gateway
/// connection captured when the user opened the collection.
struct IOSSessionArtifactAccess: Sendable {
    let list: @Sendable () async throws -> ArtifactsListResult
    let download: @Sendable (String) async throws -> OpenClawChatMediaData
}
