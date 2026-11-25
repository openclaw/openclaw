import Foundation
import FoundationModels

private struct BridgeError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) {
        self.description = description
    }
}

private struct ToolBoundary: Error {}

private struct PendingCall: Sendable {
    let id: String
    let name: String
    let arguments: String
}

private actor ToolCalls {
    private var calls: [PendingCall] = []
    func record(name: String, arguments: GeneratedContent) {
        self.calls.append(PendingCall(id: UUID().uuidString, name: name, arguments: arguments.jsonString))
    }

    func snapshot() -> [PendingCall] {
        self.calls
    }
}

private struct HostTool: Tool {
    typealias Arguments = GeneratedContent
    typealias Output = String
    let name: String
    let description: String
    let parameters: GenerationSchema
    let calls: ToolCalls

    func call(arguments: GeneratedContent) async throws -> String {
        await self.calls.record(name: self.name, arguments: arguments)
        // OpenClaw owns execution and approval. Stop the native loop before any tool executes.
        throw ToolBoundary()
    }
}

private func object(_ value: Any?, _ label: String) throws -> [String: Any] {
    guard let value = value as? [String: Any] else { throw BridgeError("Expected object: \(label)") }
    return value
}

private func string(_ value: Any?, _ label: String) throws -> String {
    guard let value = value as? String else { throw BridgeError("Expected string: \(label)") }
    return value
}

private func encodedJSON(_ value: Any) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])
    guard let text = String(data: data, encoding: .utf8) else { throw BridgeError("Invalid UTF-8 JSON") }
    return text
}

private func integer(_ value: Any?, _ label: String) throws -> Int? {
    guard let value else { return nil }
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
          let result = Int(exactly: number.doubleValue)
    else { throw BridgeError("Expected integer: \(label)") }
    return result
}

private func number(_ value: Any?, _ label: String) throws -> Double? {
    guard let value else { return nil }
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite
    else { throw BridgeError("Expected number: \(label)") }
    return number.doubleValue
}

private func dynamicSchema(_ schema: [String: Any], name: String) throws -> DynamicGenerationSchema {
    let supported: Set = [
        "type",
        "title",
        "description",
        "properties",
        "required",
        "items",
        "enum",
        "const",
        "anyOf",
        "default",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "minItems",
        "maxItems",
        "pattern",
        "additionalProperties",
        "$schema",
        "x-order",
    ]
    if let key = schema.keys.sorted().first(where: { !supported.contains($0) }) {
        throw BridgeError("Unsupported schema keyword \(key) in \(name)")
    }
    if let alternatives = schema["anyOf"] {
        let annotations: Set = ["anyOf", "title", "description", "default", "$schema"]
        guard schema.keys.allSatisfy(annotations.contains),
              let alternatives = alternatives as? [[String: Any]], !alternatives.isEmpty
        else { throw BridgeError("Unsupported combined anyOf schema: \(name)") }
        return try .init(name: name, anyOf: alternatives.enumerated().map { index, alternative in
            try dynamicSchema(alternative, name: "\(name)_option\(index)")
        })
    }
    if let types = schema["type"] as? [String] {
        guard !types.isEmpty else { throw BridgeError("Schema type union is empty: \(name)") }
        return try .init(name: name, anyOf: types.enumerated().map { index, type in
            var alternative = schema
            alternative["type"] = type
            return try dynamicSchema(alternative, name: "\(name)_option\(index)")
        })
    }
    let type = try string(schema["type"], "\(name).type")
    if let literal = schema["const"] {
        guard type == "string", let literal = literal as? String else {
            throw BridgeError("Only string literal schemas are supported: \(name)")
        }
        return DynamicGenerationSchema(name: name, anyOf: [literal])
    }
    if let choices = schema["enum"] {
        guard type == "string", let choices = choices as? [String], !choices.isEmpty else {
            throw BridgeError("Only nonempty string enums are supported: \(name)")
        }
        return DynamicGenerationSchema(name: name, anyOf: choices)
    }
    switch type {
    case "object":
        if let additional = schema["additionalProperties"], !(additional as? Bool == false) {
            throw BridgeError("Additional object properties are unsupported: \(name)")
        }
        let fields = try object(schema["properties"] ?? [:], "\(name).properties")
        guard let required = (schema["required"] ?? []) as? [String],
              Set(required).isSubset(of: Set(fields.keys))
        else {
            throw BridgeError("Invalid required properties: \(name)")
        }
        let properties = try fields.keys.sorted().map { key -> DynamicGenerationSchema.Property in
            let field = try object(fields[key], "\(name).\(key)")
            return try .init(
                name: key,
                description: field["description"] as? String,
                schema: dynamicSchema(field, name: "\(name)_\(key)"),
                isOptional: !required.contains(key))
        }
        return .init(name: name, properties: properties)
    case "array":
        return try .init(
            arrayOf: dynamicSchema(object(schema["items"], "\(name).items"), name: "\(name)_item"),
            minimumElements: integer(schema["minItems"], "\(name).minItems"),
            maximumElements: integer(schema["maxItems"], "\(name).maxItems"))
    case "integer":
        var guides: [GenerationGuide<Int>] = []
        if let value = try integer(schema["minimum"], "\(name).minimum") { guides.append(.minimum(value)) }
        if let value = try integer(schema["maximum"], "\(name).maximum") { guides.append(.maximum(value)) }
        return .init(type: Int.self, guides: guides)
    case "number":
        var guides: [GenerationGuide<Double>] = []
        if let value = try number(schema["minimum"], "\(name).minimum") { guides.append(.minimum(value)) }
        if let value = try number(schema["maximum"], "\(name).maximum") { guides.append(.maximum(value)) }
        return .init(type: Double.self, guides: guides)
    case "boolean": return .init(type: Bool.self)
    case "null": return .null
    case "string":
        let minimum = try integer(schema["minLength"], "\(name).minLength") ?? 0
        let maximum = try integer(schema["maxLength"], "\(name).maxLength")
        guard minimum >= 0, maximum.map({ $0 >= minimum }) ?? true else {
            throw BridgeError("Invalid string length bounds: \(name)")
        }
        // AFM has no length guides and rejects regex guides. Host validation retains these constraints.
        return .init(type: String.self)
    default: throw BridgeError("Unsupported schema type \(type) in \(name)")
    }
}

