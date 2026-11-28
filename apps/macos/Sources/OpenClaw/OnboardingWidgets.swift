import AppKit
import OpenClawChatUI
import SwiftUI

/// Onboarding hero mascot with the openclaw.ai hero treatment: the animated
/// mascot plus its coral silhouette glow (drop-shadow at ~10% of size).
/// Interactive: it reacts to clicks and its eyes follow the pointer.
struct GlowingOpenClawIcon: View {
    @Environment(\.colorScheme) private var colorScheme

    var size: CGFloat = 148
    var mood: OpenClawMascotMood = .idle
    var accessory: OpenClawMascotAccessory = .none

    var body: some View {
        // The large vector hero is decorative; 30 fps burns a core while setup sits idle.
        OpenClawMascotView(
            mood: self.mood,
            accessory: self.accessory,
            interactive: true,
            minimumFrameInterval: 1.0 / 12.0)
            .frame(width: self.size, height: self.size)
            .shadow(
                color: OpenClawMascotView.heroGlowColor(for: self.colorScheme),
                radius: self.size * 0.1)
    }
}

struct OnboardingGuideBubble: View {
    static let maxWidth: CGFloat = 380

    let text: String

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        self.chrome(
            Text(self.text)
                .font(.system(size: 13))
                .foregroundStyle(.primary)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .id(self.text)
                .transition(.opacity)
                .padding(.vertical, 12)
                .padding(.horizontal, 14)
                .frame(maxWidth: Self.maxWidth, alignment: .leading),
            in: shape)
            .animation(self.reduceMotion ? nil : .easeInOut(duration: 0.2), value: self.text)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(String(format: String(localized: "OpenClaw: %@"), self.text))
            .onChange(of: self.text) { _, line in
                AccessibilityNotification.Announcement(line).post()
            }
    }

    @ViewBuilder
    private func chrome(_ content: some View, in shape: RoundedRectangle) -> some View {
        if self.reduceTransparency {
            content
                .background(shape.fill(Color(NSColor.controlBackgroundColor)))
                .overlay(shape.strokeBorder(Color.primary.opacity(self.contrast == .increased ? 0.3 : 0.08)))
        } else {
            content.glassEffect(.regular, in: shape)
        }
    }
}

struct OnboardingGuideHero: View {
    static let minimumHeight: CGFloat = 145
    static let mascotSize: CGFloat = 120

    var mood: OpenClawMascotMood
    var accessory: OpenClawMascotAccessory
    var line: String

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            GlowingOpenClawIcon(size: Self.mascotSize, mood: self.mood, accessory: self.accessory)
                .offset(y: 6)
            OnboardingGuideBubble(text: self.line)
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: Self.minimumHeight)
    }
}

struct OnboardingWindowLayout<Pages: View, Navigation: View>: View {
    var mood: OpenClawMascotMood
    var accessory: OpenClawMascotAccessory
    var line: String
    @ViewBuilder var pages: (CGFloat) -> Pages
    @ViewBuilder var navigation: () -> Navigation

    var body: some View {
        VStack(spacing: 0) {
            OnboardingGuideHero(mood: self.mood, accessory: self.accessory, line: self.line)
            GeometryReader { pageArea in
                self.pages(OnboardingView.contentHeight(forPageArea: pageArea.size.height))
            }
            .frame(maxHeight: .infinity)
            self.navigation()
        }
        .frame(maxHeight: .infinity)
    }
}

extension OnboardingView {
    /// Onboarding page classes the mascot reacts to.
    enum MascotPage: CaseIterable {
        case welcome
        case connection
        case find
        case cli
        case ai
        case reachability
        case ready
    }

    enum AIIssue: CaseIterable {
        case gatewayAuth
        case gatewayUnavailable
        case keyFailed
        case testFailed
        case listFailed
    }

    enum FinishKind: CaseIterable {
        case guide
        case existingSetup
        case later
        case nodeJoined
        case gatewaySaved
    }

    /// Flow state the mascot mood is derived from.
    struct MascotMoodSnapshot {
        var page: MascotPage
        var installingCLI = false
        var cliInstalled = false
        var cliStatusKnown = false
        var aiPhase: OnboardingAISetupModel.Phase = .idle
        var aiBusy = false
        var aiFailed = false
        var remoteProbeState: RemoteOnboardingProbeState = .idle
        var cliExecutableReady = false
        var cliInstallPhase: CLIInstallPhase = .idle
        var connectionLater = false
        var remoteAuthIssue = false
        var aiIssue: AIIssue?
        var aiNothingFound = false
        var aiWaitingForEarlierTest = false
        var aiSigningIn = false
        var reachabilitySignIn = true
        var finish: FinishKind = .guide
    }

