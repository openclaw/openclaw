extension OpenClawChatSQLiteTranscriptCache {
    static func sessionCacheProjection(_ session: OpenClawChatSessionEntry) -> OpenClawChatSessionEntry {
        // Sidebar enrichment is live-only. Decoding more Gateway facts must not
        // expand the existing offline payload or replay process-current placement.
        var row = session
        row.lastMessagePreview = nil
        row.icon = nil
        row.channel = nil
        row.channelAvatarUrl = nil
        row.owner = nil
        row.participants = nil
        row.expandedParticipants = nil
        row.participantCount = nil
        row.visibility = nil
        row.sharingRole = nil
        row.hiddenFromInvolvingMe = nil
        row.incognito = nil
        row.archivedBy = nil
        row.archiveReason = nil
        row.projectId = nil
        row.workspaceDir = nil
        row.spawnedWorkspaceDir = nil
        row.spawnedCwd = nil
        row.repositoryWorkspaceId = nil
        row.repository = nil
        row.execNode = nil
        row.execCwd = nil
        row.forkedFromParent = nil
        row.parentSessionId = nil
        row.controlOwnerSessionKey = nil
        row.forkSource = nil
        row.previousSessionId = nil
        row.spawnDepth = nil
        row.subagentRole = nil
        row.subagentControlScope = nil
        row.placement = nil
        row.placementMove = nil
        row.createdActor = row.createdActor.map {
            .init(type: $0.type, id: nil, label: nil, avatarUrl: nil, identity: nil)
        }
        return row
    }
}
