import AppKit
import SwiftUI

struct AboutSettings: View {
    weak var updater: UpdaterProviding?
    @State private var iconHover = false
    @AppStorage("autoUpdateEnabled") private var autoCheckEnabled = true
    @State private var didLoadUpdaterState = false
    private let brandSky = Color(red: 0.59, green: 0.76, blue: 0.93)
    private let brandSand = Color(red: 0.93, green: 0.81, blue: 0.58)
    private let brandInk = Color(red: 0.16, green: 0.21, blue: 0.29)

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                self.heroSection

                self.supportSection

                if let updater {
                    Divider()
                        .padding(.top, 6)

                    if updater.isAvailable {
                        VStack(spacing: 10) {
                            Toggle("Check for updates automatically", isOn: self.$autoCheckEnabled)
                                .toggleStyle(.checkbox)
                                .frame(maxWidth: .infinity, alignment: .center)

                            Button("Check for Updates…") { updater.checkForUpdates(nil) }
                        }
                    } else {
                        Text("Updates unavailable in this build.")
                            .foregroundStyle(.secondary)
                            .padding(.top, 4)
                    }
                }

                Text("© 2026 VeriClaw 爪印 contributors. See NOTICE, LICENSE, TRADEMARKS, and PATENTS.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
            .padding(.top, 20)
            .padding(.bottom, 28)
        }
        .coordinateSpace(name: "about-scroll")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            guard let updater, !self.didLoadUpdaterState else { return }
            // Keep Sparkle’s auto-check setting in sync with the persisted toggle.
            updater.automaticallyChecksForUpdates = self.autoCheckEnabled
            updater.automaticallyDownloadsUpdates = self.autoCheckEnabled
            self.didLoadUpdaterState = true
        }
        .onChange(of: self.autoCheckEnabled) { _, newValue in
            self.updater?.automaticallyChecksForUpdates = newValue
            self.updater?.automaticallyDownloadsUpdates = newValue
        }
    }

    private var heroSection: some View {
        return AppleGlassParallaxHero(
            coordinateSpace: "about-scroll",
            height: 320,
            cornerRadius: 34,
            accent: self.brandSand,
            secondaryAccent: self.brandSky)
        {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 30) {
                    self.heroIcon(size: 156)
                    self.heroCopy(centered: false)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)

                VStack(spacing: 18) {
                    self.heroIcon(size: 148)
                    self.heroCopy(centered: true)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func heroIcon(size: CGFloat) -> some View {
        Button {
            if let url = URL(string: "https://github.com/openclaw/openclaw") {
                NSWorkspace.shared.open(url)
            }
        } label: {
            VeriClawBrandTile(size: size)
                .overlay(
                    RoundedRectangle(cornerRadius: 0.34 * size, style: .continuous)
                        .strokeBorder(.white.opacity(self.iconHover ? 0.20 : 0.10), lineWidth: 1))
                .shadow(color: .black.opacity(0.12), radius: 16, y: 10)
                .shadow(color: self.iconHover ? self.brandSky.opacity(0.18) : .clear, radius: 18)
                .scaleEffect(self.iconHover ? 1.02 : 1.0)
        }
        .buttonStyle(.plain)
        .focusable(false)
        .pointingHandCursor()
        .onHover { hover in
            withAnimation(.spring(response: 0.28, dampingFraction: 0.76)) {
                self.iconHover = hover
            }
        }
    }

    private func heroCopy(centered: Bool) -> some View {
        VStack(alignment: centered ? .center : .leading, spacing: 10) {
            Text(Branding.appName)
                .font(.system(size: 30, weight: .semibold, design: .rounded))
                .foregroundStyle(self.brandInk.opacity(0.96))
                .multilineTextAlignment(centered ? .center : .leading)

            Text("Version \(self.versionString)")
                .font(.callout.weight(.medium))
                .foregroundStyle(self.brandInk.opacity(0.58))

            Text("Runtime-truth companion for AI delivery. Review evidence, trigger correction, and keep a casebook on your Mac.")
                .font(.body)
                .foregroundStyle(self.brandInk.opacity(0.66))
                .multilineTextAlignment(centered ? .center : .leading)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 10) {
                self.heroBadge(title: "Runtime truth", systemImage: "waveform.path.ecg")
                self.heroBadge(title: "Evidence-first", systemImage: "checkmark.shield")
            }
            .frame(maxWidth: .infinity, alignment: centered ? .center : .leading)

            if let buildTimestamp {
                Text("Built \(buildTimestamp)\(self.buildSuffix)")
                    .font(.footnote)
                    .foregroundStyle(self.brandInk.opacity(0.50))
                    .multilineTextAlignment(centered ? .center : .leading)
            }
        }
        .frame(maxWidth: centered ? .infinity : 420, alignment: centered ? .center : .leading)
    }

    private func heroBadge(title: String, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .font(.caption.weight(.semibold))
            .foregroundStyle(self.brandInk.opacity(0.84))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                Capsule(style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                self.brandSand.opacity(0.10),
                                self.brandSky.opacity(0.08),
                            ],
                            startPoint: .leading,
                            endPoint: .trailing)))
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(.white.opacity(0.10), lineWidth: 1))
    }

    private var supportSection: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 14) {
                self.resourcesCard
                self.buildDetailsCard
            }
            .frame(maxWidth: 744)

            VStack(spacing: 14) {
                self.resourcesCard
                self.buildDetailsCard
            }
            .frame(maxWidth: 520)
        }
        .frame(maxWidth: .infinity)
    }

    private var resourcesCard: some View {
        self.panelCard(maxWidth: 352) {
            Text("Resources")
                .font(.headline)
                .foregroundStyle(self.brandInk.opacity(0.94))

            Text("Reference material for \(Branding.appName), including product scope, release materials, and legal attribution.")
                .font(.subheadline)
                .foregroundStyle(self.brandInk.opacity(0.56))
                .fixedSize(horizontal: false, vertical: true)

            LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                AboutLinkTile(
                    icon: "chevron.left.slash.chevron.right",
                    title: "GitHub",
                    url: "https://github.com/openclaw/openclaw",
                    tint: self.brandSky,
                    secondaryTint: self.brandSand,
                    ink: self.brandInk)
                AboutLinkTile(
                    icon: "cross.case",
                    title: "Companion Guide",
                    url: "https://github.com/openclaw/openclaw/blob/main/CASE_BASED_CORRECTION_WORKSPACE.md",
                    tint: self.brandSky,
                    secondaryTint: self.brandSand,
                    ink: self.brandInk)
                AboutLinkTile(
                    icon: "building.columns",
                    title: "Legal Pack",
                    url: "https://github.com/openclaw/openclaw/blob/main/TRADEMARKS.md",
                    tint: self.brandSky,
                    secondaryTint: self.brandSand,
                    ink: self.brandInk)
                AboutLinkTile(
                    icon: "doc.text",
                    title: "Notice",
                    url: "https://github.com/openclaw/openclaw/blob/main/NOTICE",
                    tint: self.brandSky,
                    secondaryTint: self.brandSand,
                    ink: self.brandInk)
            }
        }
    }

    private var buildDetailsCard: some View {
        self.panelCard(maxWidth: 366) {
            Text("Build Details")
                .font(.headline)
                .foregroundStyle(self.brandInk.opacity(0.94))

            VStack(alignment: .leading, spacing: 10) {
                AboutMetaRow(label: "Version", value: self.versionString)
                AboutMetaRow(label: "Build", value: self.buildTimestamp.map { "\($0)\(self.buildSuffix)" } ?? "Unavailable")
                AboutMetaRow(label: "Bundle", value: self.bundleID)
            }
            .textSelection(.enabled)
        }
    }

    private func panelCard<Content: View>(
        maxWidth: CGFloat,
        @ViewBuilder content: () -> Content) -> some View
    {
        VStack(alignment: .leading, spacing: 14) {
            content()
        }
        .padding(17)
        .frame(maxWidth: maxWidth, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor).opacity(0.92))
                .shadow(color: .black.opacity(0.028), radius: 7, y: 3))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(.white.opacity(0.08), lineWidth: 1))
    }

    private var versionString: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        return build.map { "\(version) (\($0))" } ?? version
    }

    private var buildTimestamp: String? {
        guard
            let raw =
            (Bundle.main.object(forInfoDictionaryKey: "OpenClawBuildTimestamp") as? String) ??
            (Bundle.main.object(forInfoDictionaryKey: "OpenClawBuildTimestamp") as? String)
        else { return nil }
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
        (Bundle.main.object(forInfoDictionaryKey: "OpenClawGitCommit") as? String) ??
            (Bundle.main.object(forInfoDictionaryKey: "OpenClawGitCommit") as? String) ??
            "unknown"
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
private struct AboutLinkTile: View {
    let icon: String
    let title: String
    let url: String
    let tint: Color
    let secondaryTint: Color
    let ink: Color

    @State private var hovering = false

    var body: some View {
        Button {
            if let url = URL(string: url) { NSWorkspace.shared.open(url) }
        } label: {
            HStack(spacing: 10) {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [
                                self.secondaryTint.opacity(self.hovering ? 0.28 : 0.20),
                                self.tint.opacity(self.hovering ? 0.22 : 0.14),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing))
                    .frame(width: 28, height: 28)
                    .overlay(
                        Image(systemName: self.icon)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(self.ink.opacity(0.80)))

                Text(self.title)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(self.ink.opacity(self.hovering ? 0.86 : 0.70))

                Spacer(minLength: 0)

                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(self.hovering ? self.tint.opacity(0.78) : self.ink.opacity(0.26))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(.white.opacity(self.hovering ? 0.13 : 0.07)))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(.white.opacity(self.hovering ? 0.14 : 0.06), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .onHover { self.hovering = $0 }
        .pointingHandCursor()
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

#if DEBUG
struct AboutSettings_Previews: PreviewProvider {
    private static let updater = DisabledUpdaterController()
    static var previews: some View {
        AboutSettings(updater: updater)
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
