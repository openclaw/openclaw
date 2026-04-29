package ai.openclaw.app.buddy

object BuddyCameraSnapPlan {
  fun paramsJsonSequence(): List<String> =
    listOf(
      """{"facing":"front","format":"jpg","maxWidth":1280,"quality":0.82}""",
      """{"facing":"back","format":"jpg","maxWidth":1280,"quality":0.82}""",
    )

  fun shouldTryNext(errorMessage: String?): Boolean {
    val normalized = errorMessage?.trim()?.lowercase() ?: return false
    return "no available camera" in normalized || "no camera found" in normalized
  }
}
