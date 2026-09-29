package ai.openclaw.app

internal fun String.takeCodePoints(limit: Int): String {
  val count = codePointCount(0, length)
  if (count <= limit) return this
  return substring(0, offsetByCodePoints(0, limit))
}

internal fun String.takeUtf8Bytes(limit: Int): String {
  var end = 0
  var byteCount = 0
  while (end < length) {
    val codePoint = codePointAt(end)
    val codePointByteCount =
      when {
        codePoint <= 0x7f -> 1
        codePoint <= 0x7ff -> 2
        codePoint <= 0xffff -> 3
        else -> 4
      }
    if (byteCount + codePointByteCount > limit) break
    byteCount += codePointByteCount
    end += Character.charCount(codePoint)
  }
  return substring(0, end)
}
