package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
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
import org.junit.Assert.assertSame
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
import kotlin.coroutines.CoroutineContext

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

  private class PausingDispatcher(
    private val delegate: CoroutineDispatcher,
  ) : CoroutineDispatcher() {
    var paused = false
    private val pending = mutableListOf<Pair<CoroutineContext, Runnable>>()

    override fun dispatch(
      context: CoroutineContext,
      block: Runnable,
    ) {
      if (paused) pending += context to block else delegate.dispatch(context, block)
    }

    fun resume() {
      paused = false
      pending.toList().also { pending.clear() }.forEach { (context, block) -> delegate.dispatch(context, block) }
    }

    fun resumeImmediately() {
      paused = false
      pending.toList().also { pending.clear() }.forEach { (_, block) -> block.run() }
    }
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

  @Test fun retirementJoinsCredentialedDiscoveryFromPrepareAndUpgrade() =
    runTest {
      for (upgrade in listOf(false, true)) {
        for (retirement in listOf("expiry")) {
          val registry = registry()
          val storage = Storage()
          var now = System.currentTimeMillis() / 1000.0
          storage.values[application.origin] = CloudflareAccessTestTokens.session(expires = now + 60).encode()
          val entered = CompletableDeferred<Unit>()
          val canceled = CompletableDeferred<Unit>()
          val release = CompletableDeferred<Unit>()
          var hold = false
          val owner =
            GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, now = { now }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ ->
              client {
                if (it.header("Cf-Access-Token") == null) return@client true
                if (hold) {
                  entered.complete(Unit)
                  try {
                    awaitCancellation()
                  } finally {
                    withContext(NonCancellable) {
                      canceled.complete(Unit)
                      release.await()
                    }
                  }
                }
                false
              }
            })
          val lease = checkNotNull(owner.prepare(endpoint, tls, owner.admissionCheckpoint()) { true })
          val request = Request.Builder().url("${application.origin.uri}/gateway/socket").build()
          hold = true
          val pending =
            async {
              runCatching {
                if (upgrade) lease.authorizeUpgrade(request) else owner.prepare(endpoint, tls, owner.admissionCheckpoint()) { true }
              }
            }
          var cleanup: Deferred<Unit>? = null
          try {
            runCurrent()
            assertTrue(entered.isCompleted)
            cleanup =
              async {
                now += 61
                owner.revalidate()
              }
            runCurrent()
            assertTrue("$upgrade/$retirement must cancel the owned probe", canceled.isCompleted)
            assertFalse(pending.isCompleted)
            assertNotNull(storage.values[application.origin])
            assertTrue(storage.deleted.isEmpty())
            release.complete(Unit)
            cleanup.await()
            runCurrent()
            assertTrue(pending.await().exceptionOrNull() is CancellationException)
            assertNull(storage.values[application.origin])
            assertEquals(listOf(application.origin), storage.deleted)
            assertTrue(runCatching { lease.requireCurrent(request) }.exceptionOrNull() is GatewayExternalAuthorizationException)
          } finally {
            release.complete(Unit)
            pending.cancelAndJoin()
            cleanup?.cancelAndJoin()
          }
        }
      }
    }

  @Test fun ordinaryDiscoveryDrainCannotRetireOrAdmitOverNewManagedWork() =
    runTest {
      for (reentrant in listOf(false, true)) {
        val registry = registry()
        val storage = Storage()
        storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
        val oldEntered = CompletableDeferred<Unit>()
        val oldCanceled = CompletableDeferred<Unit>()
        val oldRelease = CompletableDeferred<Unit>()
        val currentEntered = CompletableDeferred<Unit>()
        val currentRelease = CompletableDeferred<Unit>()
        val ordinaryDispatcher = PausingDispatcher(StandardTestDispatcher(testScheduler))
        var ordinary = false
        var tokenProbes = 0
        var currentCanceled = false
        val owner =
          GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ ->
            client {
              if (it.header("Cf-Access-Token") == null) return@client !ordinary
              when (++tokenProbes) {
                2 -> {
                  oldEntered.complete(Unit)
                  try {
                    awaitCancellation()
                  } finally {
                    withContext(NonCancellable) {
                      oldCanceled.complete(Unit)
                      oldRelease.await()
                    }
                  }
                }

                3 -> {
                  currentEntered.complete(Unit)
                  try {
                    currentRelease.await()
                  } catch (failure: CancellationException) {
                    currentCanceled = true
                    throw failure
                  }
                }
              }
              false
            }
          })
        owner.prepare(endpoint, tls, owner.admissionCheckpoint()) { true }
        val old = async { runCatching { owner.prepare(endpoint, tls, owner.admissionCheckpoint()) { true } } }
        var current: Deferred<GatewayIngressAuthorization?>? = null
        var pendingOrdinary: Deferred<Result<GatewayIngressAuthorization?>>? = null
        var observer: Job? = null
        var armed = false
        try {
          runCurrent()
          assertTrue(oldEntered.isCompleted)
          if (reentrant) {
            observer =
              launch(UnconfinedTestDispatcher(testScheduler)) {
                owner.presentation.collect { projection ->
                  if (armed && endpoint.stableId !in projection.browserRequired) {
                    armed = false
                    ordinary = false
                    current =
                      async(start = CoroutineStart.UNDISPATCHED) {
                        owner.prepare(endpoint, tls, owner.admissionCheckpoint()) { true }
                      }
                  }
                }
              }
          }
          ordinary = true
          armed = reentrant
          pendingOrdinary = async(ordinaryDispatcher) { runCatching { owner.prepare(endpoint, tls, owner.admissionCheckpoint()) { true } } }
          runCurrent()
          assertTrue(oldCanceled.isCompleted)
          assertFalse(pendingOrdinary.isCompleted)
          if (!reentrant) {
            ordinary = false
            current = async { owner.prepare(endpoint, tls, owner.admissionCheckpoint()) { true } }
            runCurrent()
          }
          assertFalse(currentEntered.isCompleted)
          assertFalse(checkNotNull(current).isCompleted)
          // Registration replacement must drain the retired request first. Pause only
          // the obsolete ordinary continuation while the current owner then advances.
          ordinaryDispatcher.paused = true
          oldRelease.complete(Unit)
          runCurrent()
          assertTrue(currentEntered.isCompleted)
          assertFalse(currentCanceled)
          currentRelease.complete(Unit)
          val lease = checkNotNull(checkNotNull(current).await())
          assertFalse(pendingOrdinary.isCompleted)
          ordinaryDispatcher.resume()
          assertTrue(old.await().exceptionOrNull() is CancellationException)
          assertTrue(pendingOrdinary.await().exceptionOrNull() is CancellationException)
          lease.requireCurrent(Request.Builder().url("${application.origin.uri}/gateway/socket").build())
          assertNotNull(storage.values[application.origin])
          assertTrue(storage.deleted.isEmpty())
        } finally {
          armed = false
          ordinaryDispatcher.resume()
          oldRelease.complete(Unit)
          currentRelease.complete(Unit)
          observer?.cancelAndJoin()
          old.cancelAndJoin()
          pendingOrdinary?.cancelAndJoin()
          current?.cancelAndJoin()
        }
      }
    }

  @Test fun canceledOrdinaryAdmissionCannotReturnAfterDiscoveryDrain() =
    runTest {
      val registry = registry()
      val storage = Storage()
      storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
      val entered = CompletableDeferred<Unit>()
      val canceled = CompletableDeferred<Unit>()
      val release = CompletableDeferred<Unit>()
      var hold = false
      var ordinary = false
      var returnedOrdinary = false
      var callerSettled = false
      val owner =
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ ->
          client {
            if (it.header("Cf-Access-Token") == null) return@client !ordinary
            if (hold) {
              entered.complete(Unit)
              try {
                awaitCancellation()
              } finally {
                withContext(NonCancellable) {
                  canceled.complete(Unit)
                  release.await()
                }
              }
            }
            false
          }
        })
      owner.prepare(endpoint, tls, owner.admissionCheckpoint()) { true }
      hold = true
      val old = async { runCatching { owner.prepare(endpoint, tls, owner.admissionCheckpoint()) { true } } }
      var caller: Job? = null
      try {
        runCurrent()
        assertTrue(entered.isCompleted)
        ordinary = true
        caller =
          launch {
            try {
              owner.prepare(endpoint, tls, owner.admissionCheckpoint()) { true }
              returnedOrdinary = true
            } catch (_: CancellationException) {
              // Observe the caller's own continuation, not Deferred.await's cancellation.
            } finally {
              callerSettled = true
            }
          }
        runCurrent()
        assertTrue(canceled.isCompleted)
        caller.cancel()
        runCurrent()
        assertFalse(callerSettled)
        release.complete(Unit)
        caller.join()
        assertTrue(callerSettled)
        assertFalse(returnedOrdinary)
        assertTrue(old.await().exceptionOrNull() is CancellationException)
        assertNotNull(storage.values[application.origin])
      } finally {
        release.complete(Unit)
        old.cancelAndJoin()
        caller?.cancelAndJoin()
      }
    }

  @Test fun cachedGrantDoesNotEnrollIndependentServiceHeaderAdmission() =
    runTest {
      val registry = registry()
      val storage = Storage()
      storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
      val requests = mutableListOf<Request>()
      val owner =
        GatewayIngressController(backgroundScope, registry, storage.persistence, { mapOf("Cf-Access-Client-Id" to "service-id") }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ ->
          client {
            requests += it
            false
          }
        })
      assertNull(owner.prepare(endpoint, tls, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      assertNull(owner.authorization(endpoint))
      assertEquals(1, requests.size)
      assertNull(requests.single().header("Cf-Access-Token"))
      assertEquals("service-id", requests.single().header("Cf-Access-Client-Id"))
    }

  @Test fun explicitChallengeReusesCachedGrantWithoutBrowser() =
    runTest {
      val registry = registry()
      val storage = Storage()
      storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
      val requests = mutableListOf<Request>()
      val owner =
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ ->
          client {
            requests += it
            it.header("Cf-Access-Token") == null
          }
        })
      assertNotNull(owner.prepare(endpoint, tls, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      assertEquals(2, requests.size)
      assertNull(requests.first().header("Cf-Access-Token"))
      assertNotNull(requests.last().header("Cf-Access-Token"))
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

  @Test fun grantUsedByProbeCannotBecomeOrdinaryAdmissionAfterExpiry() =
    runTest {
      val registry = registry()
      val storage = Storage()
      var now = System.currentTimeMillis() / 1000.0
      storage.values[application.origin] = CloudflareAccessTestTokens.session(expires = now + 1).encode()
      val probe = CompletableDeferred<Unit>()
      val owner =
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, now = { now }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ ->
          client {
            if (it.header("Cf-Access-Token") == null) return@client true
            probe.await()
            false
          }
        })
      val pending = async { runCatching { owner.prepare(endpoint, tls, admissionCheckpoint = owner.admissionCheckpoint()) { true } } }
      runCurrent()
      now += 2
      probe.complete(Unit)
      assertTrue(pending.await().exceptionOrNull() is GatewayExternalAuthorizationException)
      assertNotNull(owner.presentation.value.attention)
    }

  @Test fun pendingProfileReplacementCannotSwallowSharedOriginExpiry() =
    runTest {
      val registry = registry()
      val sibling = endpoint.copy(stableId = "managed-sibling")
      add(registry, sibling)
      val storage = Storage()
      var now = System.currentTimeMillis() / 1000.0
      var retirements = 0
      storage.values[application.origin] = CloudflareAccessTestTokens.session(expires = now + 1).encode()
      val gate = CompletableDeferred<Unit>()
      val owner =
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, { retirements++ }, now = { now }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ ->
          client { request ->
            if (target.contextPath == "/replacement") {
              gate.await()
              false
            } else {
              request.header("Cf-Access-Token") == null
            }
          }
        })
      val old = checkNotNull(owner.prepare(endpoint, tls, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      val surviving = checkNotNull(owner.prepare(sibling, tls.copy(stableId = sibling.stableId), admissionCheckpoint = owner.admissionCheckpoint()) { true })
      val pending = async { owner.prepare(endpoint.copy(contextPath = "/replacement"), tls, admissionCheckpoint = owner.admissionCheckpoint()) { true } }
      val request = Request.Builder().url(application.origin.uri.toString()).build()
      try {
        runCurrent()
        assertTrue(runCatching { old.requireCurrent(request) }.exceptionOrNull() is GatewayExternalAuthorizationException)
        surviving.requireCurrent(request)
        now += 2
        advanceTimeBy(1001)
        runCurrent()
        assertEquals(1, retirements)
        assertTrue(runCatching { surviving.requireCurrent(request) }.exceptionOrNull() is GatewayExternalAuthorizationException)
        assertNull(storage.values[application.origin])
      } finally {
        gate.complete(Unit)
      }
      assertNull(pending.await())
    }

  @Test fun retiredCallerCannotReplaceCurrentProfileRegistration() =
    runTest {
      val registry = registry()
      val storage = Storage()
      storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
      val owner = GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() })
      val lease = checkNotNull(owner.prepare(endpoint, tls, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      val replacement = endpoint.copy(contextPath = "/other")
      assertTrue(runCatching { owner.prepare(replacement, tls, admissionCheckpoint = owner.admissionCheckpoint()) { false } }.exceptionOrNull() is CancellationException)
      lease.requireCurrent(Request.Builder().url(application.origin.uri.toString()).build())
      assertTrue(owner.authorization(endpoint) === lease)
    }

  @Test fun absoluteExpiryRetiresWithoutAnotherSnapshotAndOldHeadersFail() =
    runTest {
      val registry = registry()
      val storage = Storage()
      var now = System.currentTimeMillis() / 1000.0
      var retirements = 0
      storage.values[application.origin] = CloudflareAccessTestTokens.session(expires = now + 1).encode()
      val owner = GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, { retirements++ }, now = { now }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() })
      val lease = checkNotNull(owner.prepare(endpoint, tls, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      val request = Request.Builder().url("https://gateway.example.test:8443/gateway/socket").build()
      lease.requireCurrent(request)
      now += 2
      advanceTimeBy(1001)
      runCurrent()
      assertEquals(1, retirements)
      assertTrue(runCatching { lease.requireCurrent(request) }.exceptionOrNull() is GatewayExternalAuthorizationException)
      assertNull(storage.values[application.origin])
    }

  @Test fun alreadyCancelledJobCannotReplaceOrDowngradeLiveRegistration() =
    runTest {
      val registry = registry()
      val storage = Storage()
      val encoded = CloudflareAccessTestTokens.session().encode()
      storage.values[application.origin] = encoded
      var requests = 0
      var retirements = 0
      val owner =
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, { retirements++ }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ ->
          client {
            requests++
            it.header("Cf-Access-Token") == null
          }
        })
      val lease = checkNotNull(owner.prepare(endpoint, tls, owner.admissionCheckpoint()) { true })
      val requestsBefore = requests
      val entryBefore = registry.entries.value.single()
      var entered = false
      var error: Throwable? = null
      val caller =
        launch {
          coroutineContext[Job]!!.cancel()
          entered = true
          error = runCatching { owner.prepare(endpoint.copy(contextPath = "/replacement"), tls, owner.admissionCheckpoint()) { true } }.exceptionOrNull()
        }
      caller.join()
      assertTrue(entered)
      assertTrue(error is CancellationException)
      lease.requireCurrent(Request.Builder().url(application.origin.uri.toString()).build())
      assertSame(lease, owner.authorization(endpoint))
      assertSame(entryBefore, registry.entries.value.single())
      assertEquals(encoded, storage.values[application.origin])
      assertEquals(requestsBefore, requests)
      assertEquals(0, retirements)
    }

  @Test fun aDifferentPathApplicationCanAcceptTheCachedTokenThroughItsPolicyProbe() =
    runTest {
      val registry = registry()
      val replacement = GatewayEndpoint.manual(endpoint.host, endpoint.port, true, "/linked/socket")
      add(registry, replacement)
      val storage = Storage()
      storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
      val other = application.copy(audience = "linked-audience")
      val probes = mutableListOf<Request>()
      val owner =
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ ->
          client({ other }) { request ->
            probes += request
            request.header("Cf-Access-Token") == null
          }
        })
      val lease = checkNotNull(owner.prepare(replacement, tls.copy(stableId = replacement.stableId), owner.admissionCheckpoint()) { true })
      assertEquals(2, probes.size)
      assertEquals(listOf("/linked/socket", "/linked/socket"), probes.map { it.url.encodedPath })
      assertNull(probes[0].header("Cf-Access-Token"))
      assertNotNull(probes[1].header("Cf-Access-Token"))
      lease.requireCurrent(probes.last())
      assertEquals(application, CloudflareAccessSession.decode(checkNotNull(storage.values[application.origin])).application)
    }

  @Test fun expiryAndForegroundAttentionExcludeOrdinarySameOriginProfiles() =
    runTest {
      for (foreground in listOf(false, true)) {
        for (formerlyManaged in listOf(false, true)) {
          val registry = registry()
          val ordinary = endpoint.copy(stableId = "a-ordinary-sibling")
          add(registry, ordinary)
          val storage = Storage()
          var now = System.currentTimeMillis() / 1000.0
          storage.values[application.origin] = CloudflareAccessTestTokens.session(expires = now + 1).encode()
          var ordinaryReady = false
          val owner = GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, now = { now }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ -> client { !(ordinaryReady && target.stableId == ordinary.stableId) && it.header("Cf-Access-Token") == null } })
          if (formerlyManaged) owner.prepare(ordinary, tls.copy(stableId = ordinary.stableId), owner.admissionCheckpoint()) { true }
          ordinaryReady = true
          assertNull(owner.prepare(ordinary, tls.copy(stableId = ordinary.stableId), owner.admissionCheckpoint()) { true })
          owner.prepare(endpoint, tls, owner.admissionCheckpoint()) { true }
          now += 2
          if (foreground) owner.revalidate() else advanceTimeBy(1001)
          runCurrent()
          assertAttentionProfile(endpoint.stableId, owner)
          assertFalse(owner.blocksAutomaticReconnect(ordinary.stableId))
          assertNull(owner.authorization(ordinary))
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
