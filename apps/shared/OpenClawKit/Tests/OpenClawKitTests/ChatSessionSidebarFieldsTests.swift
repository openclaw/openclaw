import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

struct ChatSessionSidebarFieldsTests {
    static let rosterFixture = Data(#"""
    {
      "count": 1, "totalCount": 202, "offset": 200, "nextOffset": 201, "hasMore": true,
      "owners": [{"type":"human","id":"profile-ada","label":"Ada","avatarUrl":"/ada.png",
        "identity":{"type":"profile","id":"profile-ada"}}],
      "ownerSessionCounts": [{"profileId":"profile-ada","open":17,"running":2}],
      "people": [{"identity":{"type":"profile","id":"profile-ada"},"label":"Ada",
        "avatarUrl":"/ada.png","sessionCount":21}],
      "peopleIncomplete": true, "peopleSessionCount": 202, "involvingProfileId": "profile-ada",
      "sessions": [{
        "key":"agent:research:thread", "kind":"direct", "sessionId":"session-thread",
        "lastMessagePreview":"Latest answer", "derivedTitle":"Research findings", "icon":"🔎",
        "channel":"slack", "channelAvatarUrl":"/__openclaw__/channel-avatar/thread",
        "createdActor":{"type":"human","id":"profile-ada","label":"Ada","avatarUrl":"/ada.png",
          "identity":{"type":"profile","id":"profile-ada"}},
        "owner":{"actor":{"type":"agent","id":"research","label":"Research",
          "identity":{"type":"agent","id":"research"}},
          "assignedBy":{"type":"human","id":"profile-ada"},"assignedAt":100},
        "participants":[{"identity":{"type":"remote","pluginId":"slack","domain":"team-1",
          "idKind":"user","id":"user-1"},"label":"Sam","avatarUrl":"/sam.png"}],
        "expandedParticipants":[{"identity":{"type":"observation","pluginId":"slack",
          "accountId":"work","senderKind":"human","id":"user-2"},"label":"Alex"}],
        "participantCount":2, "visibility":"suggest", "hiddenFromInvolvingMe":true,
        "sharingRole":"member", "incognito":true,
        "archivedBy":{"type":"human","id":"profile-ada","label":"Ada"},"archiveReason":"manual",
        "projectId":"project-research", "workspaceDir":"/workspace/project",
        "spawnedWorkspaceDir":"/workspace", "spawnedCwd":"/workspace/project",
        "repositoryWorkspaceId":"repository-workspace-1",
        "repository":{"url":"https://example.test/project.git","ref":"main","branch":"main"},
        "execNode":"node-1", "execCwd":"/workspace/project",
        "forkedFromParent":true,"parentSessionId":"parent-1","controlOwnerSessionKey":"agent:research:parent",
        "forkSource":{"sessionKey":"agent:research:parent","sessionId":"parent-1","entryId":"entry-1"},
        "previousSessionId":"previous-1", "spawnDepth":2, "subagentRole":"leaf", "subagentControlScope":"none",
        "placement":{"state":"active","generation":3,"createdAtMs":100,"updatedAtMs":120,
          "stateChangedAtMs":110,"providerId":"cloud","profileId":"worker-profile",
          "machine":{"class":"small","os":"linux","osLabel":"Linux","cpu":2,"memoryGb":4},
          "environmentId":"environment-1","activeOwnerEpoch":2,
          "workerBundleHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "workspaceBaseManifestRef":"manifest-1","remoteWorkspaceDir":"/work/project",
          "lastTranscriptAckCursor":4,"lastLiveEventAckCursor":5,
          "workspaceResultConflict":{"paths":["notes.md"],"stagedResultRef":"result-1"},
          "diskSpace":{"status":"warning","availableBytes":100,"totalBytes":1000,"observedAtMs":120},
          "workspaceResultReconciling":true,"runner":{"kind":"device","status":"available","deviceId":"device-1"},
          "workerRuntimeInstall":{"phase":"transferring","transferredBytes":100,"totalBytes":1000,
            "startedAtMs":100,"updatedAtMs":120}},
        "placementMove":{"target":{"kind":"gateway"},"updatedAtMs":125,"error":"Pending local move"}
      }]
    }
    """#.utf8)

    @Test func `gateway sidebar row facts and unpaged owner facets survive native decoding`() throws {
        let fixture = Self.rosterFixture
        let decoded = try OpenClawChatGatewayPayloadCodec.decodeSessionsList(fixture, agentID: "research")
        let expected = try JSONDecoder().decode([String: OpenClawProtocol.AnyCodable].self, from: fixture)
        let encoded = try JSONDecoder().decode(
            [String: OpenClawProtocol.AnyCodable].self, from: JSONEncoder().encode(decoded))
        for key in expected.keys where key != "sessions" {
            #expect(encoded[key] == expected[key], "List response lost \(key)")
        }
        let expectedRows = try #require(expected["sessions"]?.value as? [OpenClawProtocol.AnyCodable])
        let expectedRow = try #require(expectedRows.first?.value as? [String: OpenClawProtocol.AnyCodable])
        let encodedRows = try #require(encoded["sessions"]?.value as? [OpenClawProtocol.AnyCodable])
        let encodedRow = try #require(encodedRows.first?.value as? [String: OpenClawProtocol.AnyCodable])
        for key in expectedRow.keys {
            #expect(encodedRow[key] == expectedRow[key], "Session row lost \(key)")
        }
        #expect(decoded.sessions.first?.agentId == "research")
    }

    @Test func `failed placement keeps actionable recovery and terminal facts`() throws {
        let fixture = Data(#"""
        {"sessions":[{"key":"agent:research:failed","placement":{"state":"failed","generation":4,
          "createdAtMs":100,"updatedAtMs":200,"stateChangedAtMs":190,
          "environmentId":"environment-1","terminalReason":"worker-stopped","terminalAtMs":190,
          "recoveryError":"Worker stopped","recoveryAction":"restart","retryOnSend":true}}]}
        """#.utf8)
        let decoded = try OpenClawChatGatewayPayloadCodec.decodeSessionsList(fixture, agentID: "research")
        let original = try JSONSerialization.jsonObject(with: fixture) as? [String: [[String: Any]]]
        let placement = try #require(original?["sessions"]?.first?["placement"])
        let encoded = try JSONEncoder().encode(decoded.sessions.first)
        let row = try JSONDecoder().decode([String: OpenClawProtocol.AnyCodable].self, from: encoded)
        #expect(row["placement"] == OpenClawProtocol.AnyCodable(placement))
    }
}
