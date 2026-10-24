import Foundation
import OpenClawChatUI
import Testing

struct ChatSessionListVisibilityTests {
    private func makeEntry(
        key: String,
        createdActorType: String? = nil,
        createdVia: String? = nil,
        label: String? = nil,
        displayName: String? = nil,
        subject: String? = nil,
        archived: Bool? = nil,
        classification: String? = nil) throws -> OpenClawChatSessionEntry {
        try JSONDecoder().decode(
            OpenClawChatSessionEntry.self,
            from: Data("""
            {
              "key": "\(key)",
              "archived": \(archived.map { String($0) } ?? "null"),
              "createdVia": \(createdVia.map { "\"\($0)\"" } ?? "null"),
              "createdActor": \(createdActorType.map { "{\"type\":\"\($0)\"}" } ?? "null"),
              "label": \(label.map { "\"\($0)\"" } ?? "null"),
              "displayName": \(displayName.map { "\"\($0)\"" } ?? "null"),
              "subject": \(subject.map { "\"\($0)\"" } ?? "null"),
              "classification": \(classification.map { "\"\($0)\"" } ?? "null")
            }
            """.utf8))
    }

    @Test func `cron keys and system provenance follow the shared web classifier`() {
        // Full-shape contract is owned by ChatSessionSidebarModelTests via
        // ViewOptions.includes; these canaries pin the navigation-side probe.
        for key in ["cron:dreaming", "agent:main:cron:dreaming"] {
            #expect(OpenClawChatSessionListVisibility.isCronSessionDisplayKey(key))
        }
        #expect(!OpenClawChatSessionListVisibility.isCronSessionDisplayKey("agent:main:work"))
    }

    @Test func `automation classification follows the android navigation predicate`() throws {
        for key in ["agent:main:cron:dreaming", "cron:dreaming"] {
            #expect(OpenClawChatSessionListVisibility.isAutomationSession(try makeEntry(key: key)))
        }
        #expect(OpenClawChatSessionListVisibility.isAutomationSession(
            try makeEntry(key: "agent:main:job", createdActorType: "system")))
        #expect(OpenClawChatSessionListVisibility.isAutomationSession(
            try makeEntry(key: "agent:main:job", createdVia: "run")))
        #expect(OpenClawChatSessionListVisibility.isAutomationSession(
            try makeEntry(key: "agent:main:job", createdActorType: "agent", createdVia: "internal")))
        #expect(OpenClawChatSessionListVisibility.isAutomationSession(
            try makeEntry(key: "agent:main:job", createdActorType: "remote", createdVia: "run")))
        // Operator-named and human-created rows stay conversational.
        #expect(!OpenClawChatSessionListVisibility.isAutomationSession(
            try makeEntry(key: "agent:main:job", createdVia: "run", label: "Ops notes")))
        #expect(!OpenClawChatSessionListVisibility.isAutomationSession(
            try makeEntry(key: "agent:main:job", createdVia: "run", displayName: "Team chat")))
        #expect(!OpenClawChatSessionListVisibility.isAutomationSession(
            try makeEntry(key: "agent:main:job", createdVia: "internal", subject: "Weekly review")))
        #expect(!OpenClawChatSessionListVisibility.isAutomationSession(
            try makeEntry(key: "agent:main:job", createdActorType: "human", createdVia: "run")))
        #expect(!OpenClawChatSessionListVisibility.isAutomationSession(
            try makeEntry(key: "agent:main:chat")))
        // Even operator-named lanes remain automation when cron-keyed or system-created.
        #expect(OpenClawChatSessionListVisibility.isAutomationSession(
            try makeEntry(key: "agent:main:cron:dreaming", label: "Dreaming")))
        #expect(OpenClawChatSessionListVisibility.isAutomationSession(
            try makeEntry(key: "agent:main:job", createdActorType: "system", displayName: "Internal")))
        // A named heartbeat outranks system provenance (web classifier :27);
        // an unnamed heartbeat lane stays system.
        #expect(!OpenClawChatSessionListVisibility.isAutomationSession(
            try makeEntry(
                key: "agent:main:nightly",
                createdActorType: "system",
                label: "Nightly",
                subject: nil,
                classification: "heartbeat")))
        #expect(OpenClawChatSessionListVisibility.isAutomationSession(
            try makeEntry(
                key: "agent:main:nightly",
                createdActorType: "system",
                classification: "heartbeat")))
    }

    @Test func `navigation visibility keeps the resolved selected session reachable`() throws {
        let automation = try makeEntry(key: "agent:main:cron:dreaming")
        let chat = try makeEntry(key: "agent:main:slack:direct:+15555550123")
        let archivedChat = try makeEntry(key: "agent:main:old-chat", archived: true)

        #expect(!OpenClawChatSessionListVisibility.isVisibleInNavigation(
            automation, selectedKey: "agent:main:chat"))
        #expect(OpenClawChatSessionListVisibility.isVisibleInNavigation(
            automation, selectedKey: "agent:main:cron:dreaming"))
        #expect(OpenClawChatSessionListVisibility.isVisibleInNavigation(
            chat, selectedKey: "agent:main:chat"))
        #expect(!OpenClawChatSessionListVisibility.isVisibleInNavigation(
            archivedChat, selectedKey: "agent:main:chat"))
        #expect(OpenClawChatSessionListVisibility.isVisibleInNavigation(
            archivedChat, selectedKey: "agent:main:old-chat"))
    }
}
