package com.steipete.clawdis.node.bridge

object BonjourEscapes {
  fun decode(input: String): String {
    if (input.isEmpty()) return input

    val out = StringBuilder(input.length)
    var i = 0
    while (i < input.length) {
      if (input[i] == '\\' && i + 3 < input.length) {
        val d0 = input[i + 1]
        val d1 = input[i + 2]
        val d2 = input[i + 3]
        if (d0.isDigit() && d1.isDigit() && d2.isDigit()) {
          val value =
            ((d0.code - '0'.code) * 100) + ((d1.code - '0'.code) * 10) + (d2.code - '0'.code)
          if (value in 0..0x10FFFF) {
            out.appendCodePoint(value)
            i += 4
            continue
          }
        }
      }

      out.append(input[i])
      i += 1
    }
    return out.toString()
  }
}
