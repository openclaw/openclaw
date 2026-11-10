import CoreText
import Foundation
import Testing
import UIKit
@testable import OpenClaw

struct OpenClawTypographyTests {
    @Test func `bundled fonts load from app bundle`() {
        for name in OpenClawType.registeredPostScriptNames {
            #expect(UIFont(name: name, size: 12) != nil, "Missing bundled font: \(name)")
        }
    }

    @Test func `dynamic type scales display fonts`() {
        guard let base = UIFont(name: "RedHatDisplay-Regular", size: 34) else {
            Issue.record("RedHatDisplay-Regular should be bundled")
            return
        }

        let defaultTraits = UITraitCollection(preferredContentSizeCategory: .large)
        let largeTraits = UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge)
        let metrics = UIFontMetrics(forTextStyle: .largeTitle)

        let defaultSize = metrics.scaledFont(for: base, compatibleWith: defaultTraits).pointSize
        let largeSize = metrics.scaledFont(for: base, compatibleWith: largeTraits).pointSize

        #expect(largeSize > defaultSize)
    }

    @Test func `display variable weight axis instantiates heavy weights`() {
        guard UIFont(name: "RedHatDisplay-Regular", size: 15) != nil else {
            Issue.record("RedHatDisplay-Regular should be bundled")
            return
        }

        let weightAxis = NSNumber(value: 2_003_265_652) // "wght"
        let descriptor = UIFontDescriptor(fontAttributes: [
            .name: "RedHatDisplay-Regular",
            kCTFontVariationAttribute as UIFontDescriptor.AttributeName: [weightAxis: 900],
        ])
        let font = UIFont(descriptor: descriptor, size: 15)
        let variations = font.fontDescriptor.object(
            forKey: kCTFontVariationAttribute as UIFontDescriptor.AttributeName) as? [NSNumber: Any]
        let weightValue = variations?[weightAxis] as? NSNumber

        #expect(weightValue?.doubleValue == 900)
    }

    @Test func `activity widget registers bundled branded fonts`() throws {
        // The widget has no test host; the Watch loads these fonts in OpenClawWatchTests.
        let project = try String(contentsOf: Self.projectYmlURL(), encoding: .utf8)
        let plist = try String(contentsOf: Self.activityWidgetInfoPlistURL(), encoding: .utf8)
        let target = try Self.extract(project, from: "  OpenClawActivityWidget:", to: "  OpenClawWatchApp:")

        #expect(target.contains("- path: Sources/Fonts"))
        #expect(target.contains("UIAppFonts:"))
        #expect(plist.contains("<key>UIAppFonts</key>"))
        for font in Self.bundledFontFiles {
            #expect(target.contains("- \(font)"))
            #expect(plist.contains("<string>\(font)</string>"))
        }
    }

    @Test func `activity widget fonts scale relative to Dynamic Type text styles`() throws {
        // The widget has no test host, so its scaling helpers stay source-audited.
        let source = try String(contentsOf: Self.activityWidgetTypographySourceURL(), encoding: .utf8)
        #expect(source.contains("relativeTo: .subheadline"))
        #expect(source.contains("relativeTo: .caption"))
        #expect(!source.contains(".custom(\"RedHatDisplay-Regular\", size: size).weight"))
        #expect(!source.contains(".custom(\"Inter-Regular\", size: size)"))
    }

    @MainActor
    @Test func `Dynamic Type refresh applies the clamped branded font to search fields`() throws {
        defer { OpenClawType.installUIKitAppearance() }
        let window = UIWindow()
        let searchField = UISearchTextField()
        window.addSubview(searchField)
        searchField.font = .systemFont(ofSize: 17)

        UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge).performAsCurrent {
            OpenClawType.refreshUIKitAppearance(in: [window])
        }

        let font = try #require(searchField.font)
        #expect(font.familyName == "Inter")
        #expect(font.pointSize == 22)
    }

    @Test func `iOS app text and control calls keep branded font boundaries`() throws {
        let offenders = try Self.unbrandedTextCallOffenders()
        #expect(offenders.isEmpty, Comment(rawValue: offenders.joined(separator: "\n")))
    }

    @Test func `font boundary scanner permits inheritance and rejects system overrides`() {
        let source = """
        Text("Inherited")
        Text("Branded")
            .padding()
            .font(OpenClawType.body)
        Text("System")
            .padding()
            .font(.body)
        Button("System") {}
            .font(.headline)
        VStack {
            Text("Inherited system")
        }
        .font(.body)
        Text("Trailing closure")
            .background { Color.clear }
            .font(.caption)
        Text("Later override")
            .font(OpenClawType.body)
            .font(.title)
        NavigationStack {
            Text("Custom boundary")
        }
        .font(.footnote)
        Button {
            action()
        } label: {
            Text("Closure-only control")
        }
        .font(.headline)
        Image(systemName: "checkmark")
            .font(.system(size: 14))
        """

        let offenders = Self.unbrandedTextCallOffenders(in: source, relativePath: "Sample.swift")
        #expect(offenders.count == 7)
        #expect(offenders[0].contains(".font(.body)"))
        #expect(offenders[1].contains(".font(.headline)"))
        #expect(offenders[2].contains(".font(.body)"))
        #expect(offenders[3].contains(".font(.caption)"))
        #expect(offenders[4].contains(".font(.title)"))
        #expect(offenders[5].contains(".font(.footnote)"))
        #expect(offenders[6].contains(".font(.headline)"))
    }

    @Test func `accessibility metadata text does not require visual typography`() throws {
        let accessibilityTextSamples = [
            ".accessibilityLabel(Text(title))",
            "Image(systemName: \"circle\").accessibilityLabel(Text(title))",
            ".accessibilityLabel(Text(title)).accessibilityIdentifier(\"status\")",
            "Image(systemName: \"circle\").accessibilityLabel(Text(title)).accessibilityHint(Text(hint))",
            ".accessibilityLabel(Text(self.statusLabel ?? LocalizedStringResource(\"Allowed\")))",
            ".accessibilityLabel(Text(title))\n)",
            ".accessibilityLabel(\n    Text(title)\n)",
            "Image(systemName: \"circle\")\n    .accessibilityLabel(\n        Text(title)\n    )",
            ".accessibilityValue(\n    Text(value))",
            ".accessibilityHint(\n\n    Text(hint))",
        ]
        for source in accessibilityTextSamples {
            let lines = source.components(separatedBy: .newlines)
            let idx = try #require(lines.firstIndex { Self.isTextOrLabelCall($0) })
            #expect(Self.isAccessibilityMetadataTextCall(at: idx, in: lines))
        }

        #expect(!Self.isAccessibilityMetadataTextCall(at: 0, in: ["Text(title)"]))
        #expect(!Self.isAccessibilityMetadataTextCall(at: 0, in: [".accessibilityLabel(title)"]))

        let nearbyVisualText = [
            ".accessibilityLabel(Text(title))",
            "Text(body)",
        ]
        #expect(!Self.isAccessibilityMetadataTextCall(at: 1, in: nearbyVisualText))

        let sameLineVisualLabel = [
            "Label(\"Status\", systemImage: \"circle\").accessibilityLabel(Text(status))",
        ]
        #expect(!Self.isAccessibilityMetadataTextCall(at: 0, in: sameLineVisualLabel))

        let trailingVisualText = [".accessibilityLabel(Text(status)); Text(body)"]
        #expect(!Self.isAccessibilityMetadataTextCall(at: 0, in: trailingVisualText))

        let modifierTextInString = [
            "let sample = \".accessibilityLabel(\"",
            "Text(body)",
        ]
        #expect(!Self.isAccessibilityMetadataTextCall(at: 1, in: modifierTextInString))

        let modifierTextInComment = [
            "// Example: .accessibilityLabel(",
            "Text(body)",
        ]
        #expect(!Self.isAccessibilityMetadataTextCall(at: 1, in: modifierTextInComment))
    }

    @Test func `secure fields do not use platform placeholder text`() throws {
        let offenders = try Self.swiftSourcesForTypographyAudit().flatMap { url -> [String] in
            let source = try String(contentsOf: url, encoding: .utf8)
            return source
                .components(separatedBy: .newlines)
                .enumerated()
                .compactMap { offset, line in
                    guard line.range(
                        of: #"\bSecureField\("[^"]+""#,
                        options: .regularExpression) != nil
                    else { return nil }
                    return "\(Self.relativePath(url)):\(offset + 1): \(line.trimmingCharacters(in: .whitespaces))"
                }
        }
        #expect(offenders.isEmpty, Comment(rawValue: offenders.joined(separator: "\n")))
    }

    private static let bundledFontFiles = [
        "RedHatDisplay[wght].ttf",
        "Inter[opsz,wght].ttf",
        "Inter-Italic[opsz,wght].ttf",
        "JetBrainsMono-Regular.ttf",
        "JetBrainsMono-Medium.ttf",
        "JetBrainsMono-SemiBold.ttf",
    ]

    private static func projectYmlURL() -> URL {
        self.iosRootURL().appendingPathComponent("project.yml")
    }

    private static func activityWidgetInfoPlistURL() -> URL {
        self.iosRootURL().appendingPathComponent("ActivityWidget/Info.plist")
    }

    private static func activityWidgetTypographySourceURL() -> URL {
        self.iosRootURL().appendingPathComponent("ActivityWidget/OpenClawActivityTypography.swift")
    }

    private static func sourceURL(_ relativePath: String) -> URL {
        self.iosRootURL().appendingPathComponent("Sources/\(relativePath)")
    }

    private static func swiftSourcesForTypographyAudit() throws -> [URL] {
        let roots = [
            self.sourceURL(""),
            self.iosRootURL().appendingPathComponent("ActivityWidget"),
            self.iosRootURL().appendingPathComponent("WatchApp/Sources"),
            self.iosRootURL()
                .deletingLastPathComponent()
                .appendingPathComponent("shared/OpenClawKit/Sources/OpenClawChatUI"),
        ]
        return roots.flatMap { root -> [URL] in
            guard let enumerator = FileManager.default.enumerator(
                at: root,
                includingPropertiesForKeys: nil)
            else { return [] }
            return enumerator.compactMap { item -> URL? in
                guard let url = item as? URL, url.pathExtension == "swift" else { return nil }
                return url
            }
        }
        .sorted { $0.path < $1.path }
    }

    private static func unbrandedTextCallOffenders() throws -> [String] {
        try self.swiftSourcesForTypographyAudit().flatMap { url -> [String] in
            let source = try String(contentsOf: url, encoding: .utf8)
            return self.unbrandedTextCallOffenders(in: source, relativePath: self.relativePath(url))
        }
    }

    private static func unbrandedTextCallOffenders(in source: String, relativePath: String) -> [String] {
        let fontTokens = [
            "OpenClawType",
            "OpenClawActivityType",
            "OpenClawChatTypography",
            "WatchClawType",
            "typography.",
        ]
        let sourceBytes = Array(source.utf8)
        let code = self.maskedSwiftCode(source)
        guard !self.isCompleteMacOSSourceEnvelope(code) else { return [] }
        let imageFontRanges = Set(self.directImageFontModifierRanges(in: code))
        var offenders: [String] = []

        for fontRange in self.fontModifierRanges(in: code) {
            let fontCall = String(decoding: sourceBytes[fontRange], as: UTF8.self)
            let hasBrandedFont = fontTokens.contains { fontCall.contains($0) }
                || self.hasAllowedBrandedFontParameter(fontCall, relativePath: relativePath, code: code)
            guard !hasBrandedFont, !imageFontRanges.contains(fontRange) else { continue }

            let fontLine = code[..<fontRange.lowerBound].count(where: { $0 == 10 })
            offenders.append(
                "\(relativePath):\(fontLine + 1): \(fontCall.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
        return offenders
    }

    private static let textOrLabelCallPattern = try! NSRegularExpression(pattern: #"\b(Text|Label)\s*\("#)

    private static func isTextOrLabelCall(_ line: String) -> Bool {
        self.textOrLabelCallPattern.firstMatch(
            in: line,
            range: NSRange(line.startIndex..<line.endIndex, in: line)) != nil
    }

    private static func isAccessibilityMetadataTextCall(at idx: Int, in lines: [String]) -> Bool {
        self.accessibilityMetadataTextLines(in: lines).contains(idx)
    }

    private static func accessibilityMetadataTextLines(in lines: [String]) -> Set<Int> {
        let code = self.maskedSwiftCode(lines.joined(separator: "\n"))
        let textToken = Array("Text".utf8)
        let labelToken = Array("Label".utf8)
        let modifiers = [
            Array(".accessibilityLabel".utf8),
            Array(".accessibilityValue".utf8),
            Array(".accessibilityHint".utf8),
        ]
        var callCounts: [Int: Int] = [:]
        var metadataCallCounts: [Int: Int] = [:]
        var line = 0

        for offset in code.indices {
            if code[offset] == 10 {
                line += 1
                continue
            }
            if self.callOpeningParenthesis(after: textToken, at: offset, in: code) != nil ||
                self.callOpeningParenthesis(after: labelToken, at: offset, in: code) != nil
            {
                callCounts[line, default: 0] += 1
            }

            for modifier in modifiers {
                guard let modifierOpen = self.callOpeningParenthesis(after: modifier, at: offset, in: code)
                else { continue }
                let textOffset = self.skippingWhitespace(in: code, after: modifierOpen)
                guard let textOpen = self.callOpeningParenthesis(after: textToken, at: textOffset, in: code),
                      let textClose = self.matchingParenthesis(in: code, openingAt: textOpen)
                else { continue }
                let metadataClose = self.skippingWhitespace(in: code, after: textClose)
                guard metadataClose < code.count, code[metadataClose] == 41 else { continue }

                // Exempt only the direct Text argument; visible calls sharing its source line stay audited.
                let textLine = line + code[offset..<textOffset].count(where: { $0 == 10 })
                metadataCallCounts[textLine, default: 0] += 1
            }
        }

        return Set(metadataCallCounts.compactMap { line, count in
            callCounts[line] == count ? line : nil
        })
    }

    private static func callOpeningParenthesis(
        after token: [UInt8],
        at offset: Int,
        in code: [UInt8]) -> Int?
    {
        guard let firstByte = token.first,
              offset + token.count <= code.count,
              code[offset] == firstByte,
              code[offset..<(offset + token.count)].elementsEqual(token),
              firstByte == 46 || offset == 0 || !self.isSwiftIdentifierByte(code[offset - 1])
        else { return nil }
        let afterToken = offset + token.count
        guard afterToken == code.count || !self.isSwiftIdentifierByte(code[afterToken]) else { return nil }
        let opening = self.skippingWhitespace(in: code, after: afterToken - 1)
        return opening < code.count && code[opening] == 40 ? opening : nil
    }

    private static func skippingWhitespace(in code: [UInt8], after offset: Int) -> Int {
        var cursor = offset + 1
        while cursor < code.count, code[cursor] == 9 || code[cursor] == 10 || code[cursor] == 13 || code[cursor] == 32 {
            cursor += 1
        }
        return cursor
    }

    private static func matchingParenthesis(in code: [UInt8], openingAt offset: Int) -> Int? {
        self.matchingDelimiter(in: code, openingAt: offset, opening: 40, closing: 41)
    }

    private static func matchingDelimiter(
        in code: [UInt8],
        openingAt offset: Int,
        opening: UInt8,
        closing: UInt8) -> Int?
    {
        var depth = 0
        for cursor in offset..<code.count {
            if code[cursor] == opening {
                depth += 1
            } else if code[cursor] == closing {
                depth -= 1
                if depth == 0 { return cursor }
            }
        }
        return nil
    }

    private static func isSwiftIdentifierByte(_ byte: UInt8) -> Bool {
        byte == 95 || (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte) || byte >= 128
    }

    private static func maskedSwiftCode(_ source: String) -> [UInt8] {
        let sourceBytes = Array(source.utf8)
        var code = sourceBytes
        var cursor = 0

        func mask(_ range: Range<Int>) {
            for offset in range where code[offset] != 10 && code[offset] != 13 {
                code[offset] = 32
            }
        }

        while cursor < sourceBytes.count {
            if cursor + 1 < sourceBytes.count, sourceBytes[cursor] == 47, sourceBytes[cursor + 1] == 47 {
                let start = cursor
                while cursor < sourceBytes.count, sourceBytes[cursor] != 10 {
                    cursor += 1
                }
                mask(start..<cursor)
                continue
            }
            if cursor + 1 < sourceBytes.count, sourceBytes[cursor] == 47, sourceBytes[cursor + 1] == 42 {
                let start = cursor
                var depth = 1
                cursor += 2
                while cursor < sourceBytes.count, depth > 0 {
                    if cursor + 1 < sourceBytes.count, sourceBytes[cursor] == 47, sourceBytes[cursor + 1] == 42 {
                        depth += 1
                        cursor += 2
                    } else if cursor + 1 < sourceBytes.count,
                              sourceBytes[cursor] == 42,
                              sourceBytes[cursor + 1] == 47
                    {
                        depth -= 1
                        cursor += 2
                    } else {
                        cursor += 1
                    }
                }
                mask(start..<cursor)
                continue
            }

            let start = cursor
            var hashCount = 0
            while cursor < sourceBytes.count, sourceBytes[cursor] == 35 {
                hashCount += 1
                cursor += 1
            }
            guard cursor < sourceBytes.count, sourceBytes[cursor] == 34 else {
                cursor = start + 1
                continue
            }
            let quoteCount = cursor + 2 < sourceBytes.count &&
                sourceBytes[cursor + 1] == 34 && sourceBytes[cursor + 2] == 34 ? 3 : 1
            cursor += quoteCount
            while cursor < sourceBytes.count {
                if hashCount == 0, quoteCount == 1, sourceBytes[cursor] == 92 {
                    cursor = min(sourceBytes.count, cursor + 2)
                    continue
                }
                let closingEnd = cursor + quoteCount + hashCount
                if closingEnd <= sourceBytes.count,
                   sourceBytes[cursor..<(cursor + quoteCount)].allSatisfy({ $0 == 34 }),
                   sourceBytes[(cursor + quoteCount)..<closingEnd].allSatisfy({ $0 == 35 })
                {
                    cursor = closingEnd
                    break
                }
                cursor += 1
            }
            mask(start..<cursor)
        }
        return code
    }

    private static func fontModifierRanges(in code: [UInt8]) -> [Range<Int>] {
        let token = Array(".font".utf8)
        return code.indices.compactMap { offset in
            guard let opening = self.callOpeningParenthesis(after: token, at: offset, in: code),
                  let closing = self.matchingParenthesis(in: code, openingAt: opening)
            else { return nil }
            return offset..<(closing + 1)
        }
    }

    private static func directImageFontModifierRanges(in code: [UInt8]) -> [Range<Int>] {
        let imageToken = Array("Image".utf8)
        let fontToken = Array(".font".utf8)
        return code.indices.compactMap { offset in
            guard let imageOpening = self.callOpeningParenthesis(after: imageToken, at: offset, in: code),
                  let imageClosing = self.matchingParenthesis(in: code, openingAt: imageOpening)
            else { return nil }
            let fontStart = self.skippingWhitespace(in: code, from: imageClosing + 1)
            guard let fontOpening = self.callOpeningParenthesis(after: fontToken, at: fontStart, in: code),
                  let fontClosing = self.matchingParenthesis(in: code, openingAt: fontOpening)
            else { return nil }
            return fontStart..<(fontClosing + 1)
        }
    }

    private static func skippingWhitespace(in code: [UInt8], from offset: Int) -> Int {
        var cursor = offset
        while cursor < code.count, code[cursor] == 9 || code[cursor] == 10 || code[cursor] == 13 || code[cursor] == 32 {
            cursor += 1
        }
        return cursor
    }

    private static func hasAllowedBrandedFontParameter(
        _ fontCall: String,
        relativePath: String,
        code: [UInt8]) -> Bool
    {
        switch relativePath {
        case "apps/ios/Sources/Design/OpenClawProComponents.swift":
            fontCall.contains(".font(self.titleFont)") ||
                fontCall.contains(".font(self.subtitleFont)")
        case "apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatMarkdownRenderer.swift":
            // Qualified values are composed here, then styled at the prose render boundary.
            fontCall.contains(".font(self.font)") || fontCall.contains(".font(font)")
        case "apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatSessionManagementViews.swift":
            self.hasBrandedFormFont(code) &&
                [".font(self.formFont)", ".font(self.formFont.weight(.medium))"].contains(fontCall)
        default:
            false
        }
    }

    private static func relativePath(_ url: URL) -> String {
        // Enumeration and #filePath can use different symlink spellings for the same checkout.
        let rootPath = self.iosRootURL()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .resolvingSymlinksInPath()
            .path + "/"
        let path = url.resolvingSymlinksInPath().path
        return path.hasPrefix(rootPath) ? String(path.dropFirst(rootPath.count)) : path
    }

    private static func iosRootURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private static func extract(_ source: String, from start: String, to end: String) throws -> String {
        let startRange = try #require(source.range(of: start))
        let tail = source[startRange.lowerBound...]
        let endRange = try #require(tail.range(of: end))
        return String(tail[..<endRange.lowerBound])
    }
}

extension OpenClawTypographyTests {
    @Test func `font boundary scanner excludes only whole macOS files`() {
        let font = "Text(title).font(.body)"
        let cases: [(String, Bool)] = [
            ("#if os(macOS)\n\(font)\n#endif", true),
            ("// Header\n#if os(macOS)\n\(font)\n#endif\n// Footer", true),
            ("#if os(macOS)\n#if DEBUG\n\(font)\n#else\n\(font)\n#endif\n#endif", true),
            ("#if os(macOS)\n#if(DEBUG)\n\(font)\n#endif\n#endif", true),
            (font, false),
            ("#if os(iOS)\n\(font)\n#endif", false),
            ("#if os(macOS) || os(iOS)\n\(font)\n#endif", false),
            ("#if os(macOS)\n\(font)\n#else\n\(font)\n#endif", false),
            ("#if os(macOS)\n\(font)\n#elseif os(iOS)\n\(font)\n#endif", false),
            ("#if os(macOS)\n\(font)\n#elseif(os(iOS))\n\(font)\n#endif", false),
            ("import SwiftUI\n#if os(macOS)\n\(font)\n#endif", false),
            ("#if os(macOS)\n#endif\n\(font)", false),
            ("#if os(macOS)\n\(font)", false),
            ("#if os(macOS)\n#endif\n#if os(iOS)\n\(font)\n#endif", false),
            ("// #if os(macOS)\n\(font)\n// #endif", false),
        ]
        for (source, isMacOSOnly) in cases {
            #expect(Self.isCompleteMacOSSourceEnvelope(Self.maskedSwiftCode(source)) == isMacOSOnly)
            #expect(Self.unbrandedTextCallOffenders(in: source, relativePath: "Sample.swift").isEmpty == isMacOSOnly)
        }
    }

    @Test func `form font alias requires its audited branded definition`() {
        let path = "apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatSessionManagementViews.swift"
        let source = """
        private var formFont: Font {
            #if os(macOS)
            OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body)
            #else
            OpenClawChatTypography.body
            #endif
        }
        Text(title).font(self.formFont)
        Text(title).font(self.formFont.weight(.medium))
        """
        #expect(Self.unbrandedTextCallOffenders(in: source, relativePath: path).isEmpty)
        #expect(Self.unbrandedTextCallOffenders(in: source, relativePath: "Sample.swift").count == 2)
        for altered in [
            source.replacingOccurrences(of: "OpenClawChatTypography.body", with: "Font.system"),
            source.replacingOccurrences(of: "#else\n    OpenClawChatTypography.body", with: "#else\n    .body"),
            source.replacingOccurrences(of: "private var formFont", with: "private var anotherFont"),
        ] {
            #expect(Self.unbrandedTextCallOffenders(in: altered, relativePath: path).count == 2)
        }
        for declaration in [
            "let formFont: Font = .body", "let formFont = Font.body",
            "var formFont: Font = .body", "var formFont = Font.body",
            "let `formFont` = Font.body", "let other = Font.body, formFont = Font.body",
        ] {
            let shadow = "struct Other: View { \(declaration); " +
                "var body: some View { Text(title).font(self.formFont) } }"
            #expect(Self.unbrandedTextCallOffenders(in: source + shadow, relativePath: path).count == 3)
        }
        #expect(Self.unbrandedTextCallOffenders(
            in: source + "\nText(title).font(self.otherFont)", relativePath: path).count == 1)
        #expect(Self.unbrandedTextCallOffenders(
            in: source + "\nText(title).font(self.formFont.weight(.bold))", relativePath: path).count == 1)
    }

    private static func hasBrandedFormFont(_ code: [UInt8]) -> Bool {
        // Audit the alias producer as well as its uses, so a system-font substitution still fails.
        guard let source = String(bytes: code, encoding: .utf8) else { return false }
        let compact = source.filter { !$0.isWhitespace }
        let definition = "privatevarformFont:Font{#ifos(macOS)" +
            "OpenClawChatTypography.body(size:13,weight:.regular,relativeTo:.body)" +
            "#elseOpenClawChatTypography.body#endif}"
        // Any additional unqualified occurrence may declare another producer; keep uncertain source audited.
        let withoutUses = compact.replacingOccurrences(of: "self.formFont", with: "")
        return withoutUses.components(separatedBy: "formFont").count == 2 && compact.contains(definition)
    }

    @Test func `font boundary scanner excludes only complete macOS source envelopes`() {
        let macOnly = """
        // A shared directory can contain a macOS-only view.
        #if os(macOS)
        #if DEBUG
        let example = "#endif"
        #else
        /* #endif */
        #endif
        Text("Mac").font(.system(size: 12))
        #endif
        """
        #expect(Self.unbrandedTextCallOffenders(in: macOnly, relativePath: "Mac.swift").isEmpty)

        for condition in ["os(iOS)", "os(watchOS)", "os(macOS) || os(iOS)"] {
            let source = "#if \(condition)\nText(\"Visible\").font(.body)\n#endif"
            #expect(Self.unbrandedTextCallOffenders(in: source, relativePath: "Visible.swift") == [
                "Visible.swift:2: .font(.body)",
            ])
        }
        for alternate in ["#else", "#elseif os(iOS)"] {
            let source = "#if os(macOS)\n\(alternate)\nText(\"Visible\").font(.caption)\n#endif"
            #expect(Self.unbrandedTextCallOffenders(in: source, relativePath: "Mixed.swift") == [
                "Mixed.swift:3: .font(.caption)",
            ])
        }
        let shared = macOnly + "\nText(\"Shared\").font(.body)"
        #expect(Self.unbrandedTextCallOffenders(in: shared, relativePath: "Shared.swift").last ==
            "Shared.swift:10: .font(.body)")
    }

    private static func isCompleteMacOSSourceEnvelope(_ code: [UInt8]) -> Bool {
        guard let source = String(bytes: code, encoding: .utf8) else { return false }
        let lines = source.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard lines.first == "#if os(macOS)", lines.last == "#endif" else { return false }
        var depth = 0
        for (index, line) in lines.enumerated() {
            switch line.prefix(while: { $0 == "#" || $0.isLetter }) {
            case "#if":
                depth += 1
            case "#else", "#elseif":
                if depth == 1 { return false }
            case "#endif":
                depth -= 1
                if depth == 0, index != lines.count - 1 { return false }
            default:
                break
            }
            if depth < 0 { return false }
        }
        return depth == 0
    }
}
