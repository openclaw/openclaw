package ai.openclaw.app

/** Device-local text-size stops shared with the Web appearance picker. */
enum class AppearanceTextScale(
  val percent: Int,
) {
  Small(90),
  Standard(100),
  Large(110),
  ExtraLarge(125),
  Largest(140),
  ;

  val factor: Float get() = percent / 100f

  companion object {
    fun fromPercent(value: Int?): AppearanceTextScale = entries.firstOrNull { it.percent == value } ?: Standard
  }
}
