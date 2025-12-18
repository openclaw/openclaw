package com.steipete.clawdis.node.bridge

import android.content.Context
import android.net.ConnectivityManager
import android.net.DnsResolver
import android.net.NetworkCapabilities
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.CancellationSignal
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import org.xbill.DNS.AAAARecord
import org.xbill.DNS.ARecord
import org.xbill.DNS.DClass
import org.xbill.DNS.Message
import org.xbill.DNS.Name
import org.xbill.DNS.PTRRecord
import org.xbill.DNS.SRVRecord
import org.xbill.DNS.Section
import org.xbill.DNS.TextParseException
import org.xbill.DNS.TXTRecord
import org.xbill.DNS.Type
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class BridgeDiscovery(
  context: Context,
  private val scope: CoroutineScope,
) {
  private val nsd = context.getSystemService(NsdManager::class.java)
  private val connectivity = context.getSystemService(ConnectivityManager::class.java)
  private val dns = DnsResolver.getInstance()
  private val serviceType = "_clawdis-bridge._tcp."
  private val wideAreaDomain = "clawdis.internal."

  private val localById = ConcurrentHashMap<String, BridgeEndpoint>()
  private val unicastById = ConcurrentHashMap<String, BridgeEndpoint>()
  private val _bridges = MutableStateFlow<List<BridgeEndpoint>>(emptyList())
  val bridges: StateFlow<List<BridgeEndpoint>> = _bridges.asStateFlow()

  private var unicastJob: Job? = null
  private val dnsExecutor: Executor = Executors.newCachedThreadPool()

  private val discoveryListener =
    object : NsdManager.DiscoveryListener {
      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
      override fun onDiscoveryStarted(serviceType: String) {}
      override fun onDiscoveryStopped(serviceType: String) {}

      override fun onServiceFound(serviceInfo: NsdServiceInfo) {
        if (serviceInfo.serviceType != [redacted-email]) return
        resolve(serviceInfo)
      }

      override fun onServiceLost(serviceInfo: NsdServiceInfo) {
        val serviceName = BonjourEscapes.decode(serviceInfo.serviceName)
        val id = stableId(serviceName, "local.")
        localById.remove(id)
        publish()
      }
    }

  init {
    startLocalDiscovery()
    startUnicastDiscovery(wideAreaDomain)
  }

  private fun startLocalDiscovery() {
    try {
      nsd.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
    } catch (_: Throwable) {
      // ignore (best-effort)
    }
  }

  private fun stopLocalDiscovery() {
    try {
      nsd.stopServiceDiscovery(discoveryListener)
    } catch (_: Throwable) {
      // ignore (best-effort)
    }
  }

  private fun startUnicastDiscovery(domain: String) {
    unicastJob =
      scope.launch(Dispatchers.IO) {
        while (true) {
          try {
            refreshUnicast(domain)
          } catch (_: Throwable) {
            // ignore (best-effort)
          }
          delay(5000)
        }
      }
  }

  private fun resolve(serviceInfo: NsdServiceInfo) {
    nsd.resolveService(
      serviceInfo,
      object : NsdManager.ResolveListener {
        override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {}

        override fun onServiceResolved(resolved: NsdServiceInfo) {
          val host = resolved.host?.hostAddress ?: return
          val port = resolved.port
          if (port <= 0) return

          val rawServiceName = resolved.serviceName
          val serviceName = BonjourEscapes.decode(rawServiceName)
          val displayName = BonjourEscapes.decode(txt(resolved, "displayName") ?: serviceName)
          val id = stableId(serviceName, "local.")
          localById[id] = BridgeEndpoint(stableId = id, name = displayName, host = host, port = port)
          publish()
        }
      },
    )
  }

  private fun publish() {
    _bridges.value =
      (localById.values + unicastById.values).sortedBy { it.name.lowercase() }
  }

  private fun stableId(serviceName: String, domain: String): String {
    return "${serviceType}|${domain}|${normalizeName(serviceName)}"
  }

  private fun normalizeName(raw: String): String {
    return raw.trim().split(Regex("\\s+")).joinToString(" ")
  }

  private fun txt(info: NsdServiceInfo, key: String): String? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return null
    val bytes = info.attributes[key] ?: return null
    return try {
      String(bytes, Charsets.UTF_8).trim().ifEmpty { null }
    } catch (_: Throwable) {
      null
    }
  }

  private suspend fun refreshUnicast(domain: String) {
    val ptrName = "${serviceType}${domain}"
    val ptrRecords = lookupUnicast(ptrName, Type.PTR).mapNotNull { it as? PTRRecord }

    val next = LinkedHashMap<String, BridgeEndpoint>()
    for (ptr in ptrRecords) {
      val instanceFqdn = ptr.target.toString()
      val srv =
        lookupUnicast(instanceFqdn, Type.SRV).firstOrNull { it is SRVRecord } as? SRVRecord ?: continue
      val port = srv.port
      if (port <= 0) continue

      val targetFqdn = srv.target.toString()
      val host = resolveHostUnicast(targetFqdn) ?: continue

      val txt = lookupUnicast(instanceFqdn, Type.TXT).mapNotNull { it as? TXTRecord }
      val instanceName = BonjourEscapes.decode(decodeInstanceName(instanceFqdn, domain))
      val displayName = BonjourEscapes.decode(txtValue(txt, "displayName") ?: instanceName)
      val id = stableId(instanceName, domain)
      next[id] = BridgeEndpoint(stableId = id, name = displayName, host = host, port = port)
    }

    unicastById.clear()
    unicastById.putAll(next)
    publish()
  }

  private fun decodeInstanceName(instanceFqdn: String, domain: String): String {
    val suffix = "${serviceType}${domain}"
    val withoutSuffix =
      if (instanceFqdn.endsWith(suffix)) {
        instanceFqdn.removeSuffix(suffix)
      } else {
        instanceFqdn.substringBefore(serviceType)
      }
    return normalizeName(stripTrailingDot(withoutSuffix))
  }

  private fun stripTrailingDot(raw: String): String {
    return raw.removeSuffix(".")
  }

  private suspend fun lookupUnicast(name: String, type: Int): List<org.xbill.DNS.Record> {
    val query =
      try {
        Message.newQuery(
          org.xbill.DNS.Record.newRecord(
            Name.fromString(name),
            type,
            DClass.IN,
          ),
        )
      } catch (_: TextParseException) {
        return emptyList()
      }

    val network = preferredDnsNetwork()
    val bytes =
      try {
        rawQuery(network, query.toWire())
      } catch (_: Throwable) {
        return emptyList()
      }

    return try {
      val msg = Message(bytes)
      msg.getSectionArray(Section.ANSWER)?.toList() ?: emptyList()
    } catch (_: IOException) {
      emptyList()
    }
  }

  private fun preferredDnsNetwork(): android.net.Network? {
    val cm = connectivity ?: return null

    // Prefer VPN (Tailscale) when present; otherwise use the active network.
    cm.allNetworks.firstOrNull { n ->
      val caps = cm.getNetworkCapabilities(n) ?: return@firstOrNull false
      caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
    }?.let { return it }

    return cm.activeNetwork
  }

  private suspend fun rawQuery(network: android.net.Network?, wireQuery: ByteArray): ByteArray =
    suspendCancellableCoroutine { cont ->
      val signal = CancellationSignal()
      cont.invokeOnCancellation { signal.cancel() }

      dns.rawQuery(
        network,
        wireQuery,
        0,
        dnsExecutor,
        signal,
        object : DnsResolver.Callback<ByteArray> {
          override fun onAnswer(answer: ByteArray, rcode: Int) {
            cont.resume(answer)
          }

          override fun onError(error: DnsResolver.DnsException) {
            cont.resumeWithException(error)
          }
        },
      )
    }

  private fun txtValue(records: List<TXTRecord>, key: String): String? {
    val prefix = "$key="
    for (r in records) {
      val strings: List<String> =
        try {
          r.strings.mapNotNull { it as? String }
        } catch (_: Throwable) {
          emptyList()
        }
      for (s in strings) {
        val trimmed = s.trim()
        if (trimmed.startsWith(prefix)) {
          return trimmed.removePrefix(prefix).trim().ifEmpty { null }
        }
      }
    }
    return null
  }

  private suspend fun resolveHostUnicast(hostname: String): String? {
    val a =
      lookupUnicast(hostname, Type.A)
        .mapNotNull { it as? ARecord }
        .mapNotNull { it.address?.hostAddress }
    val aaaa =
      lookupUnicast(hostname, Type.AAAA)
        .mapNotNull { it as? AAAARecord }
        .mapNotNull { it.address?.hostAddress }

    return a.firstOrNull() ?: aaaa.firstOrNull()
  }
}