private func generationSchema(_ value: Any?, name: String) throws -> GenerationSchema {
    try GenerationSchema(root: dynamicSchema(object(value, name), name: name), dependencies: [])
}

private func textParts(_ content: Any?) throws -> [String] {
    if let text = content as? String { return [text] }
    guard let blocks = content as? [[String: Any]] else { throw BridgeError("Expected message content") }
    return try blocks.map { block in
        guard block["type"] as? String == "text" else {
            throw BridgeError("Only text content is supported for user and tool-result messages")
        }
        return try string(block["text"], "content.text")
    }
}

private func segments(_ parts: [String]) -> [Transcript.Segment] {
    parts.map { .text(.init(content: $0)) }
}

private func replay(
    _ messages: [[String: Any]],
    instructions: String,
    tools: [HostTool]) throws -> (Transcript, Prompt)
{
    var history = messages
    var prompt = Prompt {}
    if history.last?["role"] as? String == "user", let last = history.popLast() {
        prompt = try Prompt(textParts(last["content"]))
    }
    var entries: [Transcript.Entry] = [.instructions(.init(
        segments: segments([instructions]),
        toolDefinitions: tools.map { .init(tool: $0) }))]
    var pending: [String: String] = [:]
    for message in history {
        switch try string(message["role"], "message.role") {
        case "user":
            try entries.append(.prompt(.init(segments: segments(textParts(message["content"])))))
        case "assistant":
            guard let blocks = message["content"] as? [[String: Any]] else {
                throw BridgeError("Expected assistant content blocks")
            }
            for block in blocks {
                switch try string(block["type"], "assistant.content.type") {
                case "text":
                    try entries.append(.response(.init(segments: segments([string(block["text"], "text")]))))
                case "thinking":
                    try entries.append(.reasoning(.init(segments: segments([string(block["thinking"], "thinking")]))))
                case "toolCall":
                    let id = try string(block["id"], "toolCall.id")
                    let name = try string(block["name"], "toolCall.name")
                    guard pending[id] == nil else { throw BridgeError("Duplicate tool call id") }
                    pending[id] = name
                    let arguments = try GeneratedContent(json: encodedJSON(object(
                        block["arguments"],
                        "toolCall.arguments")))
                    entries.append(.toolCalls(.init([.init(id: id, toolName: name, arguments: arguments)])))
                default: throw BridgeError("Unsupported assistant content block")
                }
            }
        case "toolResult":
            let id = try string(message["toolCallId"], "toolResult.toolCallId")
            let name = try string(message["toolName"], "toolResult.toolName")
            guard pending.removeValue(forKey: id) == name else { throw BridgeError("Unmatched tool result") }
            try entries.append(.toolOutput(.init(
                id: id,
                toolName: name,
                segments: segments(textParts(message["content"])))))
        default: throw BridgeError("Unsupported message role")
        }
    }
    guard pending.isEmpty else { throw BridgeError("Tool calls are missing results") }
    // An empty prompt resumes after tool output without adding synthetic user instructions.
    return (Transcript(entries: entries), prompt)
}

