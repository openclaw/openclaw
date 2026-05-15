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

    init(registry: AmbientCommandRegistry = .default) {
        self.registry = registry
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
}
