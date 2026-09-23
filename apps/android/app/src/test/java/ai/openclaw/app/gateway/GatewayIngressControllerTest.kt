package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineExceptionHandler
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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Headers
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
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
import java.lang.management.ManagementFactory
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException
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

  private class OwnedTestScope(
    dispatcher: CoroutineDispatcher,
  ) : CoroutineScope {
    private val job = SupervisorJob()
    private val uncaught = mutableListOf<Throwable>()
    override val coroutineContext = job + dispatcher + CoroutineExceptionHandler { _, error -> uncaught += error }

    suspend fun close(
      callers: () -> Sequence<Job> = { emptySequence() },
      release: () -> Unit = {},
    ) = withContext(NonCancellable) {
      release()
      // Cancel every caller and the owner before joining; a held peer may own their cleanup.
      callers().forEach { it.cancel() }
      job.cancel()
      callers().forEach { it.join() }
      job.join()
      assertTrue(uncaught.isEmpty())
    }
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

  private fun assertTlsFailure(
    expected: SSLHandshakeException,
    actual: Throwable?,
  ) {
    assertTrue(actual is SSLHandshakeException)
    assertEquals(expected.message, actual?.message)
    // Coroutine stacktrace recovery may copy the failure while retaining its cause.
    assertTrue(generateSequence(actual) { it.cause }.any { it === expected })
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

  private fun sessionFor(application: CloudflareAccessApplication): CloudflareAccessSession {
    val expires = System.currentTimeMillis() / 1000.0 + 3600
    val claims =
      JsonObject(
        CloudflareAccessTestTokens.claims("replacement", expires) +
          mapOf(
            "iss" to JsonPrimitive(application.issuer.toString()),
            "aud" to JsonArray(listOf(JsonPrimitive(application.audience))),
          ),
      )
    return CloudflareAccessSession(application, "replacement", expires, CloudflareAccessTestTokens.token(claims))
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
                  owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) {
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
      var prompts = 0
      val owner =
        GatewayIngressController(backgroundScope, registry, Storage().persistence, { mapOf("Cf-Access-Client-Id" to "service-id") }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ ->
          client {
            assertEquals("service-id", it.header("Cf-Access-Client-Id"))
            false
          }
        }, authenticate = { _, _ ->
          prompts++
          error("Unexpected browser")
        })
      assertNull(owner.prepare(endpoint, tls, true, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      assertNull(owner.authorization(endpoint))
      assertEquals(0, prompts)
      assertNull(owner.presentation.value.attention)
    }

  @Test fun automaticChallengeIsActionableWithoutBrowser() =
    runTest {
      val registry = registry()
      val owner = GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() })
      assertTrue(runCatching { owner.prepare(endpoint, tls, false, admissionCheckpoint = owner.admissionCheckpoint()) { true } }.exceptionOrNull() is GatewayExternalAuthorizationException)
      assertAttentionProfile(endpoint.stableId, owner)
      assertNull(owner.presentation.value.browserLaunch)
      assertSingleAccessOrigin(application.origin.uri.toString(), registry)
    }

  @Test fun aNewChallengeClearsPreviousOrdinaryAdmissionBeforeInteractiveLogin() =
    runTest {
      val registry = registry()
      var challenged = false
      val owner = GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client { challenged } })
      assertNull(owner.prepare(endpoint, tls, false, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      assertFalse(owner.blocksAutomaticReconnect(endpoint.stableId))
      challenged = true
      assertTrue(runCatching { owner.prepare(endpoint, tls, false, admissionCheckpoint = owner.admissionCheckpoint()) { true } }.exceptionOrNull() is GatewayExternalAuthorizationException)
      assertNotNull(owner.authorization(endpoint))
      assertTrue(owner.blocksAutomaticReconnect(endpoint.stableId))
      assertTrue(endpoint.stableId in owner.presentation.value.browserRequired)
      assertNull(owner.presentation.value.browserLaunch)
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
          var prompts = 0
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
            }, authenticate = { _, _ ->
              prompts++
              error("Retired discovery must not launch authentication")
            })
          val lease = checkNotNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
          val request = Request.Builder().url("${application.origin.uri}/gateway/socket").build()
          hold = true
          val pending =
            async {
              runCatching {
                if (upgrade) lease.authorizeUpgrade(request) else owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true }
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
            assertNull(owner.presentation.value.browserLaunch)
            assertEquals(0, prompts)
          } finally {
            release.complete(Unit)
            pending.cancelAndJoin()
            cleanup?.cancelAndJoin()
          }
        }
      }
    }

  @Test fun supersededRegistrationDrainPreservesCurrentDiscovery() =
    runTest {
      val registry = registry()
      val storage = Storage()
      val grant = CompletableDeferred<CloudflareAccessSession>()
      val firstDispatcher = PausingDispatcher(StandardTestDispatcher(testScheduler))
      val middleDispatcher = PausingDispatcher(StandardTestDispatcher(testScheduler))
      val currentEntered = CompletableDeferred<Unit>()
      val currentRelease = CompletableDeferred<Unit>()
      var currentCanceled = false
      val middleRoute = endpoint.copy(contextPath = "/middle")
      val currentRoute = endpoint.copy(contextPath = "/current")
      val owner =
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ ->
          client {
            if (it.header("Cf-Access-Token") == null) return@client true
            if (target.contextPath == currentRoute.contextPath) {
              currentEntered.complete(Unit)
              try {
                currentRelease.await()
              } catch (failure: CancellationException) {
                currentCanceled = true
                throw failure
              }
            }
            false
          }
        }, authenticate = { _, open ->
          open("https://example.cloudflareaccess.com/login")
          grant.await()
        })
      val first = async(firstDispatcher) { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } } }
      var middle: Deferred<Result<GatewayIngressAuthorization?>>? = null
      var current: Deferred<GatewayIngressAuthorization?>? = null
      try {
        runCurrent()
        assertNotNull(owner.presentation.value.browserLaunch)
        firstDispatcher.paused = true
        grant.complete(CloudflareAccessTestTokens.session())
        runCurrent()
        assertNotNull(storage.values[application.origin])
        assertFalse(first.isCompleted)
        middle =
          async(middleDispatcher, start = CoroutineStart.UNDISPATCHED) {
            runCatching { owner.prepare(middleRoute, tls, false, owner.admissionCheckpoint()) { true } }
          }
        middleDispatcher.paused = true
        runCurrent()
        assertFalse(middle.isCompleted)
        current = async { owner.prepare(currentRoute, tls, false, owner.admissionCheckpoint()) { true } }
        runCurrent()
        assertTrue(currentEntered.isCompleted)
        middleDispatcher.resume()
        runCurrent()
        assertTrue(middle.await().exceptionOrNull() is CancellationException)
        assertFalse(currentCanceled)
        assertFalse(current.isCompleted)
        currentRelease.complete(Unit)
        val lease = checkNotNull(current.await())
        lease.requireCurrent(Request.Builder().url("${application.origin.uri}/current").build())
        firstDispatcher.resume()
        assertTrue(first.await().exceptionOrNull() is CancellationException)
        assertNotNull(storage.values[application.origin])
      } finally {
        firstDispatcher.resume()
        middleDispatcher.resume()
        currentRelease.complete(Unit)
        grant.cancel()
        first.cancelAndJoin()
        middle?.cancelAndJoin()
        current?.cancelAndJoin()
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
        owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true }
        val old = async { runCatching { owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true } } }
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
                        owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true }
                      }
                  }
                }
              }
          }
          ordinary = true
          armed = reentrant
          pendingOrdinary = async(ordinaryDispatcher) { runCatching { owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true } } }
          runCurrent()
          assertTrue(oldCanceled.isCompleted)
          assertFalse(pendingOrdinary.isCompleted)
          if (!reentrant) {
            ordinary = false
            current = async { owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true } }
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
      owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true }
      hold = true
      val old = async { runCatching { owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true } } }
      var caller: Job? = null
      try {
        runCurrent()
        assertTrue(entered.isCompleted)
        ordinary = true
        caller =
          launch {
            try {
              owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true }
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
      assertNull(owner.prepare(endpoint, tls, false, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      assertNull(owner.authorization(endpoint))
      assertEquals(1, requests.size)
      assertNull(requests.single().header("Cf-Access-Token"))
      assertEquals("service-id", requests.single().header("Cf-Access-Client-Id"))
      assertNull(owner.presentation.value.browserLaunch)
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
      assertNotNull(owner.prepare(endpoint, tls, false, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      assertEquals(2, requests.size)
      assertNull(requests.first().header("Cf-Access-Token"))
      assertNotNull(requests.last().header("Cf-Access-Token"))
      assertNull(owner.presentation.value.browserLaunch)
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
              second = async(start = CoroutineStart.UNDISPATCHED) { runCatching { owner.prepare(siblingReplacement, tls.copy(stableId = sibling.stableId), false, owner.admissionCheckpoint()) { true } } }
            }
          }
        }
      try {
        val first = async { owner.prepare(replacement, tls, false, owner.admissionCheckpoint()) { true } }
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
        val first = async { runCatching { owner.prepare(firstRoute, tls, false, owner.admissionCheckpoint()) { true } } }
        try {
          runCurrent()
          assertEquals(1, retirements)
          if (cancelFirst) first.cancel()
          val second = async { runCatching { owner.prepare(secondRoute, tls, false, owner.admissionCheckpoint()) { true } } }
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

  @Test fun lastOwnerRetirementReservesBeforeReplacementOrSiblingCanAcquireTheGrant() =
    runTest {
      for (sibling in listOf(false, true)) {
        val registry = registry()
        registry.setAccessOrigin(endpoint.stableId, application.origin)
        val incoming = if (sibling) endpoint.copy(stableId = "incoming-origin-sibling") else endpoint
        if (sibling) add(registry, incoming)
        val departing = endpoint.copy(host = "departing.example.test")
        val storage = Storage()
        storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
        val gateOrigin = CloudflareAccessOrigin.from("https://monitor.example.test")
        val release = CompletableDeferred<Unit>()
        val uncaught = ConcurrentLinkedQueue<Throwable>()
        val scope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher(testScheduler) + CoroutineExceptionHandler { _, error -> uncaught += error })
        val retirements =
          java.util.concurrent.atomic
            .AtomicInteger()
        val departed = CompletableDeferred<Result<GatewayIngressAuthorization?>>()
        val attempted = CompletableDeferred<Result<GatewayIngressAuthorization?>>()
        lateinit var owner: GatewayIngressController
        var checkpoint = 0L
        var gateFailure: Throwable? = null
        lateinit var ingressMonitor: Any
        lateinit var storeMonitor: Any
        val threads = ManagementFactory.getThreadMXBean()

        fun awaitMonitor(
          worker: Thread,
          monitor: Any,
          ownerId: Long,
          declaringClass: Class<*>,
          method: String,
          deadline: Long,
        ) {
          while (true) {
            val info = threads.getThreadInfo(worker.threadId(), 32)
            check(info != null && info.threadState != Thread.State.TERMINATED && System.nanoTime() < deadline) {
              "${worker.name} did not reach $method: state=${info?.threadState}, lock=${info?.lockInfo}, owner=${info?.lockOwnerId}, stack=${info?.stackTrace?.take(4)}"
            }
            if (info.threadState == Thread.State.BLOCKED &&
              info.lockInfo?.className == monitor.javaClass.name &&
              info.lockInfo?.identityHashCode == System.identityHashCode(monitor) &&
              info.lockOwnerId == ownerId &&
              info.stackTrace.any { it.className == declaringClass.name && it.methodName == method }
            ) {
              return
            }
            Thread.sleep(1)
          }
        }

        fun worker(
          name: String,
          target: GatewayEndpoint,
          result: CompletableDeferred<Result<GatewayIngressAuthorization?>>,
        ) = Thread({
          result.complete(
            runCatching {
              kotlinx.coroutines.runBlocking {
                owner.prepare(target, tls.copy(stableId = target.stableId), true, checkpoint) { true }
              }
            },
          )
        }, name).apply { isDaemon = true }
        val departingWorker = worker("access-departing-test", departing, departed)
        val incomingWorker = worker("access-incoming-test", incoming, attempted)
        val persistence =
          CloudflareAccessSessionStore.Persistence(
            load = { origin ->
              if (origin == gateOrigin) {
                try {
                  departingWorker.start()
                  val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                  // One snapshot must identify the actual monitor and owner; unrelated
                  // VM/class-loading contention is not evidence of crossing this boundary.
                  awaitMonitor(departingWorker, storeMonitor, Thread.currentThread().threadId(), CloudflareAccessSessionStore::class.java, "reserveForget", deadline)
                  incomingWorker.start()
                  awaitMonitor(incomingWorker, ingressMonitor, departingWorker.threadId(), GatewayIngressController::class.java, "register", deadline)
                } catch (error: Throwable) {
                  gateFailure = error
                }
              }
              storage.values[origin]
            },
            save = storage.persistence.save,
            delete = storage.persistence.delete,
          )
        owner =
          GatewayIngressController(scope, registry, persistence, { emptyMap() }, {
            if (retirements.incrementAndGet() == 1) release.await()
          }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ -> client { target.host != departing.host && it.header("Cf-Access-Token") == null } }, authenticate = { _, _ -> CloudflareAccessTestTokens.session("fresh") })
        checkpoint = owner.admissionCheckpoint()
        try {
          val store =
            GatewayIngressController::class.java
              .getDeclaredField("store")
              .apply { isAccessible = true }
              .get(owner) as CloudflareAccessSessionStore
          ingressMonitor =
            checkNotNull(
              GatewayIngressController::class.java
                .getDeclaredField("lock")
                .apply { isAccessible = true }
                .get(owner),
            )
          storeMonitor =
            checkNotNull(
              CloudflareAccessSessionStore::class.java
                .getDeclaredField("lock")
                .apply { isAccessible = true }
                .get(store),
            )
          // Hold the actual store monitor before O is revoked. Its reserving caller
          // must retain ingress ownership, so another profile cannot pass registration.
          store.snapshot(gateOrigin)
          gateFailure?.let { throw it }
          incomingWorker.join(5000)
          assertFalse(incomingWorker.isAlive)
          assertTrue(attempted.await().exceptionOrNull() is CancellationException)
          val fresh = async { owner.prepare(incoming, tls.copy(stableId = incoming.stableId), true, owner.admissionCheckpoint()) { true } }
          runCurrent()
          assertFalse(fresh.isCompleted)
          release.complete(Unit)
          val authorization = checkNotNull(fresh.await())
          departingWorker.join(5000)
          assertFalse(departingWorker.isAlive)
          if (sibling) assertNull(departed.await().getOrThrow()) else assertTrue(departed.await().exceptionOrNull() is CancellationException)
          authorization.requireCurrent(Request.Builder().url(application.origin.uri.toString()).build())
          assertEquals("fresh", CloudflareAccessSession.decode(checkNotNull(storage.values[application.origin])).subject)
          assertAccessOrigin(application.origin.uri.toString(), registry, incoming.stableId)
        } finally {
          release.complete(Unit)
          departingWorker.join(5000)
          incomingWorker.join(5000)
          scope.cancel()
          runCurrent()
          assertFalse(departingWorker.isAlive)
          assertFalse(incomingWorker.isAlive)
          assertTrue(uncaught.isEmpty())
        }
      }
    }

  @Test fun canceledTransferCannotPersistAfterLateApprovalOrCancelReplacement() =
    runTest {
      val registry = registry()
      val storage = Storage()
      val grant = CompletableDeferred<CloudflareAccessSession>()
      var calls = 0
      val owner =
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
          calls++
          open("https://example.cloudflareaccess.com/login")
          if (calls == 1) withContext(NonCancellable) { grant.await() } else CloudflareAccessTestTokens.session("replacement")
        })
      val first = async { runCatching { owner.prepare(endpoint, tls, true, admissionCheckpoint = owner.admissionCheckpoint()) { true } } }
      runCurrent()
      val oldId = checkNotNull(owner.presentation.value.browserLaunch).attemptId
      owner.cancel(oldId)
      val second = async { owner.prepare(endpoint, tls, true, admissionCheckpoint = owner.admissionCheckpoint()) { true } }
      runCurrent()
      owner.cancel(oldId)
      assertNotNull(second.await())
      grant.complete(CloudflareAccessTestTokens.session("old"))
      assertTrue(first.await().exceptionOrNull() is CancellationException)
      assertEquals("replacement", CloudflareAccessSession.decode(checkNotNull(storage.values[application.origin])).subject)
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
      val pending = async { runCatching { owner.prepare(endpoint, tls, true, admissionCheckpoint = owner.admissionCheckpoint()) { true } } }
      runCurrent()
      now += 2
      probe.complete(Unit)
      assertTrue(pending.await().exceptionOrNull() is GatewayExternalAuthorizationException)
      assertNotNull(owner.presentation.value.attention)
      assertNull(owner.presentation.value.browserLaunch)
    }

  @Test fun cancelAfterStoreCommitBeforeWaiterAdmissionPreventsHandoff() =
    runTest {
      val registry = registry()
      val storage = Storage()
      val grant = CompletableDeferred<CloudflareAccessSession>()
      val waiter = PausingDispatcher(StandardTestDispatcher(testScheduler))
      val owner =
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
          open("https://example.cloudflareaccess.com/login")
          grant.await()
        })
      val pending = async(waiter) { runCatching { owner.prepare(endpoint, tls, true, admissionCheckpoint = owner.admissionCheckpoint()) { true } } }
      runCurrent()
      val id = checkNotNull(owner.presentation.value.browserLaunch).attemptId
      waiter.paused = true
      try {
        grant.complete(CloudflareAccessTestTokens.session())
        runCurrent()
        assertNotNull(storage.values[application.origin])
        assertFalse(pending.isCompleted)
        owner.cancel(id)
        assertNull(owner.consumeBrowserLaunch(id))
      } finally {
        waiter.resume()
      }
      runCurrent()
      assertTrue(pending.await().exceptionOrNull() is CancellationException)
      assertNotNull(owner.presentation.value.attention)
      // Canceling this consumer does not revoke a committed grant shared with another profile.
      assertNotNull(storage.values[application.origin])
    }

  @Test fun pendingCancelRetiresQueuedLaunchSynchronously() =
    runTest {
      val registry = registry()
      val grant = CompletableDeferred<CloudflareAccessSession>()
      val owner =
        GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
          open("https://example.cloudflareaccess.com/login")
          grant.await()
        })
      val pending = async { runCatching { owner.prepare(endpoint, tls, true, admissionCheckpoint = owner.admissionCheckpoint()) { true } } }
      runCurrent()
      val id = checkNotNull(owner.presentation.value.browserLaunch).attemptId
      owner.cancelPending(endpoint.stableId)
      assertNull(owner.consumeBrowserLaunch(id))
      runCurrent()
      assertTrue(pending.await().exceptionOrNull() is CancellationException)
    }

  @Test fun replacingBrowserOwnerPublishesOnlyTheNewIntent() =
    runTest {
      val registry = registry()
      var authentications = 0
      val owner =
        GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
          authentications++
          open("https://example.cloudflareaccess.com/login")
          CompletableDeferred<CloudflareAccessSession>().await()
        })
      val first = async { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } } }
      runCurrent()
      val old = checkNotNull(owner.presentation.value.browserLaunch)
      val second = async { runCatching { owner.prepare(endpoint.copy(name = "Replacement browser owner"), tls, true, owner.admissionCheckpoint()) { true } } }
      runCurrent()
      assertTrue(first.await().exceptionOrNull() is CancellationException)
      assertEquals(2, authentications)
      val current = checkNotNull(owner.presentation.value.browserLaunch)
      assertFalse(old.attemptId == current.attemptId)
      assertEquals(
        current.attemptId,
        owner.presentation.value.attention
          ?.attemptId,
      )
      assertNull(owner.consumeBrowserLaunch(old.attemptId))
      assertEquals(current.url, owner.consumeBrowserLaunch(current.attemptId))
      owner.cancel(current.attemptId)
      runCurrent()
      assertTrue(second.await().exceptionOrNull() is CancellationException)
      assertNull(owner.presentation.value.browserLaunch)
    }

  @Test fun consumingLaunchRechecksOwnerAfterInlineCancellation() =
    runTest {
      val owner =
        GatewayIngressController(backgroundScope, registry(), Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
          open("https://example.cloudflareaccess.com/login")
          CompletableDeferred<CloudflareAccessSession>().await()
        })
      val pending = async { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } } }
      runCurrent()
      val id = checkNotNull(owner.presentation.value.browserLaunch).attemptId
      var canceled = false
      backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
        owner.presentation.collect { state ->
          if (!canceled && state.browserLaunch == null && state.attention?.attemptId == id) {
            canceled = true
            owner.cancel(id)
          }
        }
      }
      assertNull(owner.consumeBrowserLaunch(id))
      assertTrue(canceled)
      runCurrent()
      assertTrue(pending.await().exceptionOrNull() is CancellationException)
      assertNull(owner.presentation.value.browserLaunch)
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
      val old = checkNotNull(owner.prepare(endpoint, tls, false, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      val surviving = checkNotNull(owner.prepare(sibling, tls.copy(stableId = sibling.stableId), false, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      val pending = async { owner.prepare(endpoint.copy(contextPath = "/replacement"), tls, false, admissionCheckpoint = owner.admissionCheckpoint()) { true } }
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
      val lease = checkNotNull(owner.prepare(endpoint, tls, false, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      val replacement = endpoint.copy(contextPath = "/other")
      assertTrue(runCatching { owner.prepare(replacement, tls, true, admissionCheckpoint = owner.admissionCheckpoint()) { false } }.exceptionOrNull() is CancellationException)
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
      val lease = checkNotNull(owner.prepare(endpoint, tls, false, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      val request = Request.Builder().url("https://gateway.example.test:8443/gateway/socket").build()
      lease.requireCurrent(request)
      now += 2
      advanceTimeBy(1001)
      runCurrent()
      assertEquals(1, retirements)
      assertTrue(runCatching { lease.requireCurrent(request) }.exceptionOrNull() is GatewayExternalAuthorizationException)
      assertNull(storage.values[application.origin])
    }

  @Test fun sameOriginProfileCannotReplaceSuspendedRegistration() =
    runTest {
      val registry = registry()
      val sibling = endpoint.copy(stableId = "other-profile", contextPath = "/mcp")
      add(registry, sibling)
      val grant = CompletableDeferred<CloudflareAccessSession>()
      val owner =
        GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
          open("https://example.cloudflareaccess.com/login")
          grant.await()
        })
      val first = async { owner.prepare(endpoint, tls, true, admissionCheckpoint = owner.admissionCheckpoint()) { true } }
      runCurrent()
      assertTrue(runCatching { owner.prepare(sibling, tls.copy(stableId = sibling.stableId), false, admissionCheckpoint = owner.admissionCheckpoint()) { true } }.isFailure)
      grant.complete(CloudflareAccessTestTokens.session())
      assertNotNull(first.await())
      assertNotNull(owner.authorization(endpoint))
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
      val lease = checkNotNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
      val requestsBefore = requests
      val entryBefore = registry.entries.value.single()
      var entered = false
      var error: Throwable? = null
      val caller =
        launch {
          coroutineContext[Job]!!.cancel()
          entered = true
          error = runCatching { owner.prepare(endpoint.copy(contextPath = "/replacement"), tls, true, owner.admissionCheckpoint()) { true } }.exceptionOrNull()
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

  @Test fun ordinaryProbeCannotOverwriteAnInterveningManagedPhaseOrGrant() =
    runTest {
      for (state in listOf("initial", "ordinary", "renewed", "same-grant")) {
        val registry = registry()
        val storage = Storage()
        if (state == "renewed" || state == "same-grant") storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val grant = CompletableDeferred<CloudflareAccessSession>()
        var ordinary = state == "ordinary"
        var holdNextProbe = false
        var rejectCached = false
        var prompts = 0
        val owner =
          GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ ->
            client { request ->
              if (request.header("Cf-Access-Token") == null) {
                if (holdNextProbe) {
                  holdNextProbe = false
                  entered.complete(Unit)
                  release.await()
                  false
                } else {
                  !ordinary
                }
              } else {
                rejectCached
              }
            }
          }, authenticate = { _, open ->
            prompts++
            open("https://example.cloudflareaccess.com/login")
            grant.await()
          })
        if (state != "initial") {
          val initial = owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true }
          assertEquals(state != "ordinary", initial != null)
        }
        holdNextProbe = true
        val old = async { runCatching { owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true } } }
        var managed: Deferred<GatewayIngressAuthorization?>? = null
        try {
          entered.await()
          ordinary = false
          rejectCached = state == "renewed"
          val current = async { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } }
          managed = current
          runCurrent()
          val browser = owner.presentation.value.browserLaunch
          val attention = owner.presentation.value.attention
          assertEquals(state != "same-grant", browser != null)
          val request = Request.Builder().url(application.origin.uri.toString()).build()
          var admitted: GatewayIngressAuthorization? = null
          if (state == "renewed") {
            val launch = checkNotNull(browser)
            assertEquals(launch.url, owner.consumeBrowserLaunch(launch.attemptId))
            grant.complete(CloudflareAccessTestTokens.session("renewed-before-ordinary"))
            admitted = checkNotNull(current.await())
            admitted.requireCurrent(request)
          } else if (state == "same-grant") {
            admitted = checkNotNull(current.await())
          }
          release.complete(Unit)
          if (state == "same-grant") {
            assertNull(old.await().getOrThrow())
            assertNull(owner.authorization(endpoint))
            assertTrue(runCatching { checkNotNull(admitted).requireCurrent(request) }.isFailure)
            assertEquals(0, prompts)
          } else {
            assertTrue(old.await().exceptionOrNull() is CancellationException)
            if (state != "renewed") {
              assertEquals(browser, owner.presentation.value.browserLaunch)
              assertEquals(attention, owner.presentation.value.attention)
              val launch = checkNotNull(browser)
              assertEquals(launch.url, owner.consumeBrowserLaunch(launch.attemptId))
              grant.complete(CloudflareAccessTestTokens.session("managed-before-ordinary"))
              admitted = checkNotNull(current.await())
            }
            checkNotNull(admitted).requireCurrent(request)
            assertSame(admitted, owner.authorization(endpoint))
            assertEquals(1, prompts)
          }
          assertNotNull(storage.values[application.origin])
          assertNull(owner.presentation.value.browserLaunch)
          assertNull(owner.presentation.value.attention)
        } finally {
          release.complete(Unit)
          grant.cancel()
          old.cancelAndJoin()
          managed?.cancelAndJoin()
        }
      }
    }

  @Test fun ordinaryAdmissionRetiresOnlyItsBrowserParticipantBeforeOrAfterPublication() =
    runTest {
      for (delayed in listOf(false, true)) {
        val registry = registry()
        val storage = Storage()
        val publish = CompletableDeferred<Unit>()
        val grant = CompletableDeferred<CloudflareAccessSession>()
        var ordinary = false
        var prompts = 0
        var authentication: Job? = null
        val owner =
          GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ ->
            client { request -> !(ordinary && target.stableId == endpoint.stableId) && request.header("Cf-Access-Token") == null }
          }, authenticate = { _, open ->
            authentication = kotlin.coroutines.coroutineContext[Job]
            prompts++
            if (delayed) publish.await()
            open("https://example.cloudflareaccess.com/login")
            grant.await()
          })
        val first = async { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } } }
        try {
          runCurrent()
          val queued = owner.presentation.value.browserLaunch
          assertEquals(!delayed, queued != null)
          ordinary = true
          assertNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
          // Repeated ordinary preparation keeps its current owner and cannot revive the old waiter.
          assertNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
          assertTrue(checkNotNull(authentication).isActive)
          assertNull(owner.authorization(endpoint))
          assertFalse(endpoint.stableId in owner.presentation.value.browserRequired)
          assertNull(owner.presentation.value.browserLaunch)
          assertNull(owner.presentation.value.attention)
          if (queued != null) assertNull(owner.consumeBrowserLaunch(queued.attemptId))
          publish.complete(Unit)
          runCurrent()
          assertNull(owner.presentation.value.browserLaunch)
          assertNull(owner.presentation.value.attention)
          grant.complete(CloudflareAccessTestTokens.session("ordinary-peer"))
          assertTrue(first.await().exceptionOrNull() is CancellationException)
          assertEquals(1, prompts)
          assertNull(owner.authorization(endpoint))
          assertFalse(endpoint.stableId in owner.presentation.value.browserRequired)
          assertNull(owner.presentation.value.browserLaunch)
          assertNull(owner.presentation.value.attention)
        } finally {
          publish.complete(Unit)
          grant.cancel()
          first.cancelAndJoin()
        }
      }
    }

  @Test fun explicitDepartureRetiresAnOrdinarySuccessorsObsoleteBrowserGeneration() =
    runTest {
      val registry = registry()
      val replacement = endpoint.copy(contextPath = "/changed/socket")
      val probeEntered = CompletableDeferred<Unit>()
      val probeRelease = CompletableDeferred<Unit>()
      val storage = Storage()
      val grant = CompletableDeferred<CloudflareAccessSession>()
      val pending = mutableListOf<Job>()
      val ownerScope = OwnedTestScope(StandardTestDispatcher(testScheduler))
      var ordinary = false
      var authentication: Job? = null
      var prompts = 0
      try {
        val owner =
          GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ ->
            client { request ->
              if (target == replacement) {
                probeEntered.complete(Unit)
                probeRelease.await()
                true
              } else {
                !(target.stableId == endpoint.stableId && ordinary) && request.header("Cf-Access-Token") == null
              }
            }
          }, authenticate = { _, open ->
            prompts++
            authentication = kotlin.coroutines.coroutineContext[Job]
            open("https://example.cloudflareaccess.com/login")
            grant.await()
          })
        val old = async { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } } }.also(pending::add)
        runCurrent()
        val launch = checkNotNull(owner.presentation.value.browserLaunch)
        ordinary = true
        assertNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
        assertFalse(checkNotNull(authentication).isCancelled)
        assertFalse(old.isCompleted)
        assertNull(owner.presentation.value.browserLaunch)
        assertNull(owner.presentation.value.attention)
        assertNull(owner.consumeBrowserLaunch(launch.attemptId))
        val automatic =
          async { runCatching { owner.prepare(replacement, tls, false, owner.admissionCheckpoint()) { true } } }.also(pending::add).also {
            runCurrent()
            assertTrue(probeEntered.isCompleted)
            assertFalse(it.isCompleted)
          }
        assertTrue(checkNotNull(authentication).isCancelled)
        assertTrue(old.await().exceptionOrNull() is CancellationException)
        assertNull(storage.values[application.origin])
        probeRelease.complete(Unit)
        val result = automatic.await()
        assertTrue(result.exceptionOrNull() is GatewayExternalAuthorizationException)
        assertEquals(endpoint.stableId, checkNotNull(owner.presentation.value.attention).stableId)
        assertTrue(checkNotNull(owner.presentation.value.attention).message.startsWith("Sign in to Cloudflare Access"))
        assertNull(owner.presentation.value.browserLaunch)
        assertEquals(1, prompts)
      } finally {
        ownerScope.close({ pending.asSequence() }) {
          grant.cancel()
          probeRelease.complete(Unit)
        }
      }
    }

  @Test fun detachedCompletedGrantDoesNotBlockCachedAutomaticReconnect() =
    runTest {
      val registry = registry()
      val storage = Storage()
      val grant = CompletableDeferred<CloudflareAccessSession>()
      val ownerScope = OwnedTestScope(StandardTestDispatcher(testScheduler))
      val pending = mutableListOf<Job>()
      var authentication: Job? = null
      var prompts = 0
      try {
        val owner =
          GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
            authentication = kotlin.coroutines.coroutineContext[Job]
            prompts++
            open("https://example.cloudflareaccess.com/login")
            grant.await()
          })
        val caller = async { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } }.also(pending::add)
        runCurrent()
        val launch = checkNotNull(owner.presentation.value.browserLaunch)
        caller.cancelAndJoin()
        assertTrue(checkNotNull(authentication).isActive)
        assertNull(owner.presentation.value.attention)
        assertNull(owner.presentation.value.browserLaunch)
        assertNull(owner.consumeBrowserLaunch(launch.attemptId))
        grant.complete(CloudflareAccessTestTokens.session("detached-owner"))
        runCurrent()
        assertTrue(checkNotNull(authentication).isCompleted)
        assertEquals("detached-owner", CloudflareAccessSession.decode(checkNotNull(storage.values[application.origin])).subject)
        val current = checkNotNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
        current.requireCurrent(Request.Builder().url(application.origin.uri.toString()).build())
        assertSame(current, owner.authorization(endpoint))
        assertFalse(owner.blocksAutomaticReconnect(endpoint.stableId))
        assertNull(owner.presentation.value.attention)
        assertNull(owner.presentation.value.browserLaunch)
        assertEquals(1, prompts)
      } finally {
        ownerScope.close({ pending.asSequence() }) {
          grant.cancel()
        }
      }
    }

  @Test fun differentApplicationsReplaceBrowserOwnershipWithoutAdmittingALateGrant() =
    runTest {
      for (sameProfile in listOf(false, true)) {
        for (differentIssuer in listOf(false, true)) {
          val other = if (differentIssuer) application.copy(issuer = CloudflareAccessJWT.issuer("other.cloudflareaccess.com")) else application.copy(audience = "other-audience")
          val registry = registry()
          val replacement = if (sameProfile) endpoint else GatewayEndpoint.manual(endpoint.host, endpoint.port, true, "/other/socket")
          if (!sameProfile) add(registry, replacement)
          val storage = Storage()
          val firstGrant = CompletableDeferred<CloudflareAccessSession>()
          val secondGrant = CompletableDeferred<CloudflareAccessSession>()
          val requested = mutableListOf<CloudflareAccessApplication>()
          val probes = mutableListOf<String>()
          var useReplacement = false
          val owner =
            GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ ->
              client({ if (useReplacement && target.stableId == replacement.stableId) other else application }) { request ->
                probes += request.url.toString()
                request.header("Cf-Access-Token") == null
              }
            }, authenticate = { descriptor, open ->
              requested += descriptor
              open("https://${descriptor.issuer.host}/login")
              if (descriptor == application) withContext(NonCancellable) { firstGrant.await() } else secondGrant.await()
            })
          val first = async { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } } }
          var second: Deferred<GatewayIngressAuthorization?>? = null
          try {
            runCurrent()
            val oldLaunch = checkNotNull(owner.presentation.value.browserLaunch)
            assertEquals(listOf(application), requested)
            useReplacement = true
            val replacementWaiter = async { owner.prepare(replacement, tls.copy(stableId = replacement.stableId), true, owner.admissionCheckpoint()) { true } }
            second = replacementWaiter
            runCurrent()
            assertEquals(listOf(application, other), requested)
            val presentation = owner.presentation.value
            assertEquals(replacement.stableId, presentation.attention?.stableId)
            assertTrue(checkNotNull(presentation.browserLaunch).attemptId != oldLaunch.attemptId)
            assertNull(owner.cancel(oldLaunch.attemptId))
            assertNull(owner.consumeBrowserLaunch(oldLaunch.attemptId))
            assertEquals(presentation, owner.presentation.value)
            val session = sessionFor(other)
            secondGrant.complete(session)
            val lease = checkNotNull(replacementWaiter.await())
            val encoded = checkNotNull(storage.values[application.origin])
            assertEquals(other, CloudflareAccessSession.decode(encoded).application)
            firstGrant.complete(CloudflareAccessTestTokens.session())
            assertTrue(first.await().exceptionOrNull() is CancellationException)
            assertEquals(encoded, storage.values[application.origin])
            lease.requireCurrent(Request.Builder().url(application.origin.uri.toString()).build())
            assertNull(owner.presentation.value.attention)
            assertNull(owner.presentation.value.browserLaunch)
            assertTrue(probes.any { it.endsWith(endpoint.contextPath) })
            assertTrue(probes.any { it.endsWith(replacement.contextPath) })
          } finally {
            firstGrant.complete(CloudflareAccessTestTokens.session())
            first.cancelAndJoin()
            second?.cancelAndJoin()
          }
        }
      }
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
        }, authenticate = { _, _ -> error("Policy-accepted cached token must not prompt") })
      val lease = checkNotNull(owner.prepare(replacement, tls.copy(stableId = replacement.stableId), false, owner.admissionCheckpoint()) { true })
      assertEquals(2, probes.size)
      assertEquals(listOf("/linked/socket", "/linked/socket"), probes.map { it.url.encodedPath })
      assertNull(probes[0].header("Cf-Access-Token"))
      assertNotNull(probes[1].header("Cf-Access-Token"))
      lease.requireCurrent(probes.last())
      assertEquals(application, CloudflareAccessSession.decode(checkNotNull(storage.values[application.origin])).application)
      assertNull(owner.presentation.value.browserLaunch)
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
          if (formerlyManaged) owner.prepare(ordinary, tls.copy(stableId = ordinary.stableId), false, owner.admissionCheckpoint()) { true }
          ordinaryReady = true
          assertNull(owner.prepare(ordinary, tls.copy(stableId = ordinary.stableId), false, owner.admissionCheckpoint()) { true })
          owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true }
          now += 2
          if (foreground) owner.revalidate() else advanceTimeBy(1001)
          runCurrent()
          assertAttentionProfile(endpoint.stableId, owner)
          assertFalse(owner.blocksAutomaticReconnect(ordinary.stableId))
          assertNull(owner.authorization(ordinary))
        }
      }
    }

  @Test fun browserVerificationTransportFailureIsNotPresentedAsCancellation() =
    runTest {
      val registry = registry()
      val storage = Storage()
      val failure = SSLHandshakeException("gateway TLS fingerprint mismatch")
      val ownerScope = OwnedTestScope(StandardTestDispatcher(testScheduler))
      try {
        val owner =
          GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
            open("https://example.cloudflareaccess.com/login")
            throw failure
          })
        val error = runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } }.exceptionOrNull()
        assertTlsFailure(failure, error)
        assertTrue(checkNotNull(owner.presentation.value.attention).message.startsWith("TLS connection failed:"))
        assertFalse(checkNotNull(owner.presentation.value.attention).message.contains("canceled"))
        assertNull(owner.presentation.value.browserLaunch)
        assertNull(storage.values[application.origin])
      } finally {
        ownerScope.close()
      }
    }

  private class IngressTransport {
    val ready = CompletableDeferred<Unit>()
    val failure = CompletableDeferred<Pair<GatewaySession.ErrorShape, Boolean>>()
    lateinit var session: GatewaySession
  }

  private inner class PinnedIngressFixture {
    private val address = InetAddress.getLoopbackAddress()
    private val host = checkNotNull(address.hostAddress)
    private val tlsIdentity = gatewayTestTls()
    val server =
      MockWebServer().apply {
        useHttps(tlsIdentity.first, false)
        start(address, 0)
      }
    val foreign =
      MockWebServer().apply {
        useHttps(tlsIdentity.first, false)
        dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setBody("foreign")
          }
        start(address, 0)
      }
    val target = GatewayEndpoint.manual(host, server.port, true, "/gateway/socket")
    val targetTls = GatewayTlsParams(true, tlsIdentity.second, false, target.stableId)
    val url =
      server
        .url("/gateway/socket")
        .newBuilder()
        .host(host)
        .build()
    val foreignUrl =
      foreign
        .url("/gateway/socket")
        .newBuilder()
        .host(host)
        .build()
    val descriptor = application.copy(origin = CloudflareAccessOrigin.from(url.toString()))
    val first = grant("first")
    val second = grant("second")
    val firstHeader = checkNotNull(first.authorizationHeader(url.toString()))
    val secondHeader = checkNotNull(second.authorizationHeader(url.toString()))
    val storage = Storage().also { it.values[descriptor.origin] = first.encode() }
    val requests = ConcurrentLinkedQueue<RecordedRequest>()
    val challengeFirst = AtomicBoolean(false)
    val retryNextUpgrade = AtomicBoolean(false)
    val upgradeEntered = CompletableDeferred<Unit>()
    val upgradeReturned = CompletableDeferred<Unit>()
    val releaseUpgrade = CountDownLatch(1)
    val holdNextDiscovery = AtomicBoolean(false)
    val discoveryEntered = CompletableDeferred<Unit>()
    val discoverySettled = CompletableDeferred<Unit>()
    val releaseDiscovery = CountDownLatch(1)
    private val uncaught = ConcurrentLinkedQueue<Throwable>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default + CoroutineExceptionHandler { _, error -> uncaught += error })
    private val transports = mutableListOf<IngressTransport>()
    private val config = checkNotNull(buildGatewayTlsConfig(targetTls))
    private val client =
      OkHttpClient
        .Builder()
        .sslSocketFactory(config.sslSocketFactory, config.trustManager)
        .hostnameVerifier(config.hostnameVerifier)
        .addNetworkInterceptor { chain ->
          if (chain.request().header("Cf-Access-Token") == null || !holdNextDiscovery.compareAndSet(true, false)) {
            return@addNetworkInterceptor chain.proceed(chain.request())
          }
          discoveryEntered.complete(Unit)
          try {
            check(releaseDiscovery.await(5, TimeUnit.SECONDS))
            chain.proceed(chain.request())
          } finally {
            discoverySettled.complete(Unit)
          }
        }.build()
    var authentications = 0
    var retirements = 0
    val owner =
      GatewayIngressController(
        scope,
        registry().also { add(it, target) },
        storage.persistence,
        { emptyMap() },
        retireTransports = { origin ->
          assertEquals(descriptor.origin, origin)
          transports.toList().forEach { it.session.disconnectAndJoin() }
          retirements++
        },
        clientForRoute = { _, _ ->
          CloudflareAccessClient { request, maximumBytes, timeout ->
            if (request.url.toString() == descriptor.issuer.resolve("/cdn-cgi/access/certs").toString()) {
              check(request.method == "GET" && request.header("Cf-Access-Token") == null && request.header("Cookie") == null && request.header("Authorization") == null)
              CloudflareAccessClient.Reply(request.url.toString(), 200, Headers.Builder().build(), CloudflareAccessTestTokens.jwks)
            } else {
              check(descriptor.origin.contains(request.url.toString()))
              CloudflareAccessClient.send(request, maximumBytes, timeout, client)
            }
          }
        },
        authenticate = { actual, _ ->
          assertEquals(descriptor, actual)
          authentications++
          second
        },
      )

    init {
      server.dispatcher =
        object : Dispatcher() {
          override fun dispatch(request: RecordedRequest): MockResponse {
            requests += request
            if (request.method == "HEAD") {
              val metadata =
                CloudflareAccessTestTokens.token(
                  JsonObject(
                    mapOf(
                      "type" to JsonPrimitive("match"),
                      "hostname" to JsonPrimitive(descriptor.origin.uri.host),
                      "auth_domain" to JsonPrimitive(descriptor.issuer.host),
                      "aud" to JsonPrimitive(descriptor.audience),
                      "iat" to JsonPrimitive(System.currentTimeMillis() / 1000.0),
                    ),
                  ),
                )
              return MockResponse().setHeader("Cf-Access-Metadata", metadata)
            }
            val token = request.getHeader("Cf-Access-Token")
            if (token == null || (token == firstHeader && challengeFirst.get())) {
              return MockResponse().setResponseCode(302).setHeader("WWW-Authenticate", "Cloudflare-Access resource_metadata=\"${descriptor.origin.uri}/.well-known/cloudflare-access-protected-resource/gateway/socket\"")
            }
            if (request.getHeader("Upgrade")?.equals("websocket", ignoreCase = true) == true) {
              if (retryNextUpgrade.compareAndSet(true, false)) {
                upgradeEntered.complete(Unit)
                check(releaseUpgrade.await(5, TimeUnit.SECONDS))
                upgradeReturned.complete(Unit)
                return MockResponse().setResponseCode(503).setHeader("Retry-After", "0")
              }
              return MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                  override fun onOpen(
                    webSocket: WebSocket,
                    response: Response,
                  ) {
                    webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"android-test-nonce","ts":1700000000123}}""")
                  }

                  override fun onMessage(
                    webSocket: WebSocket,
                    text: String,
                  ) {
                    val frame = Json.parseToJsonElement(text).jsonObject
                    if (frame["type"]?.jsonPrimitive?.content != "req") return
                    val id = frame["id"]?.jsonPrimitive?.content ?: return
                    val payload =
                      when (frame["method"]?.jsonPrimitive?.content) {
                        "connect" -> """{"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}"""
                        "artifacts.download" -> """{"artifact":{"type":"video","mimeType":"video/mp4"},"url":"/api/chat/media/outgoing/fixture?mediaTicket=fixture"}"""
                        else -> error("Unexpected Gateway fixture method")
                      }
                    webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":$payload}""")
                  }

                  override fun onClosing(
                    webSocket: WebSocket,
                    code: Int,
                    reason: String,
                  ) {
                    webSocket.close(code, reason)
                  }
                },
              )
            }
            return MockResponse().setResponseCode(if (request.getHeader("Range") == null) 200 else 206).setBody("video")
          }
        }
    }

    private fun grant(subject: String): CloudflareAccessSession {
      val expires = System.currentTimeMillis() / 1000.0 + 3600
      val claims =
        JsonObject(
          CloudflareAccessTestTokens.claims(subject, expires) +
            mapOf(
              "iss" to JsonPrimitive(descriptor.issuer.toString()),
              "aud" to JsonArray(listOf(JsonPrimitive(descriptor.audience))),
            ),
        )
      return CloudflareAccessSession(descriptor, subject, expires, CloudflareAccessTestTokens.token(claims))
    }

    suspend fun prepare(interactive: Boolean = false): GatewayIngressAuthorization = checkNotNull(withTimeout(5_000) { owner.prepare(target, targetTls, interactive, owner.admissionCheckpoint()) { true } })

    suspend fun replace(): GatewayIngressAuthorization {
      challengeFirst.set(true)
      val replacement = prepare(interactive = true)
      val persisted = CloudflareAccessSession.decode(checkNotNull(storage.values[descriptor.origin]))
      assertEquals(second.subject, persisted.subject)
      assertEquals(descriptor, persisted.application)
      assertEquals(secondHeader, persisted.authorizationHeader(url.toString()))
      assertEquals(1, authentications)
      assertTrue(retirements > 0)
      return replacement
    }

    fun connect(
      authorization: GatewayIngressAuthorization? = null,
      foreignAuthority: Boolean = false,
    ): IngressTransport {
      val context = RuntimeEnvironment.getApplication()
      val connection = IngressTransport()
      val selected = if (foreignAuthority) target.copy(stableId = "foreign", port = foreign.port) else target
      connection.session =
        GatewaySession(
          scope = scope,
          identityStore = testDeviceIdentityStore(context),
          deviceAuthStore = DeviceAuthStore(SecurePrefs(context, securePrefsOverride = context.getSharedPreferences("ingress-device-${UUID.randomUUID()}", Context.MODE_PRIVATE))),
          onConnected = { connection.ready.complete(Unit) },
          onDisconnected = {},
          onEvent = { _, _ -> },
          onConnectFailure = { error, pause -> connection.failure.complete(error to pause) },
          ingressAuthorizationProvider = { authorization ?: owner.authorization(it) },
        )
      transports += connection
      connection.session.connect(
        selected,
        "gateway-token",
        null,
        null,
        GatewayConnectOptions(
          role = "node",
          scopes = emptyList(),
          caps = emptyList(),
          commands = emptyList(),
          permissions = emptyMap(),
          client = GatewayClientInfo("openclaw-android-test", "Android Test", "test", "android", "node", "test", "android", "test"),
        ),
        targetTls.copy(stableId = selected.stableId),
      )
      return connection
    }

    suspend fun media(connection: IngressTransport): GatewayLoadedMedia.Streaming {
      withTimeout(5_000) { connection.ready.await() }
      return withTimeout(5_000) {
        checkNotNull(connection.session.loadMediaArtifact(target.stableId, "main", null, "fixture", GatewayMediaKind.Video)) as GatewayLoadedMedia.Streaming
      }
    }

    suspend fun assertForeignTlsIsHealthy() {
      assertEquals(0, foreign.requestCount)
      val response = CloudflareAccessClient.send(Request.Builder().url(foreignUrl).build(), 64, 5, client)
      assertEquals(200, response.code)
      val request = checkNotNull(foreign.takeRequest(5, TimeUnit.SECONDS))
      assertNull(request.getHeader("Cf-Access-Token"))
      assertNull(request.getHeader("Cookie"))
      assertNull(request.getHeader("Authorization"))
      assertEquals(1, foreign.requestCount)
    }

    fun upgrades() = requests.filter { it.getHeader("Upgrade")?.equals("websocket", ignoreCase = true) == true }

    fun mediaRequests() = requests.filter { it.path?.contains("/api/chat/media/outgoing/") == true }

    suspend fun close() =
      withContext(NonCancellable) {
        releaseUpgrade.countDown()
        releaseDiscovery.countDown()
        transports.forEach { it.session.disconnectAndJoin() }
        scope.cancel()
        scope.coroutineContext[Job]?.join()
        if (discoveryEntered.isCompleted) withTimeout(5_000) { discoverySettled.await() }
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
        // MockWebServer owns accepted sockets; its server-side peers have no client Call.
        server.shutdown()
        foreign.shutdown()
        assertTrue(uncaught.isEmpty())
      }
  }

  @Test fun currentOwnerLeaseGuardsRealUpgradeAuthorityAndReplacementFollowUp() =
    runBlocking {
      val fixture = PinnedIngressFixture()
      try {
        val first = fixture.prepare()
        // A current lease succeeds through the real 503 follow-up on its original HTTPS authority.
        fixture.retryNextUpgrade.set(true)
        fixture.releaseUpgrade.countDown()
        val healthy = fixture.connect()
        withTimeout(5_000) { healthy.ready.await() }
        assertEquals(listOf(fixture.firstHeader, fixture.firstHeader), fixture.upgrades().map { it.getHeader("Cf-Access-Token") })
        val foreign = fixture.connect(first, foreignAuthority = true)
        val denied = withTimeout(5_000) { foreign.failure.await() }
        assertEquals("EXTERNAL_AUTH_REQUIRED", denied.first.code)
        assertTrue(denied.second)
        assertEquals(0, fixture.foreign.requestCount)
        first.requireCurrent(Request.Builder().url(fixture.url).build())
        fixture.assertForeignTlsIsHealthy()
      } finally {
        fixture.close()
      }

      val replacement = PinnedIngressFixture()
      try {
        val first = replacement.prepare()
        replacement.retryNextUpgrade.set(true)
        val pending = replacement.connect()
        withTimeout(5_000) { replacement.upgradeEntered.await() }
        val second = replacement.replace()
        assertFalse(pending.ready.isCompleted)
        replacement.releaseUpgrade.countDown()
        withTimeout(5_000) { replacement.upgradeReturned.await() }
        // This held response proves owned transport retirement; the fresh stale-lease
        // attempt below independently proves rejection before any new HTTP exchange.
        assertTrue(runCatching { first.requireCurrent(Request.Builder().url(replacement.url).build()) }.exceptionOrNull() is GatewayExternalAuthorizationException)
        val before = replacement.server.requestCount
        val stale = replacement.connect(first)
        assertEquals("EXTERNAL_AUTH_REQUIRED", withTimeout(5_000) { stale.failure.await() }.first.code)
        assertEquals(before, replacement.server.requestCount)
        val current = replacement.connect(second)
        withTimeout(5_000) { current.ready.await() }
        assertEquals(listOf(replacement.firstHeader, replacement.secondHeader), replacement.upgrades().map { it.getHeader("Cf-Access-Token") })
      } finally {
        replacement.close()
      }
    }

  @Test fun currentOwnerLeaseGuardsRealStreamingAuthorityAndReplacedRangeRequests() =
    runBlocking {
      val fixture = PinnedIngressFixture()
      try {
        val first = fixture.prepare()
        val stream = fixture.media(fixture.connect())

        fun request(
          media: GatewayLoadedMedia.Streaming,
          range: String? = null,
        ): Request =
          Request
            .Builder()
            .url(media.url)
            .also { builder ->
              media.headers.forEach { (name, value) -> builder.header(name, value) }
              range?.let { builder.header("Range", it) }
            }.build()
        stream.client
          .newCall(request(stream))
          .execute()
          .use { assertEquals(200, it.code) }
        assertEquals(fixture.firstHeader, fixture.mediaRequests().single().getHeader("Cf-Access-Token"))
        val wrong = request(stream).newBuilder().url(fixture.foreignUrl).build()
        assertTrue(
          runCatching {
            stream.client
              .newCall(wrong)
              .execute()
              .close()
          }.exceptionOrNull() is GatewayExternalAuthorizationException,
        )
        assertEquals(0, fixture.foreign.requestCount)
        first.requireCurrent(Request.Builder().url(fixture.url).build())
        fixture.replace()
        val before = fixture.server.requestCount
        for (range in listOf(null, "bytes=0-3")) {
          assertTrue(
            runCatching {
              stream.client
                .newCall(request(stream, range))
                .execute()
                .close()
            }.exceptionOrNull() is GatewayExternalAuthorizationException,
          )
        }
        assertEquals(before, fixture.server.requestCount)
        val current = fixture.media(fixture.connect())
        for (range in listOf(null, "bytes=0-3")) {
          current.client
            .newCall(request(current, range))
            .execute()
            .use { assertEquals(if (range == null) 200 else 206, it.code) }
        }
        assertEquals(listOf(fixture.firstHeader, fixture.secondHeader, fixture.secondHeader), fixture.mediaRequests().map { it.getHeader("Cf-Access-Token") })
        assertEquals(listOf(null, null, "bytes=0-3"), fixture.mediaRequests().map { it.getHeader("Range") })
        assertEquals(0, fixture.foreign.requestCount)
        fixture.assertForeignTlsIsHealthy()
      } finally {
        fixture.close()
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
            var prompts = 0
            val pin =
              when (mode) {
                "matching-pin" -> fingerprint
                "wrong-pin" -> "0".repeat(64)
                else -> null
              }
            // Leave clientForRoute at its production default: the raw Access probe
            // must use the same selected pin/platform trust as the Gateway transport.
            val owner =
              GatewayIngressController(scope, registry, storage.persistence, { emptyMap() }, {}, authenticate = { _, _ ->
                prompts++
                error("TLS rejection must not enter Access authentication")
              })
            val result =
              runCatching {
                withTimeout(8_000) {
                  owner.prepare(target, GatewayTlsParams(true, pin, false, target.stableId), true, owner.admissionCheckpoint()) { true }
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
            assertEquals(0, prompts)
            assertTrue(storage.values.isEmpty())
            assertNull(owner.authorization(target))
            assertNull(owner.presentation.value.attention)
            assertNull(owner.presentation.value.browserLaunch)
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
