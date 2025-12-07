import SwiftUI

struct AboutSettings: View {
    @State private var iconHover = false

    var body: some View {
        VStack(spacing: 8) {
            let appIcon = NSApplication.shared.applicationIconImage ?? CritterIconRenderer.makeIcon(blink: 0)
            Button {
                if let url = URL(string: "https://github.com/steipete/clawdis") {
                    NSWorkspace.shared.open(url)
                }
            } label: {
                Image(nsImage: appIcon)
                    .resizable()
                    .frame(width: 88, height: 88)
                    .cornerRadius(16)
                    .shadow(color: self.iconHover ? .accentColor.opacity(0.25) : .clear, radius: 8)
                    .scaleEffect(self.iconHover ? 1.06 : 1.0)
            }
            .buttonStyle(.plain)
            .focusable(false)
            .onHover { hover in
                withAnimation(.spring(response: 0.3, dampingFraction: 0.72)) { self.iconHover = hover }
            }

            VStack(spacing: 3) {
                Text("Clawdis")
                    .font(.title3.bold())
                Text("Version \(self.versionString)")
                    .foregroundStyle(.secondary)
                if let buildTimestamp {
                    Text("Built \(buildTimestamp)\(self.buildSuffix)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Text("Menu bar companion for notifications, screenshots, and privileged agent actions.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 18)
            }

            VStack(alignment: .center, spacing: 6) {
                AboutLinkRow(
                    icon: "chevron.left.slash.chevron.right",
                    title: "GitHub",
                    url: "https://github.com/steipete/clawdis")
                AboutLinkRow(icon: "globe", title: "Website", url: "https://steipete.me")
                AboutLinkRow(icon: "bird", title: "Twitter", url: "https://twitter.com/steipete")
                AboutLinkRow(icon: "envelope", title: "Email", url: "mailto:peter@steipete.me")
            }
            .frame(maxWidth: .infinity)
            .multilineTextAlignment(.center)
            .padding(.vertical, 10)

            Text("© 2025 Peter Steinberger — MIT License.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.top, 4)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 4)
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
    }

    private var versionString: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        return build.map { "\(version) (\($0))" } ?? version
    }

    private var buildTimestamp: String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "ClawdisBuildTimestamp") as? String else { return nil }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime]
        guard let date = parser.date(from: raw) else { return raw }

        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        formatter.locale = .current
        return formatter.string(from: date)
    }

    private var gitCommit: String {
        Bundle.main.object(forInfoDictionaryKey: "ClawdisGitCommit") as? String ?? "unknown"
    }

    private var bundleID: String {
        Bundle.main.bundleIdentifier ?? "unknown"
    }

    private var buildSuffix: String {
        let git = self.gitCommit
        guard !git.isEmpty, git != "unknown" else { return "" }

        var suffix = " (\(git)"
        #if DEBUG
        suffix += " DEBUG"
        #endif
        suffix += ")"
        return suffix
    }
}

@MainActor
private struct AboutLinkRow: View {
    let icon: String
    let title: String
    let url: String

    @State private var hovering = false

    var body: some View {
        Button {
            if let url = URL(string: url) { NSWorkspace.shared.open(url) }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: self.icon)
                Text(self.title)
                    .underline(self.hovering, color: .accentColor)
            }
            .foregroundColor(.accentColor)
        }
        .buttonStyle(.plain)
        .onHover { self.hovering = $0 }
    }
}

private struct AboutMetaRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(self.label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(self.value)
                .font(.caption.monospaced())
                .foregroundStyle(.primary)
        }
    }
}
