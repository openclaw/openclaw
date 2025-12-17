package com.steipete.clawdis.node.bridge

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import java.net.InetSocketAddress
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.xbill.DNS.ExtendedResolver
import org.xbill.DNS.Lookup
import org.xbill.DNS.SimpleResolver
import org.xbill.DNS.AAAARecord
import org.xbill.DNS.ARecord
import org.xbill.DNS.PTRRecord
import org.xbill.DNS.SRVRecord
import org.xbill.DNS.TXTRecord
import org.xbill.DNS.Type

class BridgeDiscovery(
  context: Context,
  private val scope: CoroutineScope,
) {
  private val nsd = context.getSystemService(NsdManager::class.java)
  private val connectivity = context.getSystemService(ConnectivityManager::class.java)
  private val serviceType = "_clawdis-bridge._tcp."
  private val wideAreaDomain = "clawdis.internal."

  private val localById = ConcurrentHashMap<String, BridgeEndpoint>()
  private val unicastById = ConcurrentHashMap<String, BridgeEndpoint>()
  private val _bridges = MutableStateFlow<List<BridgeEndpoint>>(emptyList())
  val bridges: StateFlow<List<BridgeEndpoint>> = _bridges.asStateFlow()

  private var unicastJob: Job? = null

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
    val resolver = createUnicastResolver()
    val ptrName = "${serviceType}${domain}"
    val ptrRecords = lookup(ptrName, Type.PTR, resolver).mapNotNull { it as? PTRRecord }

    val next = LinkedHashMap<String, BridgeEndpoint>()
    for (ptr in ptrRecords) {
      val instanceFqdn = ptr.target.toString()
      val srv =
        lookup(instanceFqdn, Type.SRV, resolver).firstOrNull { it is SRVRecord } as? SRVRecord ?: continue
      val port = srv.port
      if (port <= 0) continue

      val targetFqdn = srv.target.toString()
      val host = resolveHost(targetFqdn, resolver) ?: continue

      val txt = lookup(instanceFqdn, Type.TXT, resolver).mapNotNull { it as? TXTRecord }
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

  private fun lookup(name: String, type: Int, resolver: org.xbill.DNS.Resolver?): List<org.xbill.DNS.Record> {
    return try {
      val lookup = Lookup(name, type)
      if (resolver != null) {
        lookup.setResolver(resolver)
        lookup.setCache(null)
      }
      val out = lookup.run() ?: return emptyList()
      out.toList()
    } catch (_: Throwable) {
      emptyList()
    }
  }

  private fun createUnicastResolver(): org.xbill.DNS.Resolver? {
    val cm = connectivity ?: return null

    // Prefer VPN DNS (Tailscale) when present; fall back to active network DNS.
    val candidateNetworks =
      buildList {
        cm.allNetworks
          .firstOrNull { n ->
            val caps = cm.getNetworkCapabilities(n) ?: return@firstOrNull false
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
          }?.let(::add)
        cm.activeNetwork?.let(::add)
      }.distinct()

    val servers =
      candidateNetworks
        .asSequence()
        .flatMap { n ->
          cm.getLinkProperties(n)?.dnsServers?.asSequence() ?: emptySequence()
        }
        .distinctBy { it.hostAddress ?: it.toString() }
        .toList()
    if (servers.isEmpty()) return null

    return try {
      val resolvers =
        servers.mapNotNull { addr ->
          try {
            SimpleResolver().apply { setAddress(InetSocketAddress(addr, 53)) }
          } catch (_: Throwable) {
            null
          }
        }
      if (resolvers.isEmpty()) return null

      ExtendedResolver(resolvers.toTypedArray()).apply {
        // Vienna -> London via tailnet: allow a bit more headroom than LAN mDNS.
        setTimeout(Duration.ofMillis(3000))
      }
    } catch (_: Throwable) {
      null
    }
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

  private fun resolveHost(hostname: String, resolver: org.xbill.DNS.Resolver?): String? {
    val a =
      lookup(hostname, Type.A, resolver)
        .mapNotNull { it as? ARecord }
        .mapNotNull { it.address?.hostAddress }
    val aaaa =
      lookup(hostname, Type.AAAA, resolver)
        .mapNotNull { it as? AAAARecord }
        .mapNotNull { it.address?.hostAddress }

    return a.firstOrNull() ?: aaaa.firstOrNull()
  }
}
