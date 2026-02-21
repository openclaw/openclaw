package ai.openclaw.android

object WakeWords {
  const val maxWords: Int = 32
  const val maxWordLength: Int = 64

  data class Preset(
    val id: String,
    val label: String,
    val words: List<String>,
  )

  val omiPresets: List<Preset> =
    listOf(
      Preset(
        id = "omi_devkit",
        label = "Omi Dev Kit",
        words = listOf("omi", "hey omi"),
      ),
      Preset(
        id = "friend_pendant",
        label = "Friend Pendant",
        words = listOf("friend", "hey friend"),
      ),
      Preset(
        id = "limitless",
        label = "Limitless",
        words = listOf("limitless", "hey limitless"),
      ),
    )

  fun presetById(id: String?): Preset? {
    if (id.isNullOrBlank()) return null
    return omiPresets.firstOrNull { it.id == id }
  }

  fun parseCommaSeparated(input: String): List<String> {
    return input.split(',').map { it.trim() }.filter { it.isNotEmpty() }
  }

  fun parseIfChanged(input: String, current: List<String>): List<String>? {
    val parsed = parseCommaSeparated(input)
    return if (parsed == current) null else parsed
  }

  fun sanitize(words: List<String>, defaults: List<String>): List<String> {
    val cleaned =
      words
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .map { it.take(maxWordLength) }
        .distinctBy { it.lowercase() }
        .take(maxWords)

    return cleaned.ifEmpty { defaults }
  }

  fun mergePresets(current: List<String>, presets: List<Preset>): List<String> {
    val additions = presets.flatMap { it.words }
    return sanitize(words = current + additions, defaults = current)
  }
}
