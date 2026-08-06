struct OpenClawOutputRouteDevice: Equatable {
  let name: String
  let physical: Bool
}

enum OpenClawOutputRouteDecision: Equatable {
  case ready
  case retry
  case fail([String])
}

func decideOpenClawOutputRoute(
  _ devices: [OpenClawOutputRouteDevice]
) -> OpenClawOutputRouteDecision {
  guard !devices.isEmpty else {
    // CoreAudio can briefly clear the process device list during a legitimate
    // call handoff. Retry only this absence; a concrete unsafe route fails.
    return .retry
  }
  guard devices.allSatisfy(\.physical) else {
    return .fail(devices.map(\.name))
  }
  return .ready
}
