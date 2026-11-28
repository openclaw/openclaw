import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

struct ChatLiveToolRowsTests {
    /// Imported Claude CLI history can omit the run ID and separate calls with empty thinking.
    @Test func `a running Claude CLI turn leaves no command alone and shows its launch`() throws {
        /// The app ingests history first; that copies each CLI result's content into its text.
        func imported(_ id: String, _ blocks: String) throws -> OpenClawChatMessage {
            try Self.decode(#"{"role":"assistant","provider":"claude-cli","stopReason":"toolUse","timestamp":2,"#
                + #""__openclaw":{"id":"\#(id)","importedFrom":"claude-cli","cliSessionId":"cli"},"#
                + #""content":[\#(blocks)]}"#).ingestedMessages[0]
        }
        func thinking(_ id: String) throws -> OpenClawChatMessage {
            try imported(id, #"{"type":"thinking","thinking":"","signature":"sig"}"#)
        }
        func call(_ id: String, _ tool: String, _ arguments: String, result: String) throws -> OpenClawChatMessage {
            try imported(
                id,
                #"{"type":"toolcall","id":"\#(id)","name":"mcp__openclaw__\#(tool)","#
                    + #""arguments":\#(arguments)},{"type":"tool_result","tool_use_id":"\#(id)","#
                    + #""name":"mcp__openclaw__\#(tool)","is_error":false,"#
                    + #""content":[{"type":"text","text":\#(result)}]}"#)
        }
        let input = try Self.decode(
            #"{"role":"user","timestamp":1,"idempotencyKey":"live:user","#
                + #""content":[{"type":"text","text":"o que falta ir pro iphone?"}]}"#)
        let firstCommand = try call(
            "e1", "exec", #"{"command":"B=batch47/checkout && for d in */checkout; do :; done"}"#, result: #""ok""#)
        let opening = try [input, thinking("t1"), firstCommand]
        let launch = try call(
            "s1",
            "sessions_spawn",
            #"{"label":"iOS R3: port the reconnect fix","task":"Port it"}"#,
            result: #""{\"status\":\"accepted\",\"childSessionKey\":\"agent:main:subagent:port\"}""#)
        let later = try [
            thinking("t2"),
            call("e2", "exec", #"{"command":"git -C chat-info/checkout log -6"}"#, result: #""ok""#),
            thinking("t3"),
            launch,
            call(
                "m1", "sessions_send", #"{"sessionKey":"agent:main:subagent:lander","message":"Pick it"}"#,
                result: #""{}""#),
        ]
        func live(_ messages: [OpenClawChatMessage]) -> [ChatTranscriptRow] {
            ChatTranscriptRow.collapseCompletedWork(
                ChatTranscriptRow.build(from: ChatTranscriptRow.mergeToolResults(in: messages)),
                runWorking: true,
                activeRunIDs: ["live"],
                liveToolRunIDs: ["live"],
                narratedRunID: "live")
        }
        #expect(input.workRunID == "live" && firstCommand.workRunID == nil)

        // Only the first command is recorded yet: the working claw narrates it, no "Ran …" row of its own.
        let started = live(opening)
        #expect(Self.work(in: started).isEmpty)
        #expect(Self.visibleIDs(started).filter { $0 != input.id }.allSatisfy { id in
            opening.first { $0.id == id }.map { ChatToolActivity.items(message: $0).isEmpty } ?? false
        })

        // After the launch: both commands share one log, the launch keeps its "Launched …" row, and the
        // message still being sent belongs to the claw. Calls the phone also saw live carry the run ID
        // (ChatAssistantRunGroup.orderedParts); calls from before it connected do not.
        let seenLive = later.map { message in
            var copy = message
            copy.transcriptRunID = ChatToolActivity.items(message: message).isEmpty ? nil : "live"
            return copy
        }
        for steps in [later, seenLive] {
            let launched = live(opening + steps)
            let commands = Self.work(in: launched)
            #expect(commands.map(\.isActivityRun) == [true])
            #expect(commands.first?.messages.map(\.id) == [firstCommand.id, later[1].id])
            let shown = Self.visibleIDs(launched).filter { id in
                (opening + steps).first { $0.id == id }.map { !ChatToolActivity.items(message: $0).isEmpty } ?? false
            }
            #expect(shown == [launch.id])
        }
        let presentation = try #require(ChatToolActivity.items(message: launch).first?.sessionLaunch)
        #expect(presentation.phase == .succeeded)
        #expect(String(ChatSessionLaunch.title([presentation], linksChildren: false).characters) ==
            "Launched iOS R3: port the reconnect fix")
    }

    private static func decode(_ json: String) throws -> OpenClawChatMessage {
        try JSONDecoder().decode(OpenClawChatMessage.self, from: Data(json.utf8))
    }

    private static func work(in rows: [ChatTranscriptRow]) -> [ChatTranscriptRow.CompletedWork] {
        rows.compactMap {
            if case let .completedWork(work) = $0 {
                work
            } else {
                nil
            }
        }
    }

    private static func visibleIDs(_ rows: [ChatTranscriptRow]) -> [UUID] {
        rows.compactMap {
            if case let .message(message) = $0 {
                message.id
            } else {
                nil
            }
        }
    }
}
