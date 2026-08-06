@main
struct OutputRouteReadinessChecks {
  static func main() {
    expect(
      decideOpenClawOutputRoute([]) == .retry,
      "temporary empty route is retried")
    expect(
      decideOpenClawOutputRoute([
        OpenClawOutputRouteDevice(name: "MacBook Air Speakers", physical: true)
      ]) == .ready,
      "physical output is accepted")
    expect(
      decideOpenClawOutputRoute([
        OpenClawOutputRouteDevice(name: "BlackHole 16ch", physical: false)
      ]) == .fail(["BlackHole 16ch"]),
      "virtual output fails immediately")
    expect(
      decideOpenClawOutputRoute([
        OpenClawOutputRouteDevice(name: "MacBook Air Speakers", physical: true),
        OpenClawOutputRouteDevice(name: "OpenClaw-Feed", physical: false),
      ]) == .fail(["MacBook Air Speakers", "OpenClaw-Feed"]),
      "mixed physical and virtual output fails immediately")
  }

  private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
      fatalError("Output route readiness check failed: \(message)")
    }
  }
}
