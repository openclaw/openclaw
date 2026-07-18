import Testing
@testable import OpenClaw

@Suite(.serialized)
struct QuickChatFocusedTextCollectorTests {
    @Test func `collector de-duplicates string values and computed names`() {
        let child = FakeTextNode(id: 2, stringValue: "same", computedName: "other")
        let root = FakeTextNode(id: 1, stringValue: "same", computedName: "same", children: [child])

        let result = QuickChatFocusedTextCollector.collect(root: root)

        #expect(result.text == "same\nother")
        #expect(result.textEntryCount == 2)
        #expect(!result.wasTruncated)
    }

    @Test func `collector enforces depth cap`() {
        let deepest = FakeTextNode(id: 3, stringValue: "too deep")
        let child = FakeTextNode(id: 2, stringValue: "child", children: [deepest])
        let root = FakeTextNode(id: 1, stringValue: "root", children: [child])

        let result = QuickChatFocusedTextCollector.collect(
            root: root,
            limits: QuickChatTextCollectionLimits(
                maximumDepth: 1,
                maximumElements: 20,
                maximumCharacters: 100))

        #expect(result.text.contains("root"))
        #expect(result.text.contains("child"))
        #expect(!result.text.contains("too deep"))
        #expect(result.text.hasSuffix(QuickChatFocusedTextCollector.truncationMarker))
        #expect(result.visitedElementCount == 2)
    }

    @Test func `collector enforces element cap`() {
        let children = (2...12).map { FakeTextNode(id: UInt64($0), stringValue: "item \($0)") }
        let root = FakeTextNode(id: 1, stringValue: "root", children: children)

        let result = QuickChatFocusedTextCollector.collect(
            root: root,
            limits: QuickChatTextCollectionLimits(
                maximumDepth: 12,
                maximumElements: 3,
                maximumCharacters: 100))

        #expect(result.visitedElementCount == 3)
        #expect(result.wasTruncated)
        #expect(result.text.hasSuffix(QuickChatFocusedTextCollector.truncationMarker))
    }

    @Test func `collector enforces character cap with marker`() {
        let root = FakeTextNode(id: 1, stringValue: String(repeating: "a", count: 200))

        let result = QuickChatFocusedTextCollector.collect(
            root: root,
            limits: QuickChatTextCollectionLimits(
                maximumDepth: 12,
                maximumElements: 800,
                maximumCharacters: 40))

        #expect(result.text.count == 40)
        #expect(result.text.hasSuffix(QuickChatFocusedTextCollector.truncationMarker))
        #expect(result.wasTruncated)
    }

    @Test func `collector treats the exact sentinel character as truncation`() {
        let root = FakeTextNode(id: 1, stringValue: String(repeating: "a", count: 41))

        let result = QuickChatFocusedTextCollector.collect(
            root: root,
            limits: QuickChatTextCollectionLimits(
                maximumDepth: 12,
                maximumElements: 800,
                maximumCharacters: 40))

        #expect(result.text.count == 40)
        #expect(result.text.hasSuffix(QuickChatFocusedTextCollector.truncationMarker))
        #expect(result.wasTruncated)
    }
}

private final class FakeTextNode: QuickChatTextTreeNode, Sendable {
    let identity: UInt64
    let storedStringValue: String?
    let storedComputedName: String?
    let childNodes: [FakeTextNode]

    init(
        id: UInt64,
        stringValue: String? = nil,
        computedName: String? = nil,
        children: [FakeTextNode] = [])
    {
        self.identity = id
        self.storedStringValue = stringValue
        self.storedComputedName = computedName
        self.childNodes = children
    }

    func stringValue() -> String? {
        self.storedStringValue
    }

    func computedName() -> String? {
        self.storedComputedName
    }

    func children(limit: Int) -> QuickChatTextTreeChildren {
        QuickChatTextTreeChildren(
            nodes: Array(self.childNodes.prefix(limit)),
            wasTruncated: self.childNodes.count > limit)
    }
}
