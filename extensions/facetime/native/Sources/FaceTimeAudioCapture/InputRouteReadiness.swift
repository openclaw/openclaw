import Foundation

enum OpenClawInputRoutePhase: Equatable {
  case initialReadiness
  case steadyState
}

enum OpenClawInputRouteDecision: Equatable {
  case ready
  case retry
  case fail([String])
}

func decideOpenClawInputRoute(
  _ deviceNames: [String],
  phase: OpenClawInputRoutePhase
) -> OpenClawInputRouteDecision {
  if !deviceNames.isEmpty && deviceNames.allSatisfy({ $0 == "OpenClaw-Mic" }) {
    return .ready
  }
  if phase == .initialReadiness || deviceNames.isEmpty {
    return .retry
  }
  return .fail(deviceNames)
}
