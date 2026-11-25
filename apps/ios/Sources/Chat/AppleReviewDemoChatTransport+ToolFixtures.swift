import Foundation
import OpenClawKit

/// Fixture turns of tool activity for the screenshot transport, recorded the way the Gateway records them.
enum ToolActivityFixtures {
    /// The same request answered twice. Claude reports no phase, so what it says between tool calls is
    /// its reply; GPT marks its notes as commentary and its answer as the final answer.
    static func turnPresentation() throws -> [AnyCodable] {
        var rows: [String] = []
        var clock = 1_795_640_000_000
        func row(_ json: String) {
            clock += 2000
            rows.append(json.replacingOccurrences(of: "@T", with: String(clock)))
        }
        func user(_ id: String, _ run: String, _ text: String) {
            row(#"{"role":"user","timestamp":@T,"__openclaw":{"id":"\#(id)","runId":"\#(run)"},"#
                + #""content":[{"type":"text","text":"\#(text)"}]}"#)
        }
        func say(_ run: String, _ model: String, _ text: String, phase: String?, stop: String) {
            let author = model.hasPrefix("gpt")
                ? #""provider":"openai","model":"\#(model)""#
                : #""provider":"anthropic","model":"\#(model)""#
            let phaseField = phase.map { #""phase":"\#($0)","# } ?? ""
            row(#"{"role":"assistant",\#(author),\#(phaseField)"stopReason":"\#(stop)","timestamp":@T,"#
                + #""__openclaw":{"id":"\#(run)-\#(clock)","runId":"\#(run)"},"#
                + #""content":[{"type":"text","text":"\#(text)"}]}"#)
        }
        func tool(_ run: String, _ model: String, _ name: String, _ args: String, _ result: String) {
            let author = model.hasPrefix("gpt")
                ? #""provider":"openai","model":"\#(model)""#
                : #""provider":"anthropic","model":"\#(model)""#
            let id = "\(run)-call-\(clock)"
            row(#"{"role":"assistant",\#(author),"stopReason":"toolUse","timestamp":@T,"#
                + #""__openclaw":{"id":"\#(id)","runId":"\#(run)"},"content":[{"type":"toolCall","#
                + #""id":"\#(id)","name":"\#(name)","arguments":\#(args)}]}"#)
            row(#"{"role":"toolResult","timestamp":@T,"__openclaw":{"id":"\#(id)-result","runId":"\#(run)"},"#
                + #""toolCallId":"\#(id)","toolName":"\#(name)","isError":false,"#
                + #""content":[{"type":"text","text":"\#(result)"}]}"#)
        }
        let claude = "claude-opus-5-5"
        user("tp-user-1", "tp-claude", "Why is the build red?")
        say("tp-claude", claude, "I’ll check the latest build log first.", phase: nil, stop: "toolUse")
        tool("tp-claude", claude, "read", #"{"path":"build/latest.log"}"#, "error: missing import")
        tool("tp-claude", claude, "grep", #"{"pattern":"ChatTheme","path":"Sources"}"#, "3 matches")
        say("tp-claude", claude, "The header lost its import of ChatTheme. Fixing it now.", phase: nil, stop: "toolUse")
        tool("tp-claude", claude, "edit", #"{"path":"Sources/Header.swift"}"#, "Updated 1 file")
        let fixed = "Fixed: the header imports ChatTheme again and the build is green."
        say("tp-claude", claude, fixed, phase: nil, stop: "stop")
        let gpt = "gpt-5.6"
        user("tp-user-2", "tp-gpt", "Same question, on GPT.")
        say("tp-gpt", gpt, "Checking the latest build log.", phase: "commentary", stop: "toolUse")
        tool("tp-gpt", gpt, "read", #"{"path":"build/latest.log"}"#, "error: missing import")
        tool("tp-gpt", gpt, "edit", #"{"path":"Sources/Header.swift"}"#, "Updated 1 file")
        say("tp-gpt", gpt, fixed, phase: "final_answer", stop: "stop")
        return try JSONDecoder().decode([AnyCodable].self, from: Data("[\(rows.joined(separator: ","))]".utf8))
    }

    /// The shape of the turn in the Nov 24 report: each call goes through `dispatch_action`, so the
    /// history holds the envelope call, a nested row with the inner call and its result, and the
    /// envelope's own result. Five sends to two chats and two launches fail around one success.
    static func toolFailures() throws -> [AnyCodable] {
        var rows = [#"{"role":"user","timestamp":1795640000000,"__openclaw":{"id":"tf-user","runId":"tf-run"},"#
            + #""content":[{"type":"text","text":"Hand the fixes to their chats."}]}"#]
        func dispatched(_ index: Int, _ tool: String, _ args: String, failed: Bool, result: String) {
            let id = "tf-call-\(index)"
            let nested = "tool_call:\(id):\(tool):\(index)"
            rows.append(#"{"role":"assistant","stopReason":"toolUse","timestamp":\#(1_795_640_010_000 + index * 3000),"#
                + #""__openclaw":{"id":"\#(id)-call","runId":"tf-run"},"content":[{"type":"toolCall","id":"\#(id)","#
                + #""name":"dispatch_action","arguments":{"id":"\#(tool)","args":\#(args)}}]}"#)
            rows.append(#"{"role":"custom","customType":"openclaw.nested-tool.v1","display":true,"#
                + #""excludeFromContext":true,"timestamp":\#(1_795_640_011_000 + index * 3000),"#
                + #""__openclaw":{"id":"\#(id)-nested","runId":"tf-run"},"content":["#
                + #"{"type":"toolCall","id":"\#(nested)","name":"\#(tool)","arguments":\#(args),"#
                + #""parentToolCallId":"\#(id)"},{"type":"toolResult","toolCallId":"\#(nested)","#
                + #""toolName":"\#(tool)","parentToolCallId":"\#(id)","isError":\#(failed),"#
                + #""content":[{"type":"text","text":"\#(result)"}]}]}"#)
            rows.append(#"{"role":"toolResult","timestamp":\#(1_795_640_012_000 + index * 3000),"#
                + #""__openclaw":{"id":"\#(id)-result","runId":"tf-run"},"toolCallId":"\#(id)","#
                + #""toolName":"dispatch_action","isError":\#(failed),"#
                + #""content":[{"type":"text","text":"\#(result)"}]}"#)
        }
        let custody = "Followup completion requires in-process caller custody."
        let provenance = #"{\"status\":\"error\",\"error\":\"Requester provenance requires trusted"#
            + #" in-process Gateway dispatch.\",\"childSessionKey\":\"agent:main:subagent:fixture-unstarted\"}"#
        let (toasts, composer) = (
            ScreenshotFixtureMode.toolFailureChats[0].key,
            ScreenshotFixtureMode.toolFailureChats[1].key)
        func send(to key: String) -> String {
            #"{"sessionKey":"\#(key)","message":"Start with the toast copy.","timeoutSeconds":0}"#
        }
        dispatched(1, "sessions_send", send(to: toasts), failed: true, result: custody)
        dispatched(2, "sessions_send", send(to: composer), failed: true, result: custody)
        dispatched(
            3,
            "sessions_spawn",
            #"{"label":"Reply images","task":"Fix reply images."}"#,
            failed: true,
            result: provenance)
        dispatched(
            4,
            "sessions_spawn",
            #"{"label":"Image viewer","task":"Fix the image viewer."}"#,
            failed: true,
            result: provenance)
        dispatched(5, "session_status", "{}", failed: false, result: "OpenClaw is running.")
        dispatched(6, "sessions_send", send(to: toasts), failed: true, result: custody)
        dispatched(7, "sessions_send", send(to: composer), failed: true, result: custody)
        dispatched(8, "sessions_send", send(to: composer), failed: true, result: custody)
        return try JSONDecoder().decode([AnyCodable].self, from: Data("[\(rows.joined(separator: ","))]".utf8))
    }
}