@MainActor
private func run(_ request: [String: Any], model: SystemLanguageModel) async throws -> [String: Any] {
    guard model.isAvailable else { throw BridgeError("Apple Intelligence is unavailable: \(model.availability)") }
    guard let messages = request["messages"] as? [[String: Any]], !messages.isEmpty else {
        throw BridgeError("At least one message is required")
    }
    let calls = ToolCalls()
    guard let toolInputs = (request["tools"] ?? []) as? [[String: Any]]
    else { throw BridgeError("Expected tools array") }
    let tools = try toolInputs.map { tool in
        try HostTool(
            name: string(tool["name"], "tool.name"),
            description: string(tool["description"], "tool.description"),
            parameters: generationSchema(tool["parameters"], name: string(tool["name"], "tool.name")),
            calls: calls)
    }
    guard Set(tools.map(\.name)).count == tools.count else { throw BridgeError("Duplicate tool name") }
    let maxTokens = try integer(request["maxTokens"], "maxTokens")
    guard maxTokens == nil || maxTokens! > 0 else { throw BridgeError("maxTokens must be positive") }
    let options = try GenerationOptions(
        temperature: number(request["temperature"], "temperature"),
        maximumResponseTokens: maxTokens)
    let instructions = try request["systemPrompt"].map { try string($0, "systemPrompt") } ?? ""
    let (transcript, prompt) = try replay(messages, instructions: instructions, tools: tools)
    let session = LanguageModelSession(model: model, tools: tools, transcript: transcript)
    let inputTokens = try await model.tokenCount(for: transcript) + model.tokenCount(for: prompt)
    do {
        if let schema = request["responseFormat"] {
            let response = try await session.respond(
                to: prompt,
                schema: generationSchema(schema, name: "Response"),
                options: options)
            return [
                "text": response.content.jsonString,
                "toolCalls": [],
                "inputTokens": response.usage.input.totalTokenCount,
                "outputTokens": response.usage.output.totalTokenCount,
            ]
        }
        let response = try await session.respond(to: prompt, options: options)
        return [
            "text": response.content,
            "toolCalls": [],
            "inputTokens": response.usage.input.totalTokenCount,
            "outputTokens": response.usage.output.totalTokenCount,
        ]
    } catch let error as LanguageModelSession.ToolCallError where error.underlyingError is ToolBoundary {
        let captured = await calls.snapshot()
        guard !captured.isEmpty else { throw BridgeError("Native tool boundary had no call") }
        let output = try captured.map { call -> [String: Any] in
            let arguments = try JSONSerialization.jsonObject(with: Data(call.arguments.utf8))
            return try ["id": call.id, "name": call.name, "arguments": object(arguments, "generated arguments")]
        }
        // A throwing tool rolls back native transcript additions, so count the emitted calls directly.
        let emittedCalls = try captured.map { call in
            try Transcript.ToolCall(
                id: call.id,
                toolName: call.name,
                arguments: GeneratedContent(json: call.arguments))
        }
        let outputTokens = try await model.tokenCount(for: [Transcript.Entry.toolCalls(.init(emittedCalls))])
        return ["text": "", "toolCalls": output, "inputTokens": inputTokens, "outputTokens": outputTokens]
    }
}

@main
private struct AppleFoundationModels {
    @MainActor static func main() async {
        do {
            let model = SystemLanguageModel.default
            let result: [String: Any]
            if CommandLine.arguments.dropFirst().first == "info" {
                switch model.availability {
                case .available:
                    result = [
                        "available": true,
                        "modelName": model.variant.displayName,
                        "contextWindow": model.contextSize,
                    ]
                case let .unavailable(reason):
                    let message = switch reason {
                    case .appleIntelligenceNotEnabled:
                        "Enable Apple Intelligence in System Settings, then retry setup."
                    case .modelNotReady:
                        "Wait for Apple Intelligence to finish downloading its model, then retry setup."
                    case .deviceNotEligible:
                        "This Mac is not eligible for Apple Intelligence. Choose another model."
                    @unknown default:
                        "Apple Intelligence is unavailable. Check System Settings, then retry setup."
                    }
                    result = [
                        "available": false,
                        "modelName": "Apple Foundation Models",
                        "contextWindow": 0,
                        "reason": message,
                    ]
                }
            } else {
                let limit = 2 * 1024 * 1024
                var data = Data()
                while let chunk = try FileHandle.standardInput.read(upToCount: min(65536, limit + 1 - data.count)),
                      !chunk.isEmpty
                {
                    data.append(chunk)
                    guard data.count <= limit else { throw BridgeError("Request exceeds 2 MiB") }
                }
                result = try await run(object(JSONSerialization.jsonObject(with: data), "request"), model: model)
            }
            try FileHandle.standardOutput.write(Data((encodedJSON(result) + "\n").utf8))
        } catch {
            let message = String(describing: error)
            if let data = try? JSONSerialization.data(withJSONObject: ["error": message], options: [.sortedKeys]) {
                FileHandle.standardOutput.write(data)
                FileHandle.standardOutput.write(Data([10]))
            }
        }
    }
}
