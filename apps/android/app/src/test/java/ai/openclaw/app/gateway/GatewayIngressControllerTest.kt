package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Headers
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class GatewayIngressControllerTest {
  private val application = CloudflareAccessTestTokens.application
  private val endpoint = GatewayEndpoint.manual("gateway.example.test", 8443, true, "/gateway/socket")
  private val tls = GatewayTlsParams(true, null, false, endpoint.stableId)

  private class Storage {
    val values = mutableMapOf<CloudflareAccessOrigin, String>()
    var deleteSucceeds = true
    val deleted = mutableListOf<CloudflareAccessOrigin>()
    val persistence =
      CloudflareAccessSessionStore.Persistence(
        load = { values[it] },
        save = { origin, value ->
          values[origin] = value
          true
        },
        delete = {
          deleted += it
          if (deleteSucceeds) values.remove(it)
          deleteSucceeds
        },
      )
  }

  private fun registry(): GatewayRegistryStore {
    val context = RuntimeEnvironment.getApplication()
    return GatewayRegistryStore(SecurePrefs(context, context.getSharedPreferences("access-test-${UUID.randomUUID()}", Context.MODE_PRIVATE)))
      .also { add(it, endpoint) }
  }

  private fun add(
    registry: GatewayRegistryStore,
    target: GatewayEndpoint,
  ) {
    registry.upsert(GatewayRegistryEntry(target.stableId, GatewayRegistryEntryKind.MANUAL, target.name, target.host, target.port, contextPath = target.contextPath))
  }

  private fun assertSingleAccessOrigin(
    expected: String?,
    registry: GatewayRegistryStore,
  ) {
    assertEquals(
      expected,
      registry.entries.value
        .single()
        .accessOrigin,
    )
  }

  private fun assertAccessOrigin(
    expected: String?,
    registry: GatewayRegistryStore,
    stableId: String,
  ) {
    assertEquals(
      expected,
      registry.entries.value
        .first { it.stableId == stableId }
        .accessOrigin,
    )
  }

  private fun assertAttentionProfile(
    expected: String,
    owner: GatewayIngressController,
  ) {
    assertEquals(
      expected,
      owner.presentation.value.attention
        ?.stableId,
    )
  }

  private fun client(
    descriptor: () -> CloudflareAccessApplication = { application },
    loginRedirect: Boolean = false,
    probe: suspend (Request) -> Boolean = { it.header("Cf-Access-Token") == null },
  ): CloudflareAccessClient =
    CloudflareAccessClient { request, _, _ ->
      val application = descriptor()
      when {
        request.url.host == application.issuer.host -> {
          CloudflareAccessClient.Reply(request.url.toString(), 200, Headers.Builder().build(), CloudflareAccessTestTokens.jwks)
        }

        request.method == "HEAD" -> {
          val metadata =
            CloudflareAccessTestTokens.token(
              JsonObject(
                mapOf(
                  "type" to JsonPrimitive("match"),
                  "hostname" to JsonPrimitive(application.origin.uri.host),
                  "auth_domain" to JsonPrimitive(application.issuer.host),
                  "aud" to JsonPrimitive(application.audience),
                  "iat" to JsonPrimitive(System.currentTimeMillis() / 1000.0),
                ),
              ),
            )
          CloudflareAccessClient.Reply(request.url.toString(), 200, Headers.Builder().add("Cf-Access-Metadata", metadata).build(), byteArrayOf())
        }

        else -> {
          val challenged = probe(request)
          val headers = Headers.Builder()
          if (challenged) {
            if (loginRedirect) {
              headers.add("Location", "https://login.example.test/cdn-cgi/access/login?opaque=ignored")
            } else {
              headers.add("WWW-Authenticate", "Cloudflare-Access resource_metadata=\"${application.origin.uri}/.well-known/cloudflare-access-protected-resource/gateway/socket\"")
            }
          }
          CloudflareAccessClient.Reply(request.url.toString(), if (challenged) 302 else 200, headers.build(), byteArrayOf())
        }
      }
    }

  @Test fun registryPublicationNeverEntersIngressInline() =
    runTest {
      val context = RuntimeEnvironment.getApplication()
      val prefs = SecurePrefs(context, context.getSharedPreferences("access-observer-${UUID.randomUUID()}", Context.MODE_PRIVATE))
      val registry = GatewayRegistryStore(prefs).also { add(it, endpoint) }
      val ownerScope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher(testScheduler))
      val owner = GatewayIngressController(ownerScope, registry, Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler))
      val enteredIngress = CountDownLatch(1)
      val releaseIngress = CountDownLatch(1)
      val written = CountDownLatch(1)
      val failures = ConcurrentLinkedQueue<Throwable>()
      val admission =
        Thread({
          try {
            val failure =
              runCatching {
                runBlocking {
                  owner.prepare(endpoint, tls, owner.admissionCheckpoint()) {
                    enteredIngress.countDown()
                    releaseIngress.await()
                    false
                  }
                }
              }.exceptionOrNull()
            check(failure is CancellationException)
          } catch (error: Throwable) {
            failures += error
          }
        }, "access-ingress-monitor-test").apply { isDaemon = true }
      val writer =
        Thread({
          try {
            check(registry.setAccessOrigin(endpoint.stableId, application.origin))
          } catch (error: Throwable) {
            failures += error
          } finally {
            written.countDown()
          }
        }, "access-registry-publish-test").apply { isDaemon = true }
      try {
        runCurrent() // Subscribe before the Registry setter attempts to resume this observer.
        admission.start()
        assertTrue("Admission did not acquire ingress", enteredIngress.await(5, TimeUnit.SECONDS))
        writer.start()
        // This timeout is a harness watchdog. The event must occur while the ingress gate stays closed.
        assertTrue("Registry publication waited for ingress", written.await(5, TimeUnit.SECONDS))
        assertEquals(1L, releaseIngress.count)
        releaseIngress.countDown()
        admission.join(5000)
        writer.join(5000)
        runCurrent()
        assertTrue(failures.isEmpty())
        assertTrue(
          owner.presentation.value.browserRequired
            .contains(endpoint.stableId),
        )
        assertSingleAccessOrigin(application.origin.uri.toString(), GatewayRegistryStore(prefs))
      } finally {
        // Returning false prevents the held admission from acquiring Registry even on the old failing path.
        releaseIngress.countDown()
        admission.join(5000)
        writer.join(5000)
        ownerScope.cancel()
        runCurrent()
        ownerScope.coroutineContext[Job]?.join()
        assertFalse("Admission worker leaked", admission.isAlive)
        assertFalse("Registry worker leaked", writer.isAlive)
      }
    }

  @Test fun registryObservationKeepsInitialStateAndStopsBeforeQueuedPublication() =
    runTest {
      val registry = registry()
      assertTrue(registry.setAccessOrigin(endpoint.stableId, application.origin))
      val ownerScope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher(testScheduler))
      val owner = GatewayIngressController(ownerScope, registry, Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler))
      val initial = owner.presentation.value
      assertEquals(setOf(endpoint.stableId), initial.browserRequired)
      try {
        runCurrent()
        assertTrue(registry.setAccessOrigin(endpoint.stableId, null))
        ownerScope.cancel()
        runCurrent()
        ownerScope.coroutineContext[Job]?.join()
        assertEquals(initial, owner.presentation.value)
        assertSingleAccessOrigin(null, registry)
      } finally {
        ownerScope.cancel()
        runCurrent()
        ownerScope.coroutineContext[Job]?.join()
      }
    }

  @Test fun ordinaryAndServiceHeaderRoutesNeverPresentBrowser() =
    runTest {
      val registry = registry()
      val owner =
        GatewayIngressController(backgroundScope, registry, Storage().persistence, { mapOf("Cf-Access-Client-Id" to "service-id") }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ ->
          client {
            assertEquals("service-id", it.header("Cf-Access-Client-Id"))
            false
          }
        })
      assertNull(owner.prepare(endpoint, tls, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      assertNull(owner.authorization(endpoint))
      assertNull(owner.presentation.value.attention)
    }

  @Test fun automaticChallengeIsActionableWithoutBrowser() =
    runTest {
      val registry = registry()
      val owner = GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() })
      assertTrue(runCatching { owner.prepare(endpoint, tls, admissionCheckpoint = owner.admissionCheckpoint()) { true } }.exceptionOrNull() is GatewayExternalAuthorizationException)
      assertAttentionProfile(endpoint.stableId, owner)
      assertSingleAccessOrigin(application.origin.uri.toString(), registry)
    }

  @Test fun aNewChallengeClearsPreviousOrdinaryAdmissionBeforeInteractiveLogin() =
    runTest {
      val registry = registry()
      var challenged = false
      val owner = GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client { challenged } })
      assertNull(owner.prepare(endpoint, tls, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      assertFalse(owner.blocksAutomaticReconnect(endpoint.stableId))
      challenged = true
      assertTrue(runCatching { owner.prepare(endpoint, tls, admissionCheckpoint = owner.admissionCheckpoint()) { true } }.exceptionOrNull() is GatewayExternalAuthorizationException)
      assertNotNull(owner.authorization(endpoint))
      assertTrue(owner.blocksAutomaticReconnect(endpoint.stableId))
      assertTrue(endpoint.stableId in owner.presentation.value.browserRequired)
    }

  @Test fun sharedOriginDeparturesLeaveTheLastProfileOwningRetirement() =
    runTest {
      val registry = registry()
      val sibling = endpoint.copy(stableId = "departing-sibling")
      add(registry, sibling)
      registry.setAccessOrigin(endpoint.stableId, application.origin)
      registry.setAccessOrigin(sibling.stableId, application.origin)
      val storage = Storage()
      storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
      val release = CompletableDeferred<Unit>()
      var retirements = 0
      val owner =
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {
          retirements++
          release.await()
        }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client { false } })
      val replacement = endpoint.copy(host = "replacement.example.test")
      val siblingReplacement = sibling.copy(host = "sibling.example.test")
      var second: Deferred<Result<GatewayIngressAuthorization?>>? = null
      val observer =
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
          registry.entries.collect { entries ->
            if (second == null && entries.first { it.stableId == endpoint.stableId }.accessOrigin == null) {
              // Enter B from A's durable registry publication, before A's release returns.
              second = async(start = CoroutineStart.UNDISPATCHED) { runCatching { owner.prepare(siblingReplacement, tls.copy(stableId = sibling.stableId), owner.admissionCheckpoint()) { true } } }
            }
          }
        }
      try {
        val first = async { owner.prepare(replacement, tls, owner.admissionCheckpoint()) { true } }
        runCurrent()
        assertTrue(first.isCompleted)
        assertNull(first.await())
        assertEquals(1, retirements)
        assertFalse(checkNotNull(second).isCompleted)
        assertAccessOrigin(application.origin.uri.toString(), registry, sibling.stableId)
        assertNotNull(storage.values[application.origin])
        release.complete(Unit)
        assertNull(checkNotNull(second).await().getOrThrow())
        assertTrue(registry.entries.value.all { it.accessOrigin == null })
        assertNull(storage.values[application.origin])
        assertEquals(1, retirements)
      } finally {
        observer.cancel()
        release.complete(Unit)
      }
    }

  @Test fun replacedOriginCleanupCannotClearTheCurrentRegistrationsAssociation() =
    runTest {
      for (cancelFirst in listOf(false, true)) {
        val registry = registry()
        registry.setAccessOrigin(endpoint.stableId, application.origin)
        val storage = Storage()
        storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
        val firstDrain = CompletableDeferred<Unit>()
        val secondDrain = CompletableDeferred<Unit>()
        var retirements = 0
        val probes = mutableListOf<String>()
        val owner =
          GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {
            when (++retirements) {
              1 -> firstDrain.await()
              2 -> secondDrain.await()
              else -> error("Unexpected retirement")
            }
          }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ ->
            client {
              probes += target.host
              false
            }
          })
        val firstRoute = endpoint.copy(host = "first.example.test")
        val secondRoute = endpoint.copy(host = "second.example.test")
        val first = async { runCatching { owner.prepare(firstRoute, tls, owner.admissionCheckpoint()) { true } } }
        try {
          runCurrent()
          assertEquals(1, retirements)
          if (cancelFirst) first.cancel()
          val second = async { runCatching { owner.prepare(secondRoute, tls, owner.admissionCheckpoint()) { true } } }
          runCurrent()
          firstDrain.complete(Unit)
          runCurrent()
          assertTrue(runCatching { first.await().getOrThrow() }.exceptionOrNull() is CancellationException)
          assertEquals(2, retirements)
          assertSingleAccessOrigin(application.origin.uri.toString(), registry)
          assertTrue(probes.isEmpty())
          secondDrain.complete(Unit)
          assertNull(second.await().getOrThrow())
          assertSingleAccessOrigin(null, registry)
          assertEquals(listOf(secondRoute.host), probes)
        } finally {
          firstDrain.complete(Unit)
          secondDrain.complete(Unit)
        }
      }
    }

  @Test fun configuredRouteTlsFailurePreservesTrustErrorWithoutAccessSideEffects() =
    runBlocking {
      val (socketFactory, fingerprint) = gatewayTestTls()
      for (host in listOf("127.0.0.1", "0:0:0:0:0:0:0:1")) {
        for (mode in listOf("matching-pin", "wrong-pin", "system-trust")) {
          val server = MockWebServer()
          server.useHttps(socketFactory, false)
          server.enqueue(MockResponse().setResponseCode(200))
          val address = InetAddress.getByName(host)
          server.start(address, 0)
          val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
          try {
            val target = GatewayEndpoint.manual(host, server.port, true, "/gateway/socket")
            val registry = registry()
            add(registry, target)
            val storage = Storage()
            val pin =
              when (mode) {
                "matching-pin" -> fingerprint
                "wrong-pin" -> "0".repeat(64)
                else -> null
              }
            // Leave clientForRoute at its production default: the raw Access probe
            // must use the same selected pin/platform trust as the Gateway transport.
            val owner =
              GatewayIngressController(scope, registry, storage.persistence, { emptyMap() }, {})
            val result =
              runCatching {
                withTimeout(8_000) {
                  owner.prepare(target, GatewayTlsParams(true, pin, false, target.stableId), owner.admissionCheckpoint()) { true }
                }
              }
            if (mode == "matching-pin") {
              assertTrue(result.isSuccess)
              assertNull(result.getOrNull())
              assertEquals(1, server.requestCount)
            } else {
              val failure = result.exceptionOrNull()
              if (failure !is SSLException) throw AssertionError("$mode: expected TLS rejection", failure)
              if (mode == "wrong-pin") {
                assertTrue(generateSequence<Throwable>(failure) { it.cause }.any { it.message == "gateway TLS fingerprint mismatch" })
              }
              assertEquals(0, server.requestCount)
            }
            assertTrue(storage.values.isEmpty())
            assertNull(owner.authorization(target))
            assertNull(owner.presentation.value.attention)
            assertAccessOrigin(null, registry, target.stableId)
          } finally {
            withContext(NonCancellable) {
              scope.cancel()
              scope.coroutineContext[Job]?.join()
              server.shutdown()
            }
          }
        }
      }
    }
}
