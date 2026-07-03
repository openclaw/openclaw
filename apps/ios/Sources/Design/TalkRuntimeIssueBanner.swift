import SwiftUI
import UIKit

struct TalkRuntimeIssueBanner: View {
    let issue: TalkRuntimeIssue
    var onOpenSettings: (() -> Void)?
    var onShowDetails: (() -> Void)?

    var body: some View {
        OpenClawNoticeBanner(
            icon: self.iconName,
            title: self.issue.fallbackBannerTitle,
            message: self.issue.fallbackBannerMessage,
            ownerLabel: self.issue.fallbackBannerOwnerLabel,
            tint: self.tint,
            detail: .accent(self.issue.displayMessage),
            primaryActionTitle: "Open Settings",
            onPrimaryAction: self.onOpenSettings,
            secondaryActionTitle: "Details",
            onSecondaryAction: self.onShowDetails)
    }

    private var iconName: String {
        "exclamationmark.triangle.fill"
    }

    private var tint: Color {
        OpenClawBrand.warn
    }
}

struct TalkRuntimeIssueDetailsSheet: View {
    @Environment(\.dismiss) private var dismiss

    let issue: TalkRuntimeIssue
    var onOpenSettings: (() -> Void)?

    @State private var copyFeedback: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(self.issue.fallbackBannerTitle)
                            .font(.title3.weight(.semibold))
                        Text(self.issue.fallbackBannerMessage)
                            .font(.body)
                            .foregroundStyle(.secondary)
                        Text(self.issue.displayMessage)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4)
                }

                Section("Technical details") {
                    Text(verbatim: self.issue.technicalDetails)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    Button("Copy diagnostics") {
                        UIPasteboard.general.string = self.issue.technicalDetails
                        self.copyFeedback = "Copied diagnostics"
                    }
                }

                if let copyFeedback {
                    Section {
                        Text(copyFeedback)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Talk fallback")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if let onOpenSettings {
                        Button("Open Settings") {
                            self.dismiss()
                            onOpenSettings()
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        self.dismiss()
                    }
                }
            }
        }
    }
}
