import Foundation

enum OnboardingGuideLine: CaseIterable {
    case welcome
    case chooseWhere
    case setUpLater
    case findChoose
    case findChecking
    case findReached
    case findFailed
    case findNeedsPermission
    case preparing
    case askingToInstall
    case starting
    case prepared
    case prepareFailed
    case startFailed
    case aiLooking
    case aiChoose
    case aiNothingFound
    case aiTesting
    case aiSigningIn
    case aiTestFailed
    case aiKeyFailed
    case aiWaitingEarlierTest
    case aiGatewayUnavailable
    case aiGatewayAuth
    case aiListFailed
    case aiConnected
    case reachability
    case reachabilityNoSignIn
    case doneGuide
    case doneExisting
    case doneLater
    case doneNode
    case doneGatewaySaved

    var text: String {
        switch self {
        case .welcome:
            String(localized: """
            Hi, I’m OpenClaw, your guide. I’ll set things up with you, one step at a time. \
            Click Next when you’re ready.
            """)
        case .chooseWhere:
            String(localized: """
            First, where should your assistant live? Most people keep it on this Mac. Pick \
            one, then click Next.
            """)
        case .setUpLater:
            String(localized: "No problem, I won’t start anything yet. Click Next, and set it up whenever you like.")
        case .findChoose:
            String(localized: """
            Your assistant already runs on another computer. Choose how to reach it, then \
            click Next.
            """)
        case .findChecking:
            String(localized: "I’m checking that I can reach that computer. This takes a few seconds.")
        case .findReached:
            String(localized: "Found it, and it answered. Click Next to keep going.")
        case .findFailed:
            String(localized: """
            I couldn’t reach that computer. Make sure it’s turned on and the details are \
            right, then click Check connection.
            """)
        case .findNeedsPermission:
            String(localized: """
            That computer answered, but it hasn’t let this Mac in yet. Follow the steps \
            below, then click Check connection.
            """)
        case .preparing:
            String(localized: """
            I’m setting up the part of OpenClaw that runs on this Mac. You don’t need to do \
            anything. It usually takes a minute or two.
            """)
        case .askingToInstall:
            String(localized: """
            I need your OK before I install anything. Choose an option in the window that \
            just opened.
            """)
        case .starting:
            String(localized: "Almost there. I’m starting it up now.")
        case .prepared:
            String(localized: "Everything’s ready on this Mac. Click Next to connect your AI.")
        case .prepareFailed:
            String(localized: """
            Setup stopped before it finished. Click Try again. If it keeps happening, Open \
            help… explains why.
            """)
        case .startFailed:
            String(localized: "Everything is installed, but it didn’t start. Click Try again.")
        case .aiLooking:
            String(localized: "Now I need an AI to think with. I’m looking for accounts you already use.")
        case .aiChoose:
            String(localized: "I found AI you can use. Pick one and I’ll test it with a quick question.")
        case .aiNothingFound:
            String(localized: "I didn’t find an AI account I can use yet. Connect one below and I’ll test it.")
        case .aiTesting:
            String(localized: """
            I’m asking your AI a quick test question. This can take a little while, and you \
            don’t need to do anything.
            """)
        case .aiSigningIn:
            String(localized: "Follow the steps in the window that opened. I’ll wait right here.")
        case .aiTestFailed:
            String(localized: """
            That one didn’t answer. The note below says why. Pick another, or fix it and try \
            it again.
            """)
        case .aiKeyFailed:
            String(localized: "That key didn’t work. Check that you copied all of it, then click Connect again.")
        case .aiWaitingEarlierTest:
            String(localized: """
            I’m still finishing an earlier test. I’ll check again on my own, or you can \
            click Check again.
            """)
        case .aiGatewayUnavailable:
            String(localized: "I couldn’t reach the part of OpenClaw that runs your AI. Click Try again.")
        case .aiGatewayAuth:
            String(localized: "This Mac needs permission from your other computer first. Click Back to Gateway.")
        case .aiListFailed:
            String(localized: "I couldn’t load the list of AI services. Click Try again.")
        case .aiConnected:
            String(localized: "It answered! Your AI is connected.")
        case .reachability:
            String(localized: """
            Your AI works! One optional extra: OpenClaw ID lets you reach your assistant \
            from your other devices. Sign in, or click Not now to continue.
            """)
        case .reachabilityNoSignIn:
            String(localized: "Your AI works! Click Not now to continue.")
        case .doneGuide:
            String(localized: """
            You’re all set! Click Finish and I’ll open the Dashboard, where we’ll meet your \
            agent together.
            """)
        case .doneExisting:
            String(localized: """
            You’re all set, and your existing setup still works. Click Finish to open the \
            Dashboard.
            """)
        case .doneLater:
            String(localized: """
            That’s it for now. When you’re ready, you can set things up from the OpenClaw \
            icon in the menu bar.
            """)
        case .doneNode:
            String(localized: "This Mac is connected and ready to help. Click Finish to close setup.")
        case .doneGatewaySaved:
            String(localized: "Your connection is saved. Click Finish to close setup.")
        }
    }
}

extension OnboardingView {
    static func guideLine(for snapshot: MascotMoodSnapshot) -> OnboardingGuideLine {
        switch snapshot.page {
        case .welcome:
            .welcome
        case .connection:
            snapshot.connectionLater ? .setUpLater : .chooseWhere
        case .find:
            switch snapshot.remoteProbeState {
            case .idle: .findChoose
            case .checking: .findChecking
            case .ok: .findReached
            case .failed: snapshot.remoteAuthIssue ? .findNeedsPermission : .findFailed
            }
        case .cli:
            self.cliGuideLine(for: snapshot)
        case .ai:
            self.aiGuideLine(for: snapshot)
        case .reachability:
            snapshot.reachabilitySignIn ? .reachability : .reachabilityNoSignIn
        case .ready:
            switch snapshot.finish {
            case .guide: .doneGuide
            case .existingSetup: .doneExisting
            case .later: .doneLater
            case .nodeJoined: .doneNode
            case .gatewaySaved: .doneGatewaySaved
            }
        }
    }

    private static func cliGuideLine(for snapshot: MascotMoodSnapshot) -> OnboardingGuideLine {
        if snapshot.cliInstalled { return .prepared }
        if snapshot.installingCLI {
            return switch snapshot.cliInstallPhase {
            case .choosingTarget: .askingToInstall
            case .startingService: .starting
            case .idle, .installing: .preparing
            }
        }
        if snapshot.cliStatusKnown {
            return snapshot.cliExecutableReady ? .startFailed : .prepareFailed
        }
        return .preparing
    }

    private static func aiGuideLine(for snapshot: MascotMoodSnapshot) -> OnboardingGuideLine {
        if case .connected = snapshot.aiPhase { return .aiConnected }
        if snapshot.aiSigningIn { return .aiSigningIn }
        if snapshot.aiPhase == .testing || (snapshot.aiBusy && snapshot.aiPhase == .ready) {
            return .aiTesting
        }
        if snapshot.aiWaitingForEarlierTest { return .aiWaitingEarlierTest }
        if !snapshot.aiBusy, let issue = snapshot.aiIssue {
            return switch issue {
            case .gatewayAuth: .aiGatewayAuth
            case .gatewayUnavailable: .aiGatewayUnavailable
            case .keyFailed: .aiKeyFailed
            case .testFailed: .aiTestFailed
            case .listFailed: .aiListFailed
            }
        }
        if snapshot.aiNothingFound { return .aiNothingFound }
        return switch snapshot.aiPhase {
        case .ready, .testing, .connected: .aiChoose
        case .idle, .detecting: .aiLooking
        }
    }
}
