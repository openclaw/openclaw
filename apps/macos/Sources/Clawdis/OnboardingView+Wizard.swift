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
                    if let error = self.onboardingWizard.errorMessage {
                        Text("Wizard error")
                            .font(.headline)
                        Text(error)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Retry") {
                            self.onboardingWizard.reset()
                            Task {
                                await self.onboardingWizard.startIfNeeded(
                                    mode: self.state.connectionMode,
                                    workspace: self.workspacePath.isEmpty ? nil : self.workspacePath)
                            }
                        }
                        .buttonStyle(.borderedProminent)
                    } else if self.onboardingWizard.isStarting {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Starting wizard…")
                                .foregroundStyle(.secondary)
                        }
                    } else if let step = self.onboardingWizard.currentStep {
                        OnboardingWizardStepView(
                            step: step,
                            isSubmitting: self.onboardingWizard.isSubmitting)
                        { value in
                            Task { await self.onboardingWizard.submit(step: step, value: value) }
                        }
                        .id(step.id)
                    } else if self.onboardingWizard.isComplete {
                        Text("Wizard complete. Continue to the next step.")
                            .font(.headline)
                    } else {
                        Text("Waiting for wizard…")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .task {
                await self.onboardingWizard.startIfNeeded(
                    mode: self.state.connectionMode,
                    workspace: self.workspacePath.isEmpty ? nil : self.workspacePath)
            }
        }
    }
}
