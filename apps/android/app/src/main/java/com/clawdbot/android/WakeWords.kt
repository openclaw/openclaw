package com.clawdbot.android

object WakeWords {
  const val maxWords: Int = 32
  const val maxWordLength: Int = 64

  fun parseCommaSeparated(input: String): List<String> {
    return input.split(",").map { it.trim() }.filter { it.isNotEmpty() }
  }

  fun sanitize(words: List<String>, defaults: List<String>): List<String> {
    val cleaned =
      words.map { it.trim() }.filter { it.isNotEmpty() }.take(maxWords).map { it.take(maxWordLength) }
    return cleaned.ifEmpty { defaults }
  }
}

