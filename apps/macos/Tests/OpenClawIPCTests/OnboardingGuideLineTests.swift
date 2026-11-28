import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

@MainActor
struct OnboardingGuideLineTests {
    private typealias Snapshot = OnboardingView.MascotMoodSnapshot

    private static let probeInput = RemoteGatewayProbeInput(transport: .direct, target: "wss://gateway.test", token: "")

    private static let probeStates: [RemoteOnboardingProbeState] = [
        .idle,
        .checking(probeInput),
        .failed(probeInput, "no route"),
        .ok(probeInput, RemoteGatewayProbeSuccess(authSource: nil)),
    ]

    private static let installPhases: [OnboardingView.CLIInstallPhase] = [
        .idle, .choosingTarget, .installing, .startingService,
    ]

    private static let aiPhases: [OnboardingAISetupModel.Phase] = [
        .idle, .detecting, .ready, .testing, .connected(.custodianOnboarding), .connected(.dashboard),
    ]

    private static let failureLines: Set<OnboardingGuideLine> = [
        .findFailed, .findNeedsPermission, .prepareFailed, .startFailed,
        .aiTestFailed, .aiKeyFailed, .aiGatewayUnavailable, .aiGatewayAuth, .aiListFailed,
    ]

    private static let successLines: Set<OnboardingGuideLine> = [
        .aiConnected, .doneGuide, .doneExisting, .doneLater, .doneNode, .doneGatewaySaved,
    ]

    private static let bools = [false, true]

    static func allSnapshots() -> [OnboardingView.MascotMoodSnapshot] {
        var snapshots: [Snapshot] = []
        for page in OnboardingView.MascotPage.allCases {
            switch page {
            case .welcome:
                snapshots.append(Snapshot(page: page))
            case .reachability:
                for signIn in self.bools {
                    snapshots.append(Snapshot(page: page, reachabilitySignIn: signIn))
                }
            case .connection:
                for later in self.bools {
                    snapshots.append(Snapshot(page: page, connectionLater: later))
                }
            case .find:
                for probe in self.probeStates {
                    for authIssue in self.bools where !authIssue || probe.isFailed {
                        snapshots.append(Snapshot(page: page, remoteProbeState: probe, remoteAuthIssue: authIssue))
                    }
                }
            case .cli:
                snapshots += self.cliSnapshots()
            case .ai:
                snapshots += self.aiSnapshots()
            case .ready:
                for finish in OnboardingView.FinishKind.allCases {
                    snapshots.append(Snapshot(page: page, finish: finish))
                }
            }
        }
        return snapshots
    }

    private static func cliSnapshots() -> [Snapshot] {
        var snapshots: [Snapshot] = []
        for installing in self.bools {
            for installed in self.bools {
                for known in self.bools {
                    for executableReady in self.bools {
                        for phase in self.installPhases where installing || phase == .idle {
                            snapshots.append(Snapshot(
                                page: .cli,
                                installingCLI: installing,
                                cliInstalled: installed,
                                cliStatusKnown: known,
                                cliExecutableReady: executableReady,
                                cliInstallPhase: phase))
                        }
                    }
                }
            }
        }
        return snapshots
    }

    private static func aiSnapshots() -> [Snapshot] {
        var snapshots: [Snapshot] = []
        let issues: [OnboardingView.AIIssue?] = [nil] + OnboardingView.AIIssue.allCases
        for phase in self.aiPhases {
            let connected = if case .connected = phase {
                true
            } else {
                false
            }
            for issue in issues where !connected || issue == nil {
                for nothingFound in self.bools {
                    for waiting in self.bools where !waiting || phase == .detecting {
                        for signingIn in self.bools {
                            for extraBusy in self.bools {
                                snapshots.append(Snapshot(
                                    page: .ai,
                                    aiPhase: phase,
                                    aiBusy: phase == .detecting || phase == .testing || extraBusy,
                                    aiFailed: issue != nil,
                                    aiIssue: issue,
                                    aiNothingFound: nothingFound,
                                    aiWaitingForEarlierTest: waiting,
                                    aiSigningIn: signingIn))
                            }
                        }
                    }
                }
            }
        }
        return snapshots
    }

    private func line(_ snapshot: Snapshot) -> OnboardingGuideLine {
        OnboardingView.guideLine(for: snapshot)
    }

    @Test func `every line is reachable`() {
        let reached = Set(Self.allSnapshots().map { OnboardingView.guideLine(for: $0) })
        #expect(Set(OnboardingGuideLine.allCases).subtracting(reached).isEmpty)
    }

    @Test func `the mascot mood and the guide line never disagree`() {
        for snapshot in Self.allSnapshots() {
            let mood = OnboardingView.mascotMood(for: snapshot)
            let line = self.line(snapshot)
            #expect(
                (mood == .sad) == Self.failureLines.contains(line),
                "\(mood) vs \(line) on \(snapshot.page)")
            #expect(
                (mood == .celebrating) == Self.successLines.contains(line),
                "\(mood) vs \(line) on \(snapshot.page)")
        }
    }

    @Test func `lines speak plainly`() {
        for line in OnboardingGuideLine.allCases {
            let text = line.text
            let lowered = text.lowercased()
            #expect(!text.contains("`"), "\(line) has a backtick")
            #expect(!text.contains("/"), "\(line) has a path")
            #expect(text.rangeOfCharacter(from: .decimalDigits) == nil, "\(line) has a number")
            for jargon in [" type ", "run ", "terminal", "localhost", "gateway address"] {
                #expect(!lowered.contains(jargon), "\(line) says \(jargon)")
            }
            #expect(!text.contains("'"), "\(line) uses a straight apostrophe")
        }
    }

    @Test func `the welcome line introduces the guide`() {
        #expect(OnboardingGuideLine.welcome.text.hasPrefix("Hi, I’m OpenClaw, your guide."))
    }

    @Test func `the AI page shows the highest priority fact`() {
        let busy = Snapshot(
            page: .ai, aiPhase: .ready, aiBusy: true, aiFailed: true, aiIssue: .keyFailed, aiSigningIn: true)
        #expect(self.line(busy) == .aiSigningIn)
        var testing = busy
        testing.aiSigningIn = false
        #expect(self.line(testing) == .aiTesting)
        var failed = Snapshot(page: .ai, aiPhase: .ready, aiFailed: true, aiIssue: .testFailed, aiNothingFound: true)
        #expect(self.line(failed) == .aiTestFailed)
        failed.aiIssue = .gatewayAuth
        #expect(self.line(failed) == .aiGatewayAuth)
        failed.aiIssue = nil
        #expect(self.line(failed) == .aiNothingFound)
        failed.aiNothingFound = false
        #expect(self.line(failed) == .aiChoose)
        #expect(self.line(.init(page: .ai, aiPhase: .connected(.dashboard), aiFailed: true, aiIssue: .keyFailed))
            == .aiConnected)
    }

    @Test func `the find page narrates the remote check`() {
        #expect(self.line(.init(page: .find)) == .findChoose)
        #expect(self.line(.init(page: .find, remoteProbeState: .checking(Self.probeInput))) == .findChecking)
        #expect(self.line(.init(page: .find, remoteProbeState: Self.probeStates[3])) == .findReached)
        #expect(self.line(.init(page: .find, remoteProbeState: .failed(Self.probeInput, "no route"))) == .findFailed)
        #expect(self.line(.init(
            page: .find,
            remoteProbeState: .failed(Self.probeInput, "no route"),
            remoteAuthIssue: true)) == .findNeedsPermission)
    }
}

extension RemoteOnboardingProbeState {
    fileprivate var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }
}
