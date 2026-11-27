import Foundation
import OpenClawChatUI
import OpenClawKit

/// Fixture turns of tool activity for the screenshot transport, recorded the way the Gateway records them.
enum ToolActivityFixtures {
    static func stepLabels() throws -> [OpenClawChatHistoryActivity] {
        try JSONDecoder().decode([OpenClawChatHistoryActivity].self, from: Data("""
        [{"messageId":"fixture-step-call","items":[
          {"itemId":"tool:fixture-exec","toolCallId":"fixture-exec","kind":"tool","phase":"end",
           "title":"Exec — outcome unknown","name":"exec"},
          {"itemId":"tool:fixture-no-result","toolCallId":"fixture-no-result","kind":"tool","phase":"end",
           "title":"Exec — outcome unknown","name":"exec"},
          {"itemId":"tool:fixture-success","toolCallId":"fixture-success","kind":"tool","phase":"end",
           "title":"Exec","name":"exec","status":"completed"}
        ]}]
        """.utf8))
    }

    static func nestedTools(successPending: Bool) throws
    -> (messages: [AnyCodable], activity: [OpenClawChatHistoryActivity]) {
        // Keep the existing step transcript/latest reply intact. These earlier raw carriers
        // cross the real history JSON decoder; the public message initializer cannot mark them.
        var nested = try JSONDecoder().decode([AnyCodable].self, from: Data(#"""
        [
          {"role":"custom","customType":"openclaw.nested-tool.v1","display":true,"excludeFromContext":true,
           "__openclaw":{"id":"fixture-nested-pending-row","runId":"fixture-nested-run"},"timestamp":1,
           "content":[{"type":"toolCall","id":"fixture-nested-pending","name":"knowledge_status",
             "arguments":{"query":"Original pending control"},
             "runId":"fixture-nested-run","parentToolCallId":"fixture-parent"}]},
          {"role":"custom","customType":"openclaw.nested-tool.v1","display":true,"excludeFromContext":true,
           "__openclaw":{"id":"fixture-nested-failed-row","runId":"fixture-nested-run"},"timestamp":2,
           "content":[{"type":"toolCall","id":"fixture-nested-failed","name":"read",
             "arguments":{"path":"synthetic.txt"},"parentToolCallId":"fixture-parent"},
             {"type":"toolResult","role":"toolResult","toolCallId":"fixture-nested-failed","toolName":"read",
              "isError":true,"content":[{"type":"text","text":"Recorded nested output"}]}]},
          {"role":"custom","customType":"openclaw.nested-tool.v1","display":true,"excludeFromContext":true,
           "__openclaw":{"id":"fixture-nested-success-row","runId":"fixture-nested-run"},"timestamp":3,
           "content":[{"type":"toolCall","id":"fixture-nested-success","name":"knowledge_status",
             "arguments":{},"runId":"fixture-nested-run","parentToolCallId":"fixture-parent"},
             {"type":"toolResult","role":"toolResult","toolCallId":"fixture-nested-success",
              "toolName":"knowledge_status","runId":"fixture-nested-run","parentToolCallId":"fixture-parent",
              "afterEntryId":"fixture-nested-failed-row","isError":false,
              "content":[{"type":"text","text":"Sanitized nested success output"}]}]}
        ]
        """#.utf8))
        if successPending,
           let index = nested.firstIndex(where: {
               $0.dictionaryValue?["__openclaw"]?.dictionaryValue?["id"]?.stringValue ==
                   "fixture-nested-success-row"
           }),
           var carrier = nested[index].dictionaryValue,
           let content = carrier["content"]?.arrayValue
        {
            carrier["content"] = AnyCodable(content.filter {
                $0.dictionaryValue?["type"]?.stringValue != "toolResult"
            })
            nested[index] = AnyCodable(carrier)
        }
        let activity = try JSONDecoder().decode(
            [OpenClawChatHistoryActivity].self, from: Data("""
            [{"messageId":"fixture-nested-success-row","items":\(successPending ? """
            [{"itemId":"tool:fixture-nested-success","toolCallId":"fixture-nested-success","kind":"tool",
              "phase":"start","status":"running","title":"Knowledge status","name":"knowledge_status"}]
            """ : "[]")},
            {"messageId":"fixture-nested-pending-row","items":[
              {"itemId":"tool:fixture-nested-pending","toolCallId":"fixture-nested-pending","kind":"tool",
               "phase":"start","status":"running","title":"Knowledge status","name":"knowledge_status"}
            ]}]
            """.utf8))
        return (nested, activity)
    }

    /// Retained Claude CLI calls contain their own result. Empty thinking envelopes between them
    /// carry a signature, but no text for the reader.
    static func imageReview() throws -> [AnyCodable] {
        var rows = [#"{"role":"user","content":[{"type":"text","text":"Check the three image sizes"}]}"#]
        for (index, command) in [
            "ls previews",
            "ls exports",
            "sips -g pixelWidth preview.png",
            "sips -g pixelHeight preview.png",
            "ls thumbnails",
        ].enumerated() {
            if index == 2 || index == 3 {
                rows.append(#"{"role":"assistant","stopReason":"toolUse","provider":"claude-cli","content":["#
                    + #"{"type":"thinking","thinking":"","signature":"fixture"}]}"#)
            }
            let call = "image-check-\(index)"
            rows.append(#"{"role":"assistant","stopReason":"toolUse","provider":"claude-cli","content":["#
                + #"{"type":"toolcall","id":"\#(call)","name":"exec","arguments":{"command":"\#(command)"}},"#
                + #"{"type":"tool_result","id":"\#(call)","name":"exec","text":"Ready"}]}"#)
        }
        rows.append(#"{"role":"assistant","stopReason":"stop","provider":"claude-cli","content":["#
            + #"{"type":"text","text":"All three images are ready."}]}"#)
        return try JSONDecoder().decode([AnyCodable].self, from: Data("[\(rows.joined(separator: ","))]".utf8))
    }

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

    static func sentMessageHistory() throws -> [AnyCodable]? {
        if ProcessInfo.processInfo.arguments
            .contains("--openclaw-sent-messages-fixture") { return try self.sentMessages() }
        if ProcessInfo.processInfo.arguments
            .contains("--openclaw-cli-live-turn-fixture") { return try self.cliLiveTurn() }
        guard ProcessInfo.processInfo.arguments.contains("--openclaw-clock-media-fixture") else { return nil }
        let yesterday = Int(Date.now.timeIntervalSince1970 * 1000) - 86_400_000
        // A small synthetic mountain scene, decoded through the sent-photo path.
        let landscape = "iVBORw0KGgoAAAANSUhEUgAAAEgAAAAwCAIAAAA9/qu8AAAA90lEQVR42u3WTQoCMQwF4HdAjyOMV3Gh"
            + "Z5k7uBW8hyuRgUHoj2mbtkkm8JblkW8RGqzPl8nAYQ5z2NFh78d9ix3YTvqNelhURbc5TIyKaHOYw3zH"
            + "jgoz+49Zvjzm3IqX23WLKdiuEmtDu0qmDe0kmTwwqkTZwKuSYwMvSQ4PnVTTbeinYrRVtKEfiYVX3YYB"
            + "qjpbYyHGqIpsLJ0YQyLyGDsxWJWx8XZivCqcI/XmtJzDEGsxRZVJFJNKhgd1GCIS2j0pIWxgwqBlOGmY"
            + "eljRBk/x1MAoizsXUwyTMy4bTCPpP0yvKglTTYrDDJAiMDOqL8wSxmGa8wGVuQPLJjNLDgAAAABJRU5E"
            + "rkJggg=="
        return try JSONDecoder().decode([AnyCodable].self, from: Data(#"""
        [{"role":"user","timestamp":\#(yesterday),"__openclaw":{"id":"earlier"},
          "content":[{"type":"text","text":"From yesterday"}]},
         {"role":"user","timestamp":\#(yesterday + 1000),"__openclaw":{"id":"view"},
          "content":[{"type":"text","text":"Here’s the view"}]},
         {"role":"user","timestamp":\#(yesterday + 2000),"__openclaw":{"id":"landscape"},
          "content":[{"type":"image","mimeType":"image/png","fileName":"landscape.png","alt":"Mountain view",
                      "width":72,"height":48,"content":"\#(landscape)"}]}]
        """#.utf8))
    }

    private static func sentMessages() throws -> [AnyCodable] {
        let label = "iOS R3: new-chat composer shows provider and raw model id, and breaks into two rows"
        return try JSONDecoder().decode([AnyCodable].self, from: Data(#"""
        [{"role":"user","content":[{"type":"text","text":"Send the review notes"}]},
         {"role":"assistant","stopReason":"toolUse","provider":"claude-cli","content":[
           {"type":"toolcall","id":"named-send","name":"sessions_send","arguments":
            {"label":"\#(label)","message":"The composer is ready for review"}},
           {"type":"tool_result","id":"named-send","name":"sessions_send","text":"{\"status\":\"accepted\"}"}]},
         {"role":"assistant","stopReason":"toolUse","provider":"claude-cli","content":[
           {"type":"text","text":"I’ll send the preview too."}]},
         {"role":"assistant","stopReason":"toolUse","provider":"claude-cli","content":[
           {"type":"toolcall","id":"unnamed-send","name":"sessions_send","arguments":
            {"sessionKey":"agent:fixture:unlisted","message":"The preview is ready"}},
           {"type":"tool_result","id":"unnamed-send","name":"sessions_send","text":"{\"status\":\"queued\"}"}]},
         {"role":"assistant","stopReason":"stop","provider":"claude-cli","content":[
           {"type":"text","text":"Both updates are ready."}]}]
        """#.utf8))
    }

    /// A Claude CLI turn still running (Victor's iPhone, Nov 26): imported rows carry no run ID, empty
    /// thinking sits between calls, and a subagent launch follows two commands. The input belongs to the
    /// run that `--openclaw-goal-running-fixture` keeps active.
    private static func cliLiveTurn() throws -> [AnyCodable] {
        func imported(_ id: String, _ blocks: String) -> String {
            #"{"role":"assistant","stopReason":"toolUse","provider":"claude-cli","__openclaw":{"id":"\#(id)","#
                + #""importedFrom":"claude-cli","cliSessionId":"fixture-cli"},"content":[\#(blocks)]}"#
        }
        func call(_ id: String, _ tool: String, _ arguments: String, _ result: String) -> String {
            imported(
                id,
                #"{"type":"toolcall","id":"\#(id)","name":"mcp__openclaw__\#(tool)","#
                    + #""arguments":\#(arguments)},{"type":"tool_result","tool_use_id":"\#(id)","#
                    + #""name":"mcp__openclaw__\#(tool)","is_error":false,"#
                    + #""content":[{"type":"text","text":\#(result)}]}"#)
        }
        let thinking = #"{"type":"thinking","thinking":"","signature":"fixture"}"#
        let rows = [
            #"{"role":"user","idempotencyKey":"fixture-goal-run:user","content":[{"type":"text","#
                + #""text":"What is still missing from the iPhone?"}]}"#,
            imported("cli-t1", thinking),
            call("cli-e1", "exec", #"{"command":"git -C batch47/checkout log -1"}"#, #""a4848f1 Lote 47""#),
            imported("cli-t2", thinking),
            call("cli-e2", "exec", #"{"command":"git -C chat-info/checkout status -sb"}"#, #""clean""#),
            imported("cli-t3", thinking),
            call(
                "cli-s1",
                "sessions_spawn",
                #"{"label":"Port the reconnect fix","task":"Port it onto lote 47"}"#,
                #""{\"status\":\"accepted\",\"childSessionKey\":\"agent:main:subagent:fixture-port\"}""#),
            call(
                "cli-m1",
                "sessions_send",
                #"{"sessionKey":"agent:main:subagent:fixture-lander","message":"Pick the port"}"#,
                #""{\"status\":\"accepted\"}""#),
        ]
        return try JSONDecoder().decode([AnyCodable].self, from: Data("[\(rows.joined(separator: ","))]".utf8))
    }

    static func singleCommand() throws -> [AnyCodable] {
        try JSONDecoder().decode([AnyCodable].self, from: Data(#"""
        [{"role":"user","content":[{"type":"text","text":"Check the image width"}]},
         {"role":"assistant","stopReason":"toolUse","provider":"claude-cli","content":[
           {"type":"toolcall","id":"width","name":"exec","arguments":{"command":"sips -g pixelWidth preview.png"}},
           {"type":"tool_result","id":"width","name":"exec","text":"pixelWidth: 1206"}]},
         {"role":"assistant","stopReason":"stop","provider":"claude-cli","content":[
           {"type":"text","text":"The preview is 1206 pixels wide."}]}]
        """#.utf8))
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
