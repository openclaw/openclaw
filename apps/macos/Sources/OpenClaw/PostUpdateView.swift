import AppKit
import OpenClawChatUI
import SwiftUI

struct PostUpdateView: View {
    @Bindable var model: PostUpdateModel

    var body: some View {
        VStack(spacing: 0) {
            GlowingOpenClawIcon(size: 150, mood: self.model.mood)
                .frame(height: 205)

            VStack(spacing: 18) {
                Text(self.model.title)
                    .font(.system(size: 25, weight: .semibold))
                    .multilineTextAlignment(.center)
                Text(self.model.message)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 430)

                if self.model.isWorking {
                    ProgressView()
                        .controlSize(.large)
                        .padding(.top, 6)
                }

                if let details = self.model.details {
                    ScrollView {
                        Text(details)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 120)
                    .padding(12)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                }

                Spacer(minLength: 0)
                self.actions
            }
            .padding(.horizontal, 42)
            .padding(.bottom, 34)
        }
        .frame(minWidth: 560, minHeight: 600)
        .background(Color(NSColor.windowBackgroundColor))
    }

    @ViewBuilder
    private var actions: some View {
        switch self.model.phase {
        case .failed:
            HStack {
                Button("Update guide") { AppActivation.shared.open(PostUpdateController.updateGuideURL) }
                Button("Ask Discord") { AppActivation.shared.open(PostUpdateController.discordURL) }
                Spacer()
                Button("Retry") { PostUpdateController.shared.retry() }
                    .buttonStyle(.borderedProminent)
            }
        case .deferred, .complete:
            HStack {
                Spacer()
                Button("Continue") { PostUpdateController.shared.close() }
                    .buttonStyle(.borderedProminent)
            }
        case .checking, .updating, .verifying, .notifying:
            EmptyView()
        }
    }
}
