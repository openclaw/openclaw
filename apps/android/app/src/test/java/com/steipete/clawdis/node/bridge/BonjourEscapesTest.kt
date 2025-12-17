package com.steipete.clawdis.node.bridge

import org.junit.Assert.assertEquals
import org.junit.Test

class BonjourEscapesTest {
  @Test
  fun decodeNoop() {
    assertEquals("", BonjourEscapes.decode(""))
    assertEquals("hello", BonjourEscapes.decode("hello"))
  }

  @Test
  fun decodeDecodesDecimalEscapes() {
    assertEquals("Clawdis Gateway", BonjourEscapes.decode("Clawdis\\032Gateway"))
    assertEquals("A B", BonjourEscapes.decode("A\\032B"))
  }
}

