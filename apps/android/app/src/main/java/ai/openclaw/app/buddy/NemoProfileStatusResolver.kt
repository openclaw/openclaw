package ai.openclaw.app.buddy

object NemoProfileStatusResolver {
  fun resolve(
    current: NemoProfileStatus,
    agentIds: Iterable<String>,
  ): NemoProfileStatus =
    when {
      NemoAgentProfile.hasNemoProfile(agentIds) -> NemoProfileStatus.Ready
      current == NemoProfileStatus.Initializing -> NemoProfileStatus.Initializing
      current == NemoProfileStatus.NeedsRestart -> NemoProfileStatus.NeedsRestart
      current == NemoProfileStatus.Failed -> NemoProfileStatus.Failed
      else -> NemoProfileStatus.Missing
    }
}
