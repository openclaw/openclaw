import AppKit
import OpenClawProtocol
import SwiftUI

/// Provider sign-in, model preparation, and activation steps, shown inside the picker row that started them.
struct OnboardingProviderSetupSteps: View {
    @Bindable var model: OnboardingAISetupModel
    @State private var openedProviderAuthURL: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            self.content
            self.actions
        }
        .environment(\.openURL, AppActivation.shared.openURLAction)
        .onAppear {
            self.openProviderAuthURLIfNeeded(self.model.authStep?.externalurl)
        }
        .onChange(of: self.model.authStep?.externalurl) { _, rawURL in
            self.openProviderAuthURLIfNeeded(rawURL)
        }
    }

    private var actions: some View {
        HStack {
            Button("Cancel") { self.model.cancelProviderAuth() }
                .keyboardShortcut(.cancelAction)
                .disabled(self.model.providerAuthCancellation == .requesting)
            Spacer(minLength: 0)
            if let title = self.continueTitle {
                Button(title) { self.model.continueProviderAuth() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(self.model.authBusy)
            }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 16) {
            if self.model.providerAuthCancellation == .requesting {
                self.activity(String(localized: "Canceling…"))
            } else if let step = self.model.authStep {
                let deviceCode = parseWizardDeviceCode(step.devicecode)
                if deviceCode == nil,
                   let title = step.title, !title.isEmpty,
                   title != self.model.activeAuthOption?.label
                {
                    Text(title).font(.headline)
                }
                if let deviceCode {
                    self.deviceCodeStep(deviceCode)
                } else if wizardStepExecutor(step) == "gateway" {
                    self.activity(step.message ?? String(localized: "Working…"))
                } else if let message = step.message, !message.isEmpty {
                    Text(message)
                        .textSelection(.enabled)
                }
                if deviceCode == nil,
                   let url = OnboardingProviderAuthLink.safeURL(step.externalurl)
                {
                    Link("Open sign-in page…", destination: url)
                        .font(.caption.weight(.semibold))
                }
                if wizardStepExecutor(step) != "gateway" {
                    self.authStepInput(step)
                        .disabled(self.model.authBusy || self.model.providerAuthCancellation != nil)
                }
            } else if self.model.authBusy {
                self.activity(self.model.providerWizardKind == .activation
                    ? String(localized: "Preparing your AI connection…")
                    : self.model.isPreparingModel
                    ? String(localized: "Starting local model setup…")
                    : String(localized: "Starting secure sign-in…"))
            }

            if let error = self.model.authError {
                OnboardingErrorCard(
                    title: self.model.providerAuthCancellation == .unconfirmed
                        ? String(localized: "Cancellation not confirmed")
                        : self.model.providerWizardKind == .activation
                        ? String(localized: "AI setup didn’t complete")
                        : self.model.isPreparingModel
                        ? String(localized: "Model setup didn’t complete")
                        : String(localized: "Sign-in didn’t complete"),
                    message: error.summary,
                    details: error.detail,
                    docsSlug: "concepts/model-providers",
                    retry: nil)
            }
        }
        .font(.callout)
    }

    private func activity(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            ProgressView()
                .controlSize(.small)
                .accessibilityLabel("Working")
            Text(message)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var continueTitle: String? {
        guard self.model.providerAuthCancellation == nil,
              let step = self.model.authStep,
              wizardStepExecutor(step) != "gateway"
        else { return nil }
        if parseWizardDeviceCode(step.devicecode) != nil {
            return String(localized: "I've signed in")
        }
        return String(localized: "Continue")
    }

    private func deviceCodeStep(_ deviceCode: WizardDeviceCodePresentation) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Finish in your browser")
                    .font(.headline)
                Text(deviceCode
                    .message ?? String(localized: "Enter this one-time code on the provider's sign-in page."))
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 12) {
                Text(deviceCode.code)
                    .font(.system(.title2, design: .monospaced).weight(.semibold))
                    .textSelection(.enabled)
                Spacer(minLength: 8)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(deviceCode.code, forType: .string)
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(OnboardingSurface(cornerRadius: 10))

            HStack(spacing: 12) {
                if let minutes = deviceCode.expiresInMinutes {
                    Label(String(format: String(localized: "Expires in %lld minutes"), minutes), systemImage: "clock")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if let url = OnboardingProviderAuthLink.safeURL(self.model.authStep?.externalurl) {
                    Link(destination: url) {
                        Label("Open sign-in page", systemImage: "arrow.up.right.square")
                    }
                    .font(.caption.weight(.semibold))
                }
            }
        }
    }

    private func openProviderAuthURLIfNeeded(_ rawURL: String?) {
        guard let url = OnboardingProviderAuthLink.safeURL(rawURL),
              url != openedProviderAuthURL
        else { return }
        self.openedProviderAuthURL = url
        AppActivation.shared.open(url)
    }

    @ViewBuilder
    private func authStepInput(_ step: WizardStep) -> some View {
        switch wizardStepType(step) {
        case "text":
            if step.sensitive == true {
                SecureField(step.placeholder ?? "", text: self.$model.authText)
                    .textFieldStyle(.roundedBorder)
            } else {
                TextField(step.placeholder ?? "", text: self.$model.authText)
                    .textFieldStyle(.roundedBorder)
            }
        case "select":
            Picker("", selection: self.$model.authSelection) {
                ForEach(Array(self.model.authWizardOptions.enumerated()), id: \.offset) { index, option in
                    Text(option.label).tag(index)
                }
            }
            .labelsHidden()
        case "confirm":
            Toggle("Confirm", isOn: self.$model.authConfirmation)
        default:
            EmptyView()
        }
    }
}
