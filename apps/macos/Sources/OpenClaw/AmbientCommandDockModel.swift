import Foundation
import Observation

@MainActor
@Observable
final class AmbientCommandDockModel {
    var inputText: String = "" {
        didSet { self.refreshSuggestions() }
    }

    private(set) var suggestions: [AmbientCommandSpec] = []
    var selectedSuggestionIndex: Int = 0
    var result: AmbientCommandResult = .none
    var thomasState: AmbientThomasOrbState = .ready
    var sessionLabel: String = "main session"
    var isSubmitting = false

    private let registry: AmbientCommandRegistry
    private let actions: AmbientCommandDockActionExecutor

    init(
        registry: AmbientCommandRegistry = .default,
        actions: AmbientCommandDockActionExecutor = AmbientCommandDockActionExecutor())
    {
        self.registry = registry
        self.actions = actions
    }

    func clear() {
        self.inputText = ""
        self.result = .none
        self.suggestions = []
        self.selectedSuggestionIndex = 0
        self.thomasState = .ready
    }

    func acceptSuggestion(_ suggestion: AmbientCommandSpec) {
        self.inputText = "\(suggestion.displayName) "
        self.suggestions = []
        self.selectedSuggestionIndex = 0
        self.result = .none
        self.thomasState = .focused
    }

    func moveSuggestionSelection(delta: Int) {
        guard !self.suggestions.isEmpty else { return }
        let next = self.selectedSuggestionIndex + delta
        self.selectedSuggestionIndex = min(max(next, 0), self.suggestions.count - 1)
    }

    func parsedInput() -> AmbientParsedInput {
        self.registry.parse(self.inputText)
    }

    func submit() async {
        let parsed = self.parsedInput()
        switch parsed {
        case .empty:
            return
        case let .prompt(message):
            await self.submitPrompt(message)
        case let .command(name, arguments):
            await self.submitCommand(name: name, arguments: arguments)
        case let .unknown(name, suggestions):
            let hint = suggestions.prefix(3).map(\.displayName).joined(separator: ", ")
            self.result = .failure(hint.isEmpty ? "Unknown command /\(name)" : "Unknown command /\(name). Try \(hint)")
            self.thomasState = .error
        }
    }

    private func refreshSuggestions() {
        let trimmed = self.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else {
            self.suggestions = []
            self.selectedSuggestionIndex = 0
            self.thomasState = trimmed.isEmpty ? .ready : .focused
            return
        }

        self.suggestions = Array(self.registry.suggestions(for: trimmed).prefix(8))
        self.selectedSuggestionIndex = min(self.selectedSuggestionIndex, max(self.suggestions.count - 1, 0))
        self.thomasState = .focused
    }

    private func submitPrompt(_ message: String) async {
        self.isSubmitting = true
        self.thomasState = .sending
        let outcome = await self.actions.sendPrompt(message)
        self.isSubmitting = false
        self.result = outcome
        if case .success = outcome {
            self.inputText = ""
        }
        self.thomasState = self.thomasState(for: outcome)
    }

    private func submitCommand(name: String, arguments: String) async {
        self.isSubmitting = true
        self.thomasState = .sending
        let outcome = await self.actions.execute(name: name, arguments: arguments)
        self.isSubmitting = false
        self.result = outcome
        if case .failure = outcome {
            self.thomasState = .error
        } else {
            self.inputText = ""
            self.thomasState = .success
        }
    }

    private func thomasState(for result: AmbientCommandResult) -> AmbientThomasOrbState {
        switch result {
        case .failure:
            .error
        case .none:
            .ready
        case .info, .success:
            .success
        }
    }
}
