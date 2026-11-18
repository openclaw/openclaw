import Foundation
import Testing
import UIKit
@testable import OpenClawChatUI

@MainActor
enum TranscriptToolAccessibility {
    static func identifier(of node: NSObject) -> String? {
        (node as? any UIAccessibilityIdentification)?.accessibilityIdentifier
    }

    /// SwiftUI vends virtual elements: UIView-only recursion cannot exercise its actual controls or output.
    static func nodes(in root: NSObject) -> [NSObject] {
        var pending = [root]
        var visited = Set<ObjectIdentifier>()
        var nodes: [NSObject] = []
        while let node = pending.popLast() {
            guard visited.insert(ObjectIdentifier(node)).inserted else { continue }
            nodes.append(node)
            if let view = node as? UIView { pending.append(contentsOf: view.subviews) }
            if let elements = node
                .accessibilityElements { pending.append(contentsOf: elements.compactMap { $0 as? NSObject }) }
            let count = node.accessibilityElementCount()
            if count > 0, count != NSNotFound {
                for index in 0..<count {
                    if let element = node.accessibilityElement(at: index) as? NSObject { pending.append(element) }
                }
            }
        }
        return nodes
    }

    static func requireResult(
        _ list: UICollectionView,
        host: UIViewController,
        callID: String,
        title: String,
        status: String,
        output: String,
        onFailure: (([String]) -> Void)? = nil) async throws
    {
        let identifier = "chat-tool-activity-" + callID
        var trace: [String] = []
        for section in 0..<list.numberOfSections {
            for item in 0..<list.numberOfItems(inSection: section) {
                let path = IndexPath(item: item, section: section)
                list.scrollToItem(at: path, at: .top, animated: false)
                try await TestWait.state("native nested result cell is realized") {
                    host.view.layoutIfNeeded()
                    return list.cellForItem(at: path) != nil && !list.hasUncommittedUpdates
                }
                let cell = try #require(list.cellForItem(at: path))
                var nodes = Self.nodes(in: cell)
                let tracing = onFailure != nil && trace.count < 32
                let initialCount = nodes.count
                var activation = "quietFound=false activated=not-attempted"
                if !nodes.contains(where: { Self.identifier(of: $0) == identifier }),
                   let disclosure = nodes.first(where: { $0.accessibilityLabel == "Tool details" })
                {
                    let previousElements = Set(nodes.map(ObjectIdentifier.init))
                    let previousValue = disclosure.accessibilityValue
                    let activated = disclosure.accessibilityActivate()
                    if tracing {
                        activation = "quiet=true activated=\(activated) wasCollapsed=\(previousValue == "Collapsed")"
                    }
                    try #require(activated, "Tool details must activate its real disclosure")
                    try await TestWait.state("quiet tool disclosure exposes its actual children") {
                        host.view.layoutIfNeeded()
                        return Set(Self.nodes(in: cell).map(ObjectIdentifier.init)) != previousElements ||
                            disclosure.accessibilityValue != previousValue
                    }
                    nodes = Self.nodes(in: cell)
                    if tracing { activation += " afterExpanded=\(disclosure.accessibilityValue == "Expanded")" }
                }
                let control = nodes.first(where: { Self.identifier(of: $0) == identifier })
                if tracing {
                    trace.append("path=\(section)/\(item) nodes=\(initialCount)->\(nodes.count) " +
                        "cell=\(ObjectIdentifier(cell)) \(activation) requiredControlFound=\(control != nil)")
                }
                guard let control else { continue }
                #expect(control.accessibilityLabel == title)
                #expect(control.accessibilityValue?.hasPrefix(status) == true)
                #expect(control.accessibilityTraits.contains(.button))
                try #require(control.accessibilityHint == "Expand tool result")
                try #require(
                    control.accessibilityActivate(),
                    "Result must expand through its actual accessible control")
                try await TestWait.state("expanded nested result is exposed within its realized native cell") {
                    host.view.layoutIfNeeded()
                    return Self.nodes(in: cell).contains { $0.accessibilityLabel == output }
                }
                return
            }
        }
        onFailure?(trace)
        throw NSError(
            domain: "TranscriptToolAccessibility",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "No realized native cell exposes nested tool result \(callID)"])
    }

    /// Diagnostic-only; the production fixture callers leave onFailure nil.
    static func recordFailure(trace: [String], list: UICollectionView, host: UIViewController) {
        var facts = trace
        let identifiers = ["chat-transcript", "chat-assistant-message-body", "chat-tool-activity-nested-call"]
        let labels = ["Tool details", "Knowledge Status", "Nested success output"]
        let values = ["Collapsed", "Expanded", "Finished", "Working"]
        var roots: [(String, NSObject)] = [("list", list), ("host", host.view)]
        if let cell = list.visibleCells.first { roots.insert(("cell", cell), at: 0) }
        for (scope, root) in roots {
            var pending: [(String, NSObject)] = [("root", root)]
            var visited = Set<ObjectIdentifier>()
            while visited.count < 170, let (edge, node) = pending.popLast() {
                let identity = ObjectIdentifier(node)
                guard visited.insert(identity).inserted else { continue }
                let views = (node as? UIView)?.subviews ?? []
                let count = node.accessibilityElementCount()
                let elements = node.accessibilityElements ??
                    (0..<(count == NSNotFound ? 0 : min(max(0, count), 512)))
                    .compactMap { node.accessibilityElement(at: $0) }
                let automation = node.automationElements ?? []
                let identifier = TranscriptToolAccessibility.identifier(of: node) ?? "nil"
                let label = node.accessibilityLabel ?? "nil"
                let value = node.accessibilityValue ?? "nil"
                if node is UICollectionView || identifiers.contains(identifier) || labels.contains(label) {
                    facts.append("\(scope) \(edge)->\(identity) collection=\(node is UICollectionView) " +
                        "id=\(identifiers.contains(identifier) ? identifier : "other") " +
                        "label=\(labels.contains(label) ? label : "other") " +
                        "value=\(values.contains(value) ? value : "other") " +
                        "traits=\(node.accessibilityTraits.rawValue) AXFrame=\(node.accessibilityFrame) " +
                        "UIView=\(views.count) AX=\(elements.count)/\(count) automation=\(automation.count)")
                }
                pending += views.prefix(max(0, 512 - pending.count)).map { ("\(identity).UIView", $0) }
                pending += elements.prefix(max(0, 512 - pending.count))
                    .compactMap { ($0 as? NSObject).map { ("\(identity).AX", $0) } }
                pending += automation.prefix(max(0, 512 - pending.count))
                    .compactMap { ($0 as? NSObject).map { ("\(identity).automation", $0) } }
            }
            facts.append("scope=\(scope) inspected=\(visited.count) pending=\(pending.count) partial=true")
        }
        let size = host.view.bounds.size
        var drew = false
        var pngBytes = 0
        if size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0,
           size.width <= 1180, size.height <= 820
        {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                drew = host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: false)
            }
            if let png = image.pngData(), !png.isEmpty {
                pngBytes = png.count
                Attachment.record([UInt8](png), named: "native-nested-failure.png")
            }
        }
        facts.append("captureDrawSucceeded=\(drew) pngBytes=\(pngBytes) unavailable=\(pngBytes == 0)")
        let text = facts.joined(separator: "\n")
        let bounded = String(bytes: text.utf8.prefix(65400), encoding: .utf8) ?? "captureTextEncodingUnavailable=true"
        Attachment.record(
            bounded + "\ntextTruncated=\(text.utf8.count > 65400)", named: "native-nested-failure.txt")
    }

    static func requireNestedResults(
        model: OpenClawChatViewModel, list: UICollectionView, host: UIViewController) async throws
    {
        // Sanitized original envelope shape; this is not proof of the installed screenshot's pixels.
        let nested = try #require(model.messages.first { $0.content.contains { $0.id == "nested-call" } })
        let activity = ChatToolActivity.items(message: nested).first
        #expect(activity?.name == "read" && activity?.resultText == "Recorded nested output" && activity?
            .isError == true)
        try await Self.requireResult(
            list,
            host: host,
            callID: "nested-call",
            title: "Read",
            status: "Failed",
            output: "Recorded nested output")
        try await Self.requireResult(
            list,
            host: host,
            callID: "nested-success",
            title: "Knowledge Status",
            status: "Finished",
            output: "Sanitized nested success output")
    }
}
