package ai.openclaw.app.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.xbill.DNS.DClass
import org.xbill.DNS.Message
import org.xbill.DNS.Name
import org.xbill.DNS.Record
import org.xbill.DNS.Section
import org.xbill.DNS.TXTRecord
import org.xbill.DNS.Type

class GatewayDnsTxtTest {
  @Test
  fun readsAdvertisedUtf8ValuesWithoutDnsPresentationEscapes() {
    val response = Message()
    response.addRecord(
      txtRecord(listOf("displayName=Claw \\123 \"Café\" 🦞", "gatewayTls=true", "gatewayPort=18789", "lanHost=claw.local")),
      Section.ADDITIONAL,
    )
    val records = Message(response.toWire()).getSection(Section.ADDITIONAL).map { it as TXTRecord }

    val name = gatewayDnsTxtValue(records, "displayName")
    assertEquals("Claw \\123 \"Café\" 🦞", name)
    assertEquals("true", gatewayDnsTxtValue(records, "gatewayTls"))
    assertEquals("18789", gatewayDnsTxtValue(records, "gatewayPort"))
    assertEquals("claw.local", gatewayDnsTxtValue(records, "lanHost"))
    assertNull(gatewayDnsTxtValue(records, "tailnetDns"))
  }

  @Test
  fun preservesTxtKeyMatchingWhitespaceAndFirstValue() {
    val records =
      listOf(
        txtRecord(listOf("displayNameExtra=not the name", " displayName= First ", "displayName=Second", "empty=  ")),
      )

    assertEquals("First", gatewayDnsTxtValue(records, "displayName"))
    assertNull(gatewayDnsTxtValue(records, "empty"))
    assertNull(gatewayDnsTxtValue(records, "DisplayName"))
  }

  private fun txtRecord(values: List<String>): TXTRecord {
    val wire =
      values.fold(byteArrayOf()) { bytes, value ->
        val text = value.toByteArray(Charsets.UTF_8)
        bytes + byteArrayOf(text.size.toByte()) + text
      }
    return Record.newRecord(Name.fromString("Gateway._openclaw-gw._tcp.example."), Type.TXT, DClass.IN, 60, wire) as TXTRecord
  }
}
