import Observation
import OpenClawProtocol
import SwiftUI

extension OnboardingView {
    func wizardPage() -> some View {
        self.onboardingPage {
            VStack(spacing: 16) {
                Text("Setup Wizard")
                    .font(.largeTitle.weight(.semibold))
                Text("Follow the guided setup from the Gateway. This keeps onboarding in sync with the CLI.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 520)

                self.onboardingCard(spacing: 14, padding: 16) {
                    OnboardingWizardCardContent(
                        wizard: self.onboardingWizard,
                        mode: self.state.connectionMode,
                        workspacePath: self.workspacePath,
                        paused: self.state.isPaused,
                        onResume: { self.state.isPaused = false })
                }
            }
            .task(id: "\(self.cliInstalled)-\(self.state.isPaused)") {
                guard self.state.connectionMode != .local || self.cliInstalled else { return }
                await self.onboardingWizard.startIfNeeded(
                    mode: self.state.connectionMode,
                    workspace: self.workspacePath.isEmpty ? nil : self.workspacePath)
            }
        }
    }
}

private struct OnboardingWizardCardContent: View {
    @Bindable var wizard: OnboardingWizardModel
    let mode: AppState.ConnectionMode
    let workspacePath: String
    let paused: Bool
    let onResume: () -> Void

    private enum CardState {
        case error(String)
        case paused
        case starting
        case step(WizardStep)
        case complete
        case waiting
    }

    private var state: CardState {
        if self.paused, !self.wizard.isComplete { return .paused }
        if let error = wizard.errorMessage { return .error(error) }
        if self.wizard.isStarting { return .starting }
        if let step = wizard.currentStep { return .step(step) }
        if self.wizard.isComplete { return .complete }
        return .waiting
    }

    var body: some View {
        switch self.state {
        case let .error(error):
            Text("Wizard error")
                .font(.headline)
            Text(error)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Retry") {
                self.wizard.reset()
                Task {
                    await self.wizard.startIfNeeded(
                        mode: self.mode,
                        workspace: self.workspacePath.isEmpty ? nil : self.workspacePath)
                }
            }
            .buttonStyle(.borderedProminent)
        case .paused:
            Text("Setup is paused")
                .font(.headline)
            Text("Resume OpenClaw to start the local Gateway and continue setup.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button("Resume setup", action: self.onResume)
                .buttonStyle(.borderedProminent)
        case .starting:
            HStack(spacing: 8) {
                ProgressView()
                Text("Starting wizard…")
                    .foregroundStyle(.secondary)
            }
        case let .step(step):
            OnboardingWizardStepView(
                step: step,
                isSubmitting: self.wizard.isSubmitting)
            { value in
                Task { await self.wizard.submit(step: step, value: value) }
            }
            .id(step.id)
        case .complete:
            Text("Wizard complete. Continue to the next step.")
                .font(.headline)
        case .waiting:
            Text("Waiting for wizard…")
                .foregroundStyle(.secondary)
        }
    }
}
