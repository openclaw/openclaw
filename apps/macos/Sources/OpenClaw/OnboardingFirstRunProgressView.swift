import SwiftUI

extension OnboardingFirstRun.Step {
    var title: String {
        switch self {
        case .preparingRuntime: String(localized: "Preparing runtime…")
        case .startingGateway: String(localized: "Starting Gateway…")
        case .openingDashboard: String(localized: "Opening dashboard…")
        }
    }
}

struct OnboardingFirstRunProgressView: View {
    let step: OnboardingFirstRun.Step
    let setUpManually: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "desktopcomputer")
                .font(.system(size: 64, weight: .light))
                .foregroundStyle(Color.accentColor)
                .accessibilityHidden(true)
            Text("Setting up OpenClaw on this Mac")
                .font(.title.weight(.semibold))
                .multilineTextAlignment(.center)
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text(self.step.title)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            Spacer()
            Button("Set up manually", action: self.setUpManually)
                .buttonStyle(.link)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}
