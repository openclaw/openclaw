package ai.openclaw.app.gateway

import java.net.InetAddress
import java.util.Locale

internal fun isLoopbackGatewayHost(rawHost: String?): Boolean {
  var host =
    rawHost
      ?.trim()
      ?.lowercase(Locale.US)
      ?.trim('[', ']')
      .orEmpty()
  if (host.endsWith(".")) {
    host = host.dropLast(1)
  }
  val zoneIndex = host.indexOf('%')
  if (zoneIndex >= 0) {
    host = host.substring(0, zoneIndex)
  }
  if (host.isEmpty()) return false
  // `0.0.0.0` / `::` are unspecified addresses, but Android client connections to them
  // still resolve only to the local device. Treat them as loopback so local gateways can
  // continue using cleartext development flows.
  if (host == "localhost" || host == "0.0.0.0" || host == "::") return true

  parseIpv4Address(host)?.let { ipv4 ->
    return ipv4.first() == 127.toByte()
  }
  if (!host.contains(':') || !host.all(::isIpv6LiteralChar)) return false

  val address = runCatching { InetAddress.getByName(host) }.getOrNull()?.address ?: return false
  if (address.size != 16) return false
  // `::1` is 15 zero bytes followed by `0x01`.
  val isIpv6Loopback = address.copyOfRange(0, 15).all { it == 0.toByte() } && address[15] == 1.toByte()
  if (isIpv6Loopback) return true

  val isMappedIpv4 =
    address.copyOfRange(0, 10).all { it == 0.toByte() } &&
      address[10] == 0xFF.toByte() &&
      address[11] == 0xFF.toByte()
  return isMappedIpv4 && address[12] == 127.toByte()
}

private fun parseIpv4Address(host: String): ByteArray? {
  val parts = host.split('.')
  if (parts.size != 4) return null
  val bytes = ByteArray(4)
  for ((index, part) in parts.withIndex()) {
    val value = part.toIntOrNull() ?: return null
    if (value !in 0..255) return null
    bytes[index] = value.toByte()
  }
  return bytes
}

private fun isIpv6LiteralChar(char: Char): Boolean = char in '0'..'9' || char in 'a'..'f' || char == ':' || char == '.'
