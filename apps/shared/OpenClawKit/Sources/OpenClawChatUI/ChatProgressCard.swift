import Foundation
import OpenClawProtocol
import SwiftUI

private struct ChatProgressCardSurface: ViewModifier {
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        #if os(macOS)
        content
            .background(
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .fill(OpenClawChatTheme.subtleCard))
            .overlay(
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
        #else
        if #available(iOS 26.0, *) {
            content
                .glassEffect(.regular, in: .rect(cornerRadius: self.cornerRadius))
        } else {
            content
                .background(
                    .regularMaterial,
                    in: RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                        .strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
        }
        #endif
    }
}

/// The keyboard hides when a context menu opens, and everything above it moves down. A message row's lifted
/// copy moves too, because it sits in the transcript's scroll view; without a scroll container of its own the
/// card's copy stayed where the press began, over the transcript. A scroll view that never scrolls is one.
private struct ChatProgressCardMenuAnchor: ViewModifier {
    func body(content: Content) -> some View {
        #if os(iOS)
        // Only this container is fixed; wide tables and code inside the card still pan.
        ScrollView { content.scrollDisabled(false) }
            .scrollDisabled(true)
            .scrollClipDisabled()
            .fixedSize(horizontal: false, vertical: true)
        #else
        content
        #endif
    }
}

