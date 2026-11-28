import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

/// The Control UI's row wording, case for case (ported from ui/src/pages/chat/components/chat-tool-purpose.test.ts
/// at openclaw main 1b06bd7b898e). Each case is a call as the web test mounts it and the title it expects.
@Suite("Tool wording from the Control UI")
struct ChatToolOperationCopyTests {
    typealias Case = (
        name: String, args: String, outcome: ChatToolOperationCopy.Outcome, details: String?, result: String?,
        addressed: String?, expected: String)

    static let cases: [Case] = [
        (
            "exec",
            #"{"code":"await tools.read({ path: 'README.md' })","title":"Check the workspace"}"#,
            .running,
            nil,
            nil,
            nil,
            "Check the workspace"),
        (
            "exec",
            #"{"command":"set -euo pipefail\npnpm test","title":"Check the workspace"}"#,
            .succeeded,
            nil,
            nil,
            nil,
            "Ran pnpm test"),
        ("exec", "{}", .running, nil, nil, nil, "Running a script"),
        ("exec", "{}", .failed, nil, nil, nil, "Script execution"),
        ("custom_tool", #"{"text":"Inspect the workspace"}"#, .succeeded, nil, nil, nil, "Custom Tool"),
        (
            "tool_call",
            #"{"id":"openclaw:core:wait","args":{"runId":"cm_test"}}"#,
            .succeeded,
            nil,
            nil,
            nil,
            "Waited for tool result"),
        (
            "subagents",
            #"{"action":"cancel","runId":"run-secret"}"#,
            .succeeded,
            #"{"found":true,"killed":true,"targetState":{"state":"terminal","task":{"status":"cancelled"}}}"#,
            nil,
            nil,
            "Stopped"),
        ("get_goal", #"{}"#, .running, nil, nil, nil, "Checking goal"),
        ("get_goal", #"{}"#, .succeeded, nil, nil, nil, "Checked goal"),
        ("get_goal", #"{}"#, .failed, nil, nil, nil, "Check goal"),
        ("get_goal", #"{}"#, .other, nil, nil, nil, "Check goal"),
        ("wait", #"{"runId":"cm_test"}"#, .succeeded, nil, nil, nil, "Waited for tool result"),
        (
            "ask_user",
            #"{"questions":[{"question":"Do not repeat this prompt"}]}"#,
            .succeeded,
            nil,
            nil,
            nil,
            "Asked you a question"),
        ("ToolSearch", #"{"query":"select:mcp__openclaw__exec"}"#, .succeeded, nil, nil, nil, "Selected tools"),
        ("ToolSearch", #"{"query":"find session tools"}"#, .succeeded, nil, nil, nil, "Searched tools"),
        ("tool_search", #"{"query":"session tools"}"#, .succeeded, nil, nil, nil, "Searched tools"),
        ("sessions_list", #"{"limit":200}"#, .succeeded, nil, nil, nil, "Listed chats"),
        (
            "process",
            #"{"action":"kill","sessionId":"job"}"#,
            .succeeded,
            #"{"status":"completed","cancellationRequested":true,"terminationConfirmed":false}"#,
            nil,
            nil,
            "Requested process stop"),
        (
            "process",
            #"{"action":"clear","sessionId":"job"}"#,
            .succeeded,
            #"{"status":"completed"}"#,
            nil,
            nil,
            "Removed finished process record"),
        (
            "message",
            #"{"action":"reply","channel":"imessage","messageId":"parent-guid"}"#,
            .succeeded,
            nil,
            #"{"ok":true,"messageId":"reply-guid","repliedTo":"parent-guid"}"#,
            nil,
            "Replied to message"),
        (
            "message",
            #"{"action":"reply","channel":"imessage","messageId":"parent-guid"}"#,
            .succeeded,
            nil,
            #"{"ok":true,"messageId":"unknown","repliedTo":"parent-guid"}"#,
            nil,
            "Reply to message"),
        (
            "message",
            #"{"action":"reply","channel":"imessage","messageId":"parent-guid"}"#,
            .succeeded,
            nil,
            #"{"ok":true,"messageId":"ok","repliedTo":"parent-guid"}"#,
            nil,
            "Reply to message"),
        (
            "message",
            #"{"action":"reply","channel":"imessage","messageId":"parent-guid"}"#,
            .succeeded,
            nil,
            #"{"status":"suppressed","reason":"poll_vote_echo"}"#,
            nil,
            "Reply to message"),
        (
            "message",
            #"{"action":"reply","channel":"imessage","messageId":"parent-guid"}"#,
            .failed,
            nil,
            #"{"error":"iMessage action timed out after 5000ms"}"#,
            nil,
            "Reply to message"),
        (
            "message",
            #"{"action":"react","channel":"telegram","messageId":"456","emoji":"✅"}"#,
            .succeeded,
            nil,
            #"{"ok":false,"added":"✅"}"#,
            nil,
            "React to message"),
        (
            "message",
            #"{"action":"react","channel":"telegram","messageId":"456","emoji":""}"#,
            .succeeded,
            nil,
            #"{"ok":false,"reason":"disabled"}"#,
            nil,
            "Clear reactions"),
        (
            "knowledge_attach",
            #"{"final":true}"#,
            .succeeded,
            nil,
            #"{"state":"complete","receivedBytes":3}"#,
            nil,
            "Finished uploading knowledge source file"),
        (
            "knowledge_attach",
            #"{"final":false}"#,
            .succeeded,
            nil,
            #"{"state":"uploading","receivedBytes":3}"#,
            nil,
            "Uploaded knowledge source data"),
        (
            "knowledge_relink",
            #"{"dryRun":true}"#,
            .succeeded,
            nil,
            #"{"dryRun":true,"linked":2}"#,
            nil,
            "Previewed links for remembered claims"),
        (
            "knowledge_relink",
            #"{}"#,
            .succeeded,
            nil,
            #"{"dryRun":false,"scanned":0,"linked":0}"#,
            nil,
            "Checked remembered claims for missing links"),
        (
            "knowledge_relink",
            #"{}"#,
            .succeeded,
            nil,
            #"{"dryRun":false,"linked":2}"#,
            nil,
            "Relinked remembered claims"),
        (
            "knowledge_relink",
            #"{}"#,
            .succeeded,
            nil,
            #"{"dryRun":true,"linked":2}"#,
            nil,
            "Previewed links for remembered claims"),
        (
            "knowledge_verify",
            #"{"records":[{"id":"decision"}]}"#,
            .succeeded,
            nil,
            #"{"checked":1,"passed":1,"failed":0}"#,
            nil,
            "Verified knowledge publication"),
        (
            "knowledge_verify",
            #"{"records":[{"id":"missing"}]}"#,
            .succeeded,
            nil,
            #"{"checked":1,"passed":0,"failed":1}"#,
            nil,
            "Checked knowledge publication"),
        (
            "knowledge_verify",
            #"{"records":[{"id":"decision"}]}"#,
            .succeeded,
            nil,
            #"{}"#,
            nil,
            "Checked knowledge publication"),
        (
            "knowledge_relink",
            #"{}"#,
            .succeeded,
            #"{"tool":{"name":"knowledge_relink"},"result":{"details":{"dryRun":false,"linked":2}}}"#,
            nil,
            nil,
            "Relinked remembered claims"),
        (
            "memory_search",
            #"{"query":"release checklist"}"#,
            .succeeded,
            nil,
            nil,
            nil,
            "Searched memory for “release checklist”"),
        (
            "wiki_get",
            #"{"lookup":"projects/openclaw"}"#,
            .succeeded,
            nil,
            nil,
            nil,
            "Read wiki page “projects/openclaw”"),
        (
            "conversations_send",
            #"{"message":"Hello"}"#,
            .succeeded,
            #"{"status":"sent"}"#,
            nil,
            nil,
            "Sent to conversation"),
        (
            "conversations_send",
            #"{"message":"Hello"}"#,
            .succeeded,
            nil,
            #"{"status":"queued"}"#,
            nil,
            "Message queued"),
        (
            "conversations_send",
            #"{"message":"Hello"}"#,
            .succeeded,
            #"{"status":"suppressed"}"#,
            nil,
            nil,
            "Message not sent"),
        (
            "conversations_send",
            #"{"message":"Hello"}"#,
            .succeeded,
            #"{"status":"unknown"}"#,
            nil,
            nil,
            "Delivery unconfirmed"),
        ("conversations_send", #"{"message":"Hello"}"#, .succeeded, nil, nil, nil, "Delivery unconfirmed"),
        ("conversations_turn", #"{"message":"Hello"}"#, .running, nil, nil, nil, "Sending and waiting for a reply"),
        (
            "conversations_turn",
            #"{"message":"Hello"}"#,
            .succeeded,
            #"{"status":"replied"}"#,
            nil,
            nil,
            "Sent · reply received"),
        (
            "conversations_turn",
            #"{"message":"Hello"}"#,
            .succeeded,
            #"{"status":"timeout"}"#,
            nil,
            nil,
            "Sent · reply timed out"),
        (
            "conversations_turn",
            #"{"message":"Hello"}"#,
            .succeeded,
            #"{"status":"sent","error":"No reply correlation"}"#,
            nil,
            nil,
            "Sent to conversation"),
        (
            "conversations_turn",
            #"{"message":"Hello"}"#,
            .succeeded,
            #"{"status":"queued"}"#,
            nil,
            nil,
            "Message queued"),
        (
            "music_generate",
            #"{"prompt":"x"}"#,
            .succeeded,
            #"{"action":"status","duplicateGuard":true,"async":true,"status":"queued"}"#,
            #"Music generation task task-active is already queued with fixture."#,
            nil,
            "Generate music"),
        ("image_generate", #"{"prompt":"x"}"#, .succeeded, nil, nil, nil, "Generate image"),
        (
            "music_generate",
            #"{"prompt":"x"}"#,
            .succeeded,
            #"{"count":2}"#,
            #"Generated 2 tracks.\nPrompt: Background task started for music generation (task-from-prompt)."#,
            nil,
            "Generate music"),
        (
            "image_generate",
            #"{"prompt":"x"}"#,
            .succeeded,
            #"{"async":true,"status":"started","taskId":"task-new"}"#,
            #"Review-before-delivery is enabled. Produced candidates remain private.\nBackground task started for image generation (task-new). Do not call image_generate again."#,
            nil,
            "Requested image generation"),
        (
            "music_generate",
            #"{"prompt":"x"}"#,
            .succeeded,
            #"{"attachments":[{"type":"audio","path":"/fixture/track.mp3"}]}"#,
            #"Generated 1 track with fixture/model."#,
            nil,
            "Generated music"),
        ("music_generate", #"{"action":"status"}"#, .succeeded, nil, nil, nil, "Checked music generation"),
        ("music_generate", #"{"action":"list"}"#, .succeeded, nil, nil, nil, "Listed music models"),
        (
            "sessions_send",
            #"{"sessionKey":"agent:main:subagent:x","message":"Hi"}"#,
            .failed,
            nil,
            #"Followup completion requires in-process caller custody."#,
            "Toasts board",
            "Send message to Toasts board"),
        (
            "sessions_send",
            #"{"sessionKey":"agent:main:subagent:x","message":"Hi"}"#,
            .running,
            nil,
            nil,
            nil,
            "Sending message"),
        (
            "sessions_send",
            #"{"sessionKey":"agent:main:subagent:x","message":"Hi"}"#,
            .succeeded,
            #"{"status":"ok"}"#,
            nil,
            "Review",
            "Sent message to Review"),
        (
            "sessions_send",
            #"{"sessionKey":"agent:main:subagent:x","message":"Hi"}"#,
            .succeeded,
            #"{"status":"accepted"}"#,
            nil,
            "Review",
            "Sent message to Review"),
        (
            "sessions_send",
            #"{"sessionKey":"agent:main:subagent:x","message":"Hi"}"#,
            .succeeded,
            #"{"status":"timeout","sentBeforeError":true}"#,
            nil,
            nil,
            "Sent · reply timed out"),
        (
            "sessions_send",
            #"{"sessionKey":"agent:main:subagent:x","message":"Hi"}"#,
            .succeeded,
            #"{"status":"weird"}"#,
            nil,
            nil,
            "Delivery unconfirmed"),
        (
            "sessions_history",
            #"{"sessionKey":"agent:main:subagent:x"}"#,
            .succeeded,
            nil,
            nil,
            "Research",
            "Read chat Research"),
        ("sessions_history", #"{"sessionKey":"agent:main:subagent:x"}"#, .succeeded, nil, nil, nil, "Read chat"),
        ("agents_wait", #"{"ids":["run"]}"#, .succeeded, nil, nil, nil, "Waited for agents"),
        ("read", #"{"path":"Sources/Header.swift"}"#, .succeeded, nil, nil, nil, "Read Header.swift"),
        ("read", #"{"path":"Sources/Header.swift"}"#, .failed, nil, nil, nil, "Couldn't read Header.swift"),
        ("grep", #"{"pattern":"ChatTheme"}"#, .running, nil, nil, nil, "Searching ChatTheme"),
        ("web_fetch", #"{"url":"https://openclaw.ai"}"#, .succeeded, nil, nil, nil, "Fetched https://openclaw.ai"),
        ("apply_patch", #"{"input":"*** Begin Patch"}"#, .succeeded, nil, nil, nil, "Changed files"),
        ("view_image", #"{"path":"/tmp/a.png"}"#, .running, nil, nil, nil, "Viewing image"),
    ]

    @Test(arguments: 0..<Self.cases.count)
    func `a live or recorded call reads as the web reads it`(index: Int) throws {
        let item = Self.cases[index]
        let args = try JSONDecoder().decode(AnyCodable.self, from: Data(item.args.utf8))
        let details = try item.details.map { try JSONDecoder().decode(AnyCodable.self, from: Data($0.utf8)) }
        let state: ChatToolActivityItem.State = switch item.outcome {
        case .running: .running
        case .succeeded: .finished
        case .failed: .failed
        case .other: .unavailable
        }
        for (field, prefix) in [("arguments", ""), ("input", "mcp__openclaw__"), ("args", "mcp_openclaw_")] {
            let name = prefix + item.name
            let input = field == "args" ? AnyCodable(item.args) : args
            let payload = AnyCodable([
                "id": AnyCodable("id"),
                "type": AnyCodable("toolCall"),
                "name": AnyCodable(name),
                field: input,
            ])
            let block = try JSONDecoder().decode(OpenClawChatMessageContent.self, from: JSONEncoder().encode(payload))
            let history = ChatToolActivityItem(
                id: "id",
                name: block.name,
                arguments: block.arguments,
                details: details,
                resultText: item.result,
                state: state,
                liveDiffStat: nil)
            let status = [
                ChatToolActivityItem.State.running: "running",
                .finished: "completed",
                .failed: "failed",
            ][state]
            var live = OpenClawChatPendingToolCall(
                toolCallId: "id",
                name: name,
                args: input,
                startedAt: nil,
                isError: nil)
            live.activity = .init(
                itemId: "id",
                toolCallId: "id",
                kind: "tool",
                phase: state == .running ? "start" : "end",
                title: "Raw tool title",
                name: name,
                status: status,
                hideFromChannelProgress: nil,
                suppressChannelProgress: nil)
            var result: [String: AnyCodable] = [:]
            result["details"] = details
            result["text"] = item.result.map(AnyCodable.init)
            live.result = AnyCodable(result)
            for step in [history, ChatToolActivityItem(live: live)] {
                #expect(step.stepTitle(chatName: item.addressed) == item.expected, "\(name) \(field) \(item.args)")
            }
        }
    }
}
