@main
struct InputRouteReadinessChecks {
  static func main() {
    expect(
      decideOpenClawInputRoute([], phase: .initialReadiness) == .retry,
      "initial readiness retries an empty route")
    expect(
      decideOpenClawInputRoute(["MacBook Air Microphone"], phase: .initialReadiness)
        == .retry,
      "initial readiness retries a transitional physical route")
    expect(
      decideOpenClawInputRoute(
        ["MacBook Air Microphone", "OpenClaw-Mic"],
        phase: .initialReadiness)
        == .retry,
      "initial readiness retries a transitional mixed route")
    expect(
      decideOpenClawInputRoute(["OpenClaw-Mic"], phase: .initialReadiness)
        == .ready,
      "initial readiness accepts only OpenClaw-Mic")
    expect(
      decideOpenClawInputRoute([], phase: .steadyState) == .retry,
      "steady state retries a temporary empty route")
    expect(
      decideOpenClawInputRoute(["MacBook Air Microphone"], phase: .steadyState)
        == .fail(["MacBook Air Microphone"]),
      "steady state fails immediately on physical-route drift")
    expect(
      decideOpenClawInputRoute(
        ["OpenClaw-Mic", "MacBook Air Microphone"],
        phase: .steadyState)
        == .fail(["OpenClaw-Mic", "MacBook Air Microphone"]),
      "steady state fails immediately on mixed-route drift")
  }

  private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
      fatalError("Input route readiness check failed: \(message)")
    }
  }
}
