import Observation
import OpenClawProtocol
import SwiftUI

extension OnboardingView {
    func wizardPage() -> some View {
        self.onboardingPage {
            VStack(spacing: 16) {
                Text(self.wizardTitle)
                    .font(.largeTitle.weight(.semibold))
                Text(self.wizardSubtitle)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 520)

                self.onboardingCard(spacing: 14, padding: 16) {
                    OnboardingWizardCardContent(
                        wizard: self.onboardingWizard,
                        isConsumer: AppFlavor.current.isConsumer,
                        mode: self.state.connectionMode,
                        workspacePath: self.workspacePath)
                }
            }
            .task {
                await self.onboardingWizard.startIfNeeded(
                    mode: self.state.connectionMode,
                    workspace: self.workspacePath.isEmpty ? nil : self.workspacePath)
            }
        }
    }

    private var wizardTitle: String {
        guard AppFlavor.current.isConsumer else { return "Setup Wizard" }
        if self.onboardingWizard.errorMessage != nil { return "Something went wrong" }
        if self.onboardingWizard.isComplete { return "You're all set" }
        return "Setting up OpenClaw"
    }

    private var wizardSubtitle: String {
        guard AppFlavor.current.isConsumer else {
            return "Follow the guided setup from the Gateway. This keeps onboarding in sync with the CLI."
        }
        if self.onboardingWizard.errorMessage != nil {
            return "OpenClaw couldn’t finish setup."
        }
        if self.onboardingWizard.isComplete {
            return "OpenClaw is ready. Click Finish to continue."
        }
        return "This usually takes a moment."
    }
}

struct OnboardingWizardCardContent: View {
    @Bindable var wizard: OnboardingWizardModel
    let isConsumer: Bool
    let mode: AppState.ConnectionMode
    let workspacePath: String

    private enum CardState {
        case error(String)
        case starting
        case step(WizardStep)
        case complete
        case waiting
    }

    private var state: CardState {
        if let error = wizard.errorMessage { return .error(error) }
        if self.wizard.isStarting { return .starting }
        if let step = wizard.currentStep { return .step(step) }
        if self.wizard.isComplete { return .complete }
        return .waiting
    }

    private func consumerErrorMessage(for error: String) -> String {
        let lower = error.lowercased()
        if lower.contains("gateway did not become ready") {
            return "OpenClaw couldn’t finish setup. Try again."
        }
        if lower.contains("wizard session lost") {
            return "Setup was interrupted. Try again."
        }
        return "OpenClaw couldn’t finish setup. Try again."
    }

    var body: some View {
        switch self.state {
        case let .error(error):
            Text(self.isConsumer ? "Setup problem" : "Wizard error")
                .font(.headline)
            Text(self.isConsumer ? self.consumerErrorMessage(for: error) : error)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(self.isConsumer ? "Try Again" : "Retry") {
                self.wizard.reset()
                Task {
                    await self.wizard.startIfNeeded(
                        mode: self.mode,
                        workspace: self.workspacePath.isEmpty ? nil : self.workspacePath)
                }
            }
            .buttonStyle(.borderedProminent)
        case .starting:
            HStack(spacing: 8) {
                ProgressView()
                Text(self.isConsumer ? "Getting OpenClaw ready…" : "Starting wizard…")
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
            Text(self.isConsumer ? "OpenClaw is ready." : "Wizard complete. Continue to the next step.")
                .font(.headline)
        case .waiting:
            Text(self.isConsumer ? "Getting OpenClaw ready…" : "Waiting for wizard…")
                .foregroundStyle(.secondary)
        }
    }
}
