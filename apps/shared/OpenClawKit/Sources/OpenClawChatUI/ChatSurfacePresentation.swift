import Foundation

/// Shared chat-canvas story for iOS Chat, the macOS chat window, and Quick Chat.
/// Hosts must not overlay a second empty, loading, or connection surface on top
/// of this decision. iOS Chat owns gateway chrome and passes a concrete
/// `ChatHostConnectionStatus`; macOS hosts leave it `.unmanaged`.
enum ChatSurfacePresentation: Equatable, Sendable {
    case preparing
    case loading
    case emptyIntro
    case emptyUnavailable
    case error
    case transcript
}

/// Host-owned gateway chrome. `unmanaged` keeps ChatView's own error banner
/// (macOS window and Quick Chat). iOS Chat owns the toolbar pill and must pass
/// a concrete state so Connecting and Disconnected cannot both dominate.
public enum ChatHostConnectionStatus: Equatable, Sendable {
    case unmanaged
    case connected
    case connecting
    case disconnected
    case error
}

struct ChatSurfaceState: Equatable, Sendable {
    var hasSession: Bool
    var isLoading: Bool
    var hasVisibleTranscript: Bool
    var isEmptyThread: Bool
    var errorText: String?
    var composerChromeIsClean: Bool
    var hasEmptyAssistantIntro: Bool
    var isComposerEnabled: Bool
    var hostConnection: ChatHostConnectionStatus
}

struct ChatSurfaceDecision: Equatable, Sendable {
    var presentation: ChatSurfacePresentation
    var mountsComposer: Bool
    var showsInlineLoadingCapsule: Bool
    var showsErrorBanner: Bool
}

func chatSurfaceNormalizedErrorText(_ errorText: String?) -> String? {
    guard let text = errorText?.trimmingCharacters(in: .whitespacesAndNewlines),
          !text.isEmpty
    else {
        return nil
    }
    return text
}

func chatSurfaceErrorIsConnectionFailure(_ error: String) -> Bool {
    let lower = error.lowercased()
    return lower.contains("not connected") || lower.contains("socket")
}

func chatSurfaceDecision(_ state: ChatSurfaceState) -> ChatSurfaceDecision {
    if !state.hasSession {
        return ChatSurfaceDecision(
            presentation: .preparing,
            mountsComposer: false,
            showsInlineLoadingCapsule: false,
            showsErrorBanner: false)
    }

    let errorText = chatSurfaceNormalizedErrorText(state.errorText)
    let hasError = errorText != nil
    let isConnectionError = errorText.map(chatSurfaceErrorIsConnectionFailure) ?? false
    let hostOwnsConnectionChrome = state.hostConnection != .unmanaged
    let suppressConnectionErrorChrome = hostOwnsConnectionChrome && isConnectionError
    let hostIsConnecting = state.hostConnection == .connecting

    if state.hasVisibleTranscript {
        return ChatSurfaceDecision(
            presentation: .transcript,
            mountsComposer: true,
            showsInlineLoadingCapsule: false,
            showsErrorBanner: hasError && !state.isLoading && !suppressConnectionErrorChrome)
    }

    if state.isLoading || (hostIsConnecting && isConnectionError) {
        return ChatSurfaceDecision(
            presentation: .loading,
            mountsComposer: true,
            showsInlineLoadingCapsule: state.composerChromeIsClean,
            showsErrorBanner: false)
    }

    if hasError, !suppressConnectionErrorChrome {
        return ChatSurfaceDecision(
            presentation: .error,
            mountsComposer: true,
            showsInlineLoadingCapsule: false,
            showsErrorBanner: false)
    }

    if state.isEmptyThread,
       state.composerChromeIsClean,
       state.hasEmptyAssistantIntro,
       state.isComposerEnabled
    {
        return ChatSurfaceDecision(
            presentation: .emptyIntro,
            mountsComposer: true,
            showsInlineLoadingCapsule: false,
            showsErrorBanner: false)
    }

    if state.isEmptyThread {
        return ChatSurfaceDecision(
            presentation: .emptyUnavailable,
            mountsComposer: true,
            showsInlineLoadingCapsule: false,
            showsErrorBanner: false)
    }

    return ChatSurfaceDecision(
        presentation: .transcript,
        mountsComposer: true,
        showsInlineLoadingCapsule: false,
        showsErrorBanner: false)
}