    var mascotSnapshot: MascotMoodSnapshot {
        let page = self.mascotPage
        let aiIssue = Self.aiIssue(for: self.aiSetup)
        return MascotMoodSnapshot(
            page: page,
            installingCLI: self.installingCLI,
            cliInstalled: self.cliInstalled,
            cliStatusKnown: self.cliStatusKnown,
            aiPhase: self.aiSetup.phase,
            aiBusy: self.aiSetup.isBusy,
            aiFailed: aiIssue != nil,
            remoteProbeState: page == .find ? self.remoteProbeState : .idle,
            cliExecutableReady: self.cliExecutableReady,
            cliInstallPhase: self.cliInstallPhase,
            connectionLater: self.selectedConnectionMode == .unconfigured,
            remoteAuthIssue: self.remoteAuthIssue != nil,
            aiIssue: aiIssue,
            aiNothingFound: self.aiSetup.phase == .ready && self.aiSetup.candidates.isEmpty &&
                self.aiSetup.providerCatalogLoaded &&
                self.aiSetup.detectError == nil && self.aiSetup.configuredGatewayAuthIssue == nil,
            aiWaitingForEarlierTest: self.aiSetup.waitingForPendingActivationDeadline,
            aiSigningIn: self.aiSetup.activeAuthOption != nil,
            reachabilitySignIn: self.openClawID.accountUnavailableReason == nil,
            finish: self.finishKind)
    }

    var mascotAccessory: OpenClawMascotAccessory {
        Self.mascotAccessory(for: self.mascotPage)
    }

    private var finishKind: FinishKind {
        if case .node = self.finishState.connectionCompletion { return .nodeJoined }
        if self.savedBrowserGatewayName != nil { return .gatewaySaved }
        if self.selectedConnectionMode == .unconfigured { return .later }
        if self.aiSetup.verifiedExistingInference || self.primaryIsJoinedClaw { return .existingSetup }
        return .guide
    }

    private var mascotPage: MascotPage {
        switch self.activePageIndex {
        case self.connectionPageIndex: .connection
        case self.findPageIndex: .find
        case self.cliPageIndex: .cli
        case self.aiPageIndex: .ai
        case self.reachabilityPageIndex: .reachability
        case self.readyPageIndex: .ready
        default: .welcome
        }
    }

    static func aiSetupLooksFailed(_ aiSetup: OnboardingAISetupModel) -> Bool {
        self.aiIssue(for: aiSetup) != nil
    }

    static func aiIssue(for aiSetup: OnboardingAISetupModel) -> AIIssue? {
        guard !aiSetup.connected else { return nil }
        if aiSetup.configuredGatewayAuthIssue != nil { return .gatewayAuth }
        if aiSetup.detectError != nil { return .gatewayUnavailable }
        if aiSetup.manualError != nil { return .keyFailed }
        let candidateFailed = aiSetup.statuses.values.contains { status in
            if case .failed = status { return true }
            return false
        }
        if candidateFailed { return .testFailed }
        return aiSetup.providerCatalogError != nil ? .listFailed : nil
    }

    static func mascotMood(for snapshot: MascotMoodSnapshot) -> OpenClawMascotMood {
        switch snapshot.page {
        case .welcome:
            .idle
        case .connection, .find:
            switch snapshot.remoteProbeState {
            case .checking: .thinking
            case .failed: .sad
            case .ok: .happy
            case .idle: .curious
            }
        case .cli:
            if snapshot.cliInstalled {
                .happy
            } else if snapshot.cliStatusKnown, !snapshot.installingCLI {
                // Mirrors the page's install-failed card.
                .sad
            } else {
                .working
            }
        case .ai:
            if case .connected = snapshot.aiPhase {
                .celebrating
            } else if snapshot.aiBusy || snapshot.aiSigningIn || snapshot.aiWaitingForEarlierTest {
                .thinking
            } else if snapshot.aiFailed {
                .sad
            } else {
                .curious
            }
        case .reachability:
            .happy
        case .ready:
            .celebrating
        }
    }

    static func mascotAccessory(for page: MascotPage) -> OpenClawMascotAccessory {
        switch page {
        case .ready: .gradCap
        case .welcome, .connection, .find, .cli, .ai, .reachability: .none
        }
    }
}
