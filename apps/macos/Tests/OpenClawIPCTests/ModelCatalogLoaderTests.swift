import Foundation
import Testing
@testable import OpenClaw

struct ModelCatalogLoaderTests {
    @Test
    func `load parses models from type script and sorts`() async throws {
        let src = """
        export const MODELS = {
          openai: {
            "gpt-4o-mini": { name: "GPT-4o mini", contextWindow: 128000 } satisfies any,
            "gpt-4o": { name: "GPT-4o", contextWindow: 128000 } as any,
            "gpt-3.5": { contextWindow: 16000 },
          },
          anthropic: {
            "claude-3": { name: "Claude 3", contextWindow: 200000 },
          },
        };
        """

        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("models-\(UUID().uuidString).ts")
        defer { try? FileManager().removeItem(at: tmp) }
        try src.write(to: tmp, atomically: true, encoding: .utf8)

        let choices = try await ModelCatalogLoader.load(from: tmp.path)
        #expect(choices.count == 4)
        #expect(choices.first?.provider == "anthropic")
        #expect(choices.first?.id == "claude-3")

        let ids = Set(choices.map(\.id))
        #expect(ids == Set(["claude-3", "gpt-4o", "gpt-4o-mini", "gpt-3.5"]))

        let openai = choices.filter { $0.provider == "openai" }
        let openaiNames = openai.map(\.name)
        #expect(openaiNames == openaiNames.sorted { a, b in
            a.localizedCaseInsensitiveCompare(b) == .orderedAscending
        })
    }

    @Test
    func `load with no export returns empty choices`() async throws {
        let src = "const NOPE = 1;"
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("models-\(UUID().uuidString).ts")
        defer { try? FileManager().removeItem(at: tmp) }
        try src.write(to: tmp, atomically: true, encoding: .utf8)

        let choices = try await ModelCatalogLoader.load(from: tmp.path)
        #expect(choices.isEmpty)
    }

    @Test
    func `load rejects computed property expressions`() async throws {
        let src = """
        export const MODELS = {
          [(() => "openai")()]: {
            "gpt-4o": { name: "GPT-4o", contextWindow: 128000 },
          },
        };
        """
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("models-\(UUID().uuidString).ts")
        defer { try? FileManager().removeItem(at: tmp) }
        try src.write(to: tmp, atomically: true, encoding: .utf8)

        do {
            _ = try await ModelCatalogLoader.load(from: tmp.path)
            Issue.record("Expected model catalog loader to reject computed property expressions")
        } catch {
            // Expected: the loader should only accept inert object literals.
        }
    }

    @Test
    func `load parses generated catalog style payloads`() async throws {
        let src = """
        export const MODELS = {
          "amazon-bedrock": {
            "amazon.nova-pro-v1:0": {
              id: "amazon.nova-pro-v1:0",
              name: "Nova Pro",
              api: "bedrock-converse-stream",
              provider: "amazon-bedrock",
              baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
              reasoning: false,
              input: ["text", "image"],
              cost: {
                input: 2.5,
                output: 12.5,
                cacheRead: 0,
                cacheWrite: 0,
              },
              contextWindow: 1000000,
              maxTokens: 16384,
            },
          },
        };
        """
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("models-\(UUID().uuidString).ts")
        defer { try? FileManager().removeItem(at: tmp) }
        try src.write(to: tmp, atomically: true, encoding: .utf8)

        let choices = try await ModelCatalogLoader.load(from: tmp.path)
        #expect(choices.count == 1)
        #expect(choices.first?.provider == "amazon-bedrock")
        #expect(choices.first?.id == "amazon.nova-pro-v1:0")
        #expect(choices.first?.contextWindow == 1000000)
    }

    @Test
    func `load preserves quoted strings that contain type-assertion words and numeric underscores`() async throws {
        let src = """
        export const MODELS = {
          openai: {
            "qwen3:14b-q8_0": {
              name: "Model serves as a routing layer",
              description: "still satisfies the compatibility contract",
              contextWindow: 128000,
            } as any,
          },
        };
        """
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("models-\(UUID().uuidString).ts")
        defer { try? FileManager().removeItem(at: tmp) }
        try src.write(to: tmp, atomically: true, encoding: .utf8)

        let choices = try await ModelCatalogLoader.load(from: tmp.path)
        #expect(choices.count == 1)
        #expect(choices.first?.id == "qwen3:14b-q8_0")
        #expect(choices.first?.name == "Model serves as a routing layer")
    }

    @Test
    func `load rejects malformed MODELS exports`() async throws {
        let src = """
        export const MODELS = {
          openai: {
            "gpt-4o": { name: "GPT-4o", contextWindow: 128000 },
          }
        """
        let tmp = FileManager().temporaryDirectory
            .appendingPathComponent("models-\(UUID().uuidString).ts")
        defer { try? FileManager().removeItem(at: tmp) }
        try src.write(to: tmp, atomically: true, encoding: .utf8)

        do {
            _ = try await ModelCatalogLoader.load(from: tmp.path)
            Issue.record("Expected model catalog loader to reject malformed MODELS exports")
        } catch {
            // Expected: missing closing braces should be treated as a broken catalog, not an empty one.
        }
    }
}