struct ChatProgressCard: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let steps: [ProgressCardStep]
    let markdown: String?
    var isInline = false
    var isRefreshing = false
    var onRefresh: (() -> Void)?
    var onClearSaved: (() -> Void)?
    var onDismiss: (() -> Void)?

    @State private var isExpanded = false

    private var completedCount: Int {
        self.steps.count { $0.status == .completed }
    }

    private var currentStep: ProgressCardStep? {
        self.steps.first { $0.status == .inProgress }
            ?? self.steps.last { $0.status == .completed }
            ?? self.steps.first
    }

    private var markdownSummary: String? {
        guard let line = self.markdown?
            .split(whereSeparator: \.isNewline)
            .map(String.init)
            .first(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
        else { return nil }
        var summary = line.trimmingCharacters(in: .whitespacesAndNewlines)
        while let first = summary.first,
              first.isWhitespace || "#-*>".contains(first)
        {
            summary.removeFirst()
        }
        return summary.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        Group {
            if self.isInline {
                self.content
            } else {
                // The menu is the message rows' own, on the whole card: the system times the press and lifts
                // all of it. On the header alone it lifted the header out of the card.
                let cornerRadius: CGFloat = self.isExpanded ? 16 : 18
                self.content
                    .modifier(ChatProgressCardSurface(cornerRadius: cornerRadius))
                    #if os(iOS)
                    .contentShape(
                        .contextMenuPreview,
                        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                    .contextMenu { self.actionMenu }
                    #endif
                    .modifier(ChatProgressCardMenuAnchor())
            }
        }
        .foregroundStyle(OpenClawChatTheme.assistantText)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                Button(action: self.toggle) {
                    self.summary
                        .padding(.horizontal, self.isInline ? 0 : 12)
                        .padding(.vertical, self.isInline ? 4 : (self.isExpanded ? 11 : 9))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(self.summaryAccessibilityLabel)
                .accessibilityHint(self.isExpanded ? "Collapse plan" : "Expand plan")
                // VoiceOver and Switch Control reach the menu's actions here, without the long press.
                .accessibilityActions {
                    if !self.isInline, !Self.showsHeaderActions { self.actionMenu }
                }

                // Same order as the web client: refresh, clear saved, dismiss, collapse.
                if !self.isInline {
                    if self.isRefreshing {
                        ProgressView()
                            .controlSize(.mini)
                            .frame(width: 32, height: 36)
                            .accessibilityLabel("Refreshing plan")
                    } else if Self.showsHeaderActions, let onRefresh {
                        self.headerButton(
                            symbol: "arrow.clockwise",
                            label: "Refresh plan",
                            id: "refresh",
                            action: onRefresh)
                    }
                    if Self.showsHeaderActions, let onClearSaved {
                        self.headerButton(
                            symbol: "trash",
                            label: "Clear saved plan for everyone",
                            id: "clear-saved",
                            action: onClearSaved)
                    }
                    if Self.showsHeaderActions, let onDismiss {
                        self.headerButton(symbol: "xmark", label: "Dismiss plan", id: "dismiss", action: onDismiss)
                    }
                    Button(action: self.toggle) {
                        Image(systemName: "chevron.down")
                            .font(OpenClawChatTypography.caption2)
                            .foregroundStyle(OpenClawChatTheme.muted)
                            .rotationEffect(.degrees(self.isExpanded ? 180 : 0))
                            .modifier(HeaderHitArea())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHidden(true)
                }
            }

            if self.isExpanded {
                Divider()
                    .overlay(OpenClawChatTheme.divider)
                    .padding(.horizontal, 12)
                VStack(alignment: .leading, spacing: 9) {
                    if let markdown {
                        ChatMarkdownRenderer(
                            text: markdown,
                            context: .assistant,
                            variant: .compact,
                            textColor: OpenClawChatTheme.assistantText)
                    }
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(Array(self.steps.enumerated()), id: \.offset) { _, step in
                            self.stepRow(step)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 9)
                .padding(.bottom, 11)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func toggle() {
        withAnimation(self.reduceMotion ? nil : .easeInOut(duration: 0.2)) {
            self.isExpanded.toggle()
        }
    }

    /// A pointer can aim at small controls; a finger cannot, and the header is one line tall. On touch the
    /// header keeps only the collapse caret and a long press offers the same actions.
    private static var showsHeaderActions: Bool {
        #if os(macOS)
        true
        #else
        false
        #endif
    }

    @ViewBuilder
    private var actionMenu: some View {
        if let onRefresh {
            Button(action: onRefresh) {
                Label("Refresh plan", systemImage: "arrow.clockwise")
            }
            .disabled(self.isRefreshing)
            .accessibilityIdentifier("chat-progress-card-refresh")
        }
        if let onDismiss {
            Button(action: onDismiss) {
                Label("Dismiss plan", systemImage: "xmark")
            }
            .accessibilityIdentifier("chat-progress-card-dismiss")
        }
        if let onClearSaved {
            Button(role: .destructive, action: onClearSaved) {
                Label("Clear saved plan for everyone", systemImage: "trash")
            }
            .accessibilityIdentifier("chat-progress-card-clear-saved")
        }
    }

    private func headerButton(
        symbol: String,
        label: LocalizedStringKey,
        id: String,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.secondary)
                .modifier(HeaderHitArea())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier("chat-progress-card-\(id)")
    }

    private var summaryAccessibilityLabel: String {
        if let currentStep {
            return "Plan, \(self.completedCount) of \(self.steps.count) steps done, "
                + "\(Self.accessibilityLabel(for: currentStep.status)): \(currentStep.step)"
        }
        return "Plan, \(self.markdownSummary ?? "Progress update")"
    }

    private var summary: some View {
        HStack(spacing: 8) {
            if self.isInline, !self.steps.isEmpty, self.completedCount == self.steps.count {
                Image(systemName: "checkmark")
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(OpenClawChatTheme.success)
                Text(verbatim: self.completedCount == 1
                    ? String(localized: "1 step completed")
                    : String(format: String(localized: "%lld steps completed"), self.completedCount))
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
            } else if let currentStep {
                Text(Self.marker(for: currentStep.status))
                    .font(OpenClawChatTypography.captionSemiBold)
                    .foregroundStyle(Self.markerColor(for: currentStep.status))
                Text(currentStep.step)
                    .font(OpenClawChatTypography.footnoteSemiBold)
                    .lineLimit(1)
                    .truncationMode(.tail)
            } else if let markdownSummary {
                Text(markdownSummary)
                    .font(OpenClawChatTypography.footnoteSemiBold)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            if !self.isInline {
                Spacer(minLength: 8)
            }
            if !self.steps.isEmpty, !self.isInline || self.completedCount != self.steps.count {
                Text(verbatim: "\(self.completedCount)/\(self.steps.count)")
                    .font(OpenClawChatTypography.captionSemiBold)
                    .foregroundStyle(OpenClawChatTheme.muted)
            }
            if self.isInline {
                Image(systemName: "chevron.right")
                    .font(OpenClawChatTypography.caption2)
                    .foregroundStyle(OpenClawChatTheme.muted)
                    .rotationEffect(.degrees(self.isExpanded ? 90 : 0))
                Spacer(minLength: 0)
            }
        }
    }

    private func stepRow(_ step: ProgressCardStep) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(Self.marker(for: step.status))
                .font(OpenClawChatTypography.captionSemiBold)
                .foregroundStyle(Self.markerColor(for: step.status))
                .frame(width: 12, alignment: .center)
            Text(step.step)
                .font(OpenClawChatTypography.footnote)
                .foregroundStyle(
                    step.status == .pending
                        ? OpenClawChatTheme.muted
                        : OpenClawChatTheme.assistantText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.stepAccessibilityLabel(step))
    }

    private static func marker(for status: ProgressCardStepStatus) -> String {
        switch status {
        case .completed: "✓"
        case .inProgress: "▸"
        case .pending: "▢"
        }
    }

    private static func markerColor(for status: ProgressCardStepStatus) -> Color {
        switch status {
        case .completed, .inProgress: OpenClawChatTheme.accent
        case .pending: OpenClawChatTheme.muted
        }
    }

    private static func stepAccessibilityLabel(_ step: ProgressCardStep) -> String {
        "\(self.accessibilityLabel(for: step.status)), \(step.step)"
    }

    private static func accessibilityLabel(for status: ProgressCardStepStatus) -> String {
        switch status {
        case .completed: "Completed"
        case .inProgress: "In progress"
        case .pending: "Pending"
        }
    }
}

/// Each control owns 36 points of width, so neighbors never share a touch area and a near miss cannot land
/// on the bin. The touch area is 44 points tall on 36 points of layout, so the card keeps its height.
private struct HeaderHitArea: ViewModifier {
    func body(content: Content) -> some View {
        content
            .frame(width: 36, height: 44)
            .contentShape(Rectangle())
            .padding(.vertical, -4)
    }
}
