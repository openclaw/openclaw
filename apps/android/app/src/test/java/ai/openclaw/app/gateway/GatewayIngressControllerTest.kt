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

  private fun assertAttentionMessage(
    expected: String,
    owner: GatewayIngressController,
  ) {
    assertEquals(
      expected,
      owner.presentation.value.attention
        ?.message,
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

  @Test fun headerlessLoginRedirectsPreserveAdmissionAndRejectRevokedGrants() =
    runTest {
      for (rejection in listOf("prepare", "upgrade", "response")) {
        val registry = registry()
        val storage = Storage()
        var ordinary = true
        var revoked = false
        var prompts = 0
        val grant = CompletableDeferred<CloudflareAccessSession>()
        val owner =
          GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ ->
            client(loginRedirect = true) { !ordinary && (revoked || it.header("Cf-Access-Token") == null) }
          }, authenticate = { _, open ->
            prompts++
            open("https://example.cloudflareaccess.com/login")
            grant.await()
          })
        assertNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
        assertNull(owner.presentation.value.attention)
        assertEquals(0, prompts)
        ordinary = false
        assertTrue(runCatching { owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true } }.exceptionOrNull() is GatewayExternalAuthorizationException)
        assertAttentionProfile(endpoint.stableId, owner)
        assertNull(owner.presentation.value.browserLaunch)
        assertEquals(0, prompts)
        val pending = async { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } }
        try {
          runCurrent()
          val launch = checkNotNull(owner.presentation.value.browserLaunch)
          assertEquals(launch.url, owner.consumeBrowserLaunch(launch.attemptId))
          grant.complete(CloudflareAccessTestTokens.session())
          val current = checkNotNull(pending.await())
          val request = Request.Builder().url(application.origin.uri.toString()).build()
          current.requireCurrent(request)
          val cached = checkNotNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
          assertNotNull(cached.authorizeUpgrade(request).header("Cf-Access-Token"))
          assertEquals(1, prompts)
          assertNull(owner.presentation.value.attention)
          revoked = true
          if (rejection == "response") {
            val response =
              okhttp3.Response
                .Builder()
                .request(request)
                .protocol(okhttp3.Protocol.HTTP_1_1)
                .code(302)
                .message("Found")
                .header("Location", "https://login.example.test/cdn-cgi/access/login?opaque=ignored")
                .build()
            assertNotNull(cached.rejection(response))
          } else {
            val failure =
              runCatching {
                if (rejection == "prepare") {
                  owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true }
                } else {
                  cached.authorizeUpgrade(request)
                }
              }.exceptionOrNull()
            assertTrue(failure is GatewayExternalAuthorizationException)
          }
          runCurrent()
          assertTrue(runCatching { cached.requireCurrent(request) }.exceptionOrNull() is GatewayExternalAuthorizationException)
          assertAttentionProfile(endpoint.stableId, owner)
          assertNull(owner.presentation.value.browserLaunch)
          assertEquals(1, prompts)
          owner.forget(endpoint.stableId)
          assertNull(storage.values[application.origin])
        } finally {
          grant.cancel()
          pending.cancelAndJoin()
        }
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

  @Test fun signOutFencesPendingAccessProbeWhileOrdinarySiblingCompletes() =
    runTest {
      val registry = registry()
      val sibling = endpoint.copy(stableId = "ordinary-sibling")
      add(registry, sibling)
      registry.setAccessOrigin(endpoint.stableId, application.origin)
      val storage = Storage()
      storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
      val gate = CompletableDeferred<Unit>()
      var probes = 0
      var prompts = 0
      val owner =
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ ->
          client {
            probes++
            gate.await()
            target.stableId == endpoint.stableId
          }
        }, authenticate = { _, _ ->
          prompts++
          error("A retired admission must not open a browser")
        })
      val managed = async { runCatching { owner.prepare(endpoint, tls, true, admissionCheckpoint = owner.admissionCheckpoint()) { true } } }
      val ordinary = async { owner.prepare(sibling, tls.copy(stableId = sibling.stableId), true, admissionCheckpoint = owner.admissionCheckpoint()) { true } }
      try {
        runCurrent()
        assertEquals(2, probes)
        owner.signOut(endpoint.stableId)?.await()
      } finally {
        gate.complete(Unit)
      }
      assertTrue(managed.await().exceptionOrNull() is CancellationException)
      assertNull(ordinary.await())
      assertEquals(0, prompts)
      assertNull(owner.presentation.value.browserLaunch)
      assertNull(storage.values[application.origin])
      assertFalse(sibling.stableId in owner.presentation.value.browserRequired)
    }

  @Test fun retirementJoinsCredentialedDiscoveryFromPrepareAndUpgrade() =
    runTest {
      for (upgrade in listOf(false, true)) {
        for (retirement in listOf("sign-out", "forget", "expiry")) {
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
                when (retirement) {
                  "sign-out" -> {
                    checkNotNull(owner.signOut(endpoint.stableId)).await()
                  }

                  "forget" -> {
                    owner.forget(endpoint.stableId)
                  }

                  else -> {
                    now += 61
                    owner.revalidate()
                  }
                }
              }
            runCurrent()
            assertTrue("$upgrade/$retirement must cancel the owned probe", canceled.isCompleted)
            if (retirement != "expiry") assertFalse(cleanup.isCompleted)
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

  @Test fun profileForgetDrainsOnlyItsDiscoveryAndPreservesRecreatedAdmission() =
    runTest {
      val registry = registry()
      val sibling = endpoint.copy(stableId = "discovery-sibling")
      add(registry, sibling)
      val storage = Storage()
      storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
      val entered = CompletableDeferred<Unit>()
      val canceled = CompletableDeferred<Unit>()
      val release = CompletableDeferred<Unit>()
      var hold = false
      val owner =
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ ->
          client {
            if (it.header("Cf-Access-Token") == null) return@client true
            if (hold && target.stableId == endpoint.stableId) {
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
      val siblingLease = checkNotNull(owner.prepare(sibling, tls.copy(stableId = sibling.stableId), false, owner.admissionCheckpoint()) { true })
      hold = true
      val pending = async { runCatching { owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true } } }
      var forgetting: Deferred<Unit>? = null
      var replacement: Deferred<GatewayIngressAuthorization?>? = null
      try {
        runCurrent()
        assertTrue(entered.isCompleted)
        forgetting = async { owner.forget(endpoint.stableId) }
        runCurrent()
        assertTrue(canceled.isCompleted)
        assertFalse(forgetting.isCompleted)
        val request = Request.Builder().url("${application.origin.uri}/gateway/socket").build()
        siblingLease.requireCurrent(request)
        assertNotNull(storage.values[application.origin])
        assertTrue(storage.deleted.isEmpty())
        hold = false
        replacement = async { owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true } }
        runCurrent()
        assertFalse(replacement.isCompleted)
        release.complete(Unit)
        forgetting.await()
        val current = checkNotNull(replacement.await())
        current.requireCurrent(request)
        siblingLease.requireCurrent(request)
        assertTrue(pending.await().exceptionOrNull() is CancellationException)
        assertAccessOrigin(application.origin.uri.toString(), registry, endpoint.stableId)
        assertNotNull(storage.values[application.origin])
        assertTrue(storage.deleted.isEmpty())
        assertNull(owner.presentation.value.browserLaunch)
      } finally {
        release.complete(Unit)
        pending.cancelAndJoin()
        forgetting?.cancelAndJoin()
        replacement?.cancelAndJoin()
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

  @Test fun repeatedAdmissionRetiresEveryPreviouslyIssuedCapabilityOnSignOut() =
    runTest {
      val storage = Storage()
      storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
      val retirement = CompletableDeferred<Unit>()
      val owner = GatewayIngressController(backgroundScope, registry(), storage.persistence, { emptyMap() }, { retirement.await() }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() })
      val first = checkNotNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
      val second = checkNotNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
      val request = Request.Builder().url(application.origin.uri.toString()).build()
      assertTrue(runCatching { first.requireCurrent(request) }.exceptionOrNull() is GatewayExternalAuthorizationException)
      second.requireCurrent(request)
      val stopped = checkNotNull(owner.signOut(endpoint.stableId))
      assertTrue(runCatching { second.requireCurrent(request) }.exceptionOrNull() is GatewayExternalAuthorizationException)
      retirement.complete(Unit)
      stopped.await()
      assertTrue(runCatching { first.requireCurrent(request) }.exceptionOrNull() is GatewayExternalAuthorizationException)
    }

  @Test fun signOutAcknowledgesOnlyAfterDurableDeletion() =
    runTest {
      val storage = Storage()
      val encoded = CloudflareAccessTestTokens.session().encode()
      storage.values[application.origin] = encoded
      val drain = CompletableDeferred<Unit>()
      var deleteEntered = false
      lateinit var owner: GatewayIngressController
      val persistence =
        CloudflareAccessSessionStore.Persistence(
          load = storage.persistence.load,
          save = storage.persistence.save,
          delete = { origin ->
            deleteEntered = true
            assertAttentionMessage("Signing out…", owner)
            storage.persistence.delete(origin)
          },
        )
      owner = GatewayIngressController(backgroundScope, registry(), persistence, { emptyMap() }, { drain.await() }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() })
      val lease = checkNotNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
      val stopped = checkNotNull(owner.signOut(endpoint.stableId))
      try {
        runCurrent()
        assertAttentionMessage("Signing out…", owner)
        assertFalse(stopped.isCompleted)
        assertFalse(deleteEntered)
        assertEquals(encoded, storage.values[application.origin])
        assertTrue(runCatching { lease.requireCurrent(Request.Builder().url(application.origin.uri.toString()).build()) }.exceptionOrNull() is GatewayExternalAuthorizationException)
        drain.complete(Unit)
        stopped.await()
        runCurrent()
        assertTrue(deleteEntered)
        assertNull(storage.values[application.origin])
        assertTrue(checkNotNull(owner.presentation.value.attention).message.contains("is signed out"))
      } finally {
        drain.complete(Unit)
      }
    }

  @Test fun completedSignOutPreservesNewerUnavailableGatewayFailure() =
    runTest {
      val registry = registry()
      registry.setAccessOrigin(endpoint.stableId, application.origin)
      val storage = Storage()
      val encoded = CloudflareAccessTestTokens.session().encode()
      storage.values[application.origin] = encoded
      val drain = CompletableDeferred<Unit>()
      val owner = GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, { drain.await() }, registryObserverDispatcher = StandardTestDispatcher(testScheduler))
      val stopped = checkNotNull(owner.signOut(endpoint.stableId))
      try {
        runCurrent()
        assertFalse(stopped.isCompleted)
        assertEquals(encoded, storage.values[application.origin])
        checkNotNull(owner.retry(owner.admissionCheckpoint()) { true }).reportFailure("Saved endpoint unavailable")
        val failure = checkNotNull(owner.presentation.value.attention)
        assertEquals("Saved endpoint unavailable", failure.message)
        drain.complete(Unit)
        stopped.await()
        runCurrent()
        assertNull(storage.values[application.origin])
        assertTrue(failure === owner.presentation.value.attention)
      } finally {
        drain.complete(Unit)
      }
    }

  @Test fun sharedHostSignOutResolvesOnlyItsCapturedPresentationOwner() =
    runTest {
      for (ordinarySibling in listOf(false, true)) {
        for (deleteSucceeds in listOf(false, true)) {
          for (newerFailure in listOf(false, true)) {
            val registry = registry()
            val sibling = endpoint.copy(stableId = "sign-out-sibling")
            add(registry, sibling)
            registry.setAccessOrigin(endpoint.stableId, application.origin)
            registry.setAccessOrigin(sibling.stableId, application.origin)
            val storage = Storage().also { it.deleteSucceeds = deleteSucceeds }
            val encoded = CloudflareAccessTestTokens.session().encode()
            storage.values[application.origin] = encoded
            val firstDrain = CompletableDeferred<Unit>()
            val secondDrain = CompletableDeferred<Unit>()
            var drainCount = 0
            val uncaught = mutableListOf<Throwable>()
            val supervisor = SupervisorJob()
            val scope = CoroutineScope(supervisor + StandardTestDispatcher(testScheduler) + CoroutineExceptionHandler { _, error -> uncaught += error })
            val owner =
              GatewayIngressController(scope, registry, storage.persistence, { emptyMap() }, {
                if (++drainCount == 1) firstDrain.await() else secondDrain.await()
              }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client { false } })
            try {
              if (ordinarySibling) {
                assertNull(owner.prepare(sibling, tls.copy(stableId = sibling.stableId), false, owner.admissionCheckpoint()) { true })
                assertAccessOrigin(application.origin.uri.toString(), registry, sibling.stableId)
              }
              val first = checkNotNull(owner.signOut(endpoint.stableId))
              runCurrent()
              val original = checkNotNull(owner.presentation.value.attention)
              // Changing selection must not strand the still-registered presentation owner.
              registry.setActive(sibling.stableId)
              runCurrent()
              assertTrue(original === owner.presentation.value.attention)
              val failure =
                if (newerFailure) {
                  checkNotNull(owner.retry(owner.admissionCheckpoint()) { true }).reportFailure("Saved endpoint unavailable")
                  checkNotNull(owner.presentation.value.attention)
                } else {
                  null
                }
              val second = checkNotNull(owner.signOut(sibling.stableId))
              runCurrent()
              val pending = checkNotNull(owner.presentation.value.attention)
              if (failure != null) {
                assertTrue(failure === pending)
              } else {
                assertEquals(if (ordinarySibling) endpoint.stableId else sibling.stableId, pending.stableId)
                assertEquals("Signing out…", pending.message)
                if (ordinarySibling) assertTrue(original === pending)
              }
              firstDrain.complete(Unit)
              val firstResult = runCatching { first.await() }
              assertEquals(deleteSucceeds, firstResult.isSuccess)
              if (!deleteSucceeds) assertEquals(CloudflareAccessException.Kind.StorageFailed, (firstResult.exceptionOrNull() as? CloudflareAccessException)?.kind)
              runCurrent()
              assertEquals(2, drainCount)
              assertFalse(second.isCompleted)
              assertTrue(pending === owner.presentation.value.attention)
              secondDrain.complete(Unit)
              val secondResult = runCatching { second.await() }
              assertEquals(deleteSucceeds, secondResult.isSuccess)
              if (!deleteSucceeds) assertEquals(CloudflareAccessException.Kind.StorageFailed, (secondResult.exceptionOrNull() as? CloudflareAccessException)?.kind)
              runCurrent()
              assertEquals(if (deleteSucceeds) null else encoded, storage.values[application.origin])
              if (failure != null) {
                assertTrue(failure === owner.presentation.value.attention)
              } else {
                val completed = checkNotNull(owner.presentation.value.attention)
                assertEquals(pending.stableId, completed.stableId)
                assertTrue(completed.message.contains(if (deleteSucceeds) "is signed out" else "Try Sign out again"))
              }
              if (ordinarySibling) {
                assertNull(owner.authorization(sibling))
                assertFalse(owner.needsEmbeddedBrowserSignIn(sibling.stableId))
                assertFalse(owner.blocksAutomaticReconnect(sibling.stableId))
              }
            } finally {
              firstDrain.complete(Unit)
              secondDrain.complete(Unit)
              supervisor.cancelAndJoin()
              assertTrue(uncaught.isEmpty())
            }
          }
        }
      }
    }

  @Test fun coldSignOutKeepsFirstRegistrationThroughAcknowledgement() =
    runTest {
      for (acknowledgeFirst in listOf(false, true)) {
        for (captureRetryFirst in listOf(false, true)) {
          for (deleteSucceeds in listOf(false, true)) {
            val registry = registry()
            registry.setAccessOrigin(endpoint.stableId, application.origin)
            val storage = Storage().also { it.deleteSucceeds = deleteSucceeds }
            val encoded = CloudflareAccessTestTokens.session().encode()
            storage.values[application.origin] = encoded
            val drain = CompletableDeferred<Unit>()
            val approved = CompletableDeferred<CloudflareAccessSession>()
            var prompts = 0
            val uncaught = mutableListOf<Throwable>()
            val supervisor = SupervisorJob()
            val scope = CoroutineScope(supervisor + StandardTestDispatcher(testScheduler) + CoroutineExceptionHandler { _, error -> uncaught += error })
            val owner =
              GatewayIngressController(scope, registry, storage.persistence, { emptyMap() }, { drain.await() }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
                prompts += 1
                open("https://example.cloudflareaccess.com/login")
                approved.await()
              })
            var preparing: Deferred<Result<GatewayIngressAuthorization?>>? = null
            try {
              val oldCheckpoint = owner.admissionCheckpoint()
              val stopped = checkNotNull(owner.signOut(endpoint.stableId))
              runCurrent()
              val pending = checkNotNull(owner.presentation.value.attention)
              assertEquals("Signing out…", pending.message)
              assertFalse(stopped.isCompleted)
              assertEquals(encoded, storage.values[application.origin])
              val queued = if (captureRetryFirst) checkNotNull(owner.retry(owner.admissionCheckpoint()) { true }) else null
              if (acknowledgeFirst) {
                drain.complete(Unit)
                assertEquals(deleteSucceeds, runCatching { stopped.await() }.isSuccess)
                runCurrent()
              }
              val beforeRegistration = checkNotNull(owner.presentation.value.attention)
              assertTrue(runCatching { owner.prepare(endpoint, tls, true, oldCheckpoint) { true } }.exceptionOrNull() is CancellationException)
              assertTrue(beforeRegistration === owner.presentation.value.attention)
              assertEquals(0, prompts)
              assertNull(owner.presentation.value.browserLaunch)
              val denied = checkNotNull(owner.authorization(endpoint))
              val request = Request.Builder().url(buildGatewayWebSocketUrl(endpoint.host, endpoint.port, true, endpoint.contextPath)).build()
              assertTrue(runCatching { denied.requireCurrent(request) }.exceptionOrNull() is GatewayExternalAuthorizationException)
              if (!acknowledgeFirst) {
                assertFalse(stopped.isCompleted)
                drain.complete(Unit)
                assertEquals(deleteSucceeds, runCatching { stopped.await() }.isSuccess)
                runCurrent()
              }
              val completed = checkNotNull(owner.presentation.value.attention)
              assertFalse(pending === completed)
              assertTrue(completed.message.contains(if (deleteSucceeds) "is signed out" else "Try Sign out again"))
              assertEquals(if (deleteSucceeds) null else encoded, storage.values[application.origin])
              storage.deleteSucceeds = true
              val retry = queued ?: checkNotNull(owner.retry(owner.admissionCheckpoint()) { true })
              preparing = scope.async { runCatching { retry.prepare(endpoint, tls) } }
              runCurrent()
              assertEquals(1, prompts)
              val launch = checkNotNull(owner.presentation.value.browserLaunch)
              assertEquals("https://example.cloudflareaccess.com/login", owner.consumeBrowserLaunch(launch.attemptId))
              assertFalse(preparing.isCompleted)
              val session = CloudflareAccessTestTokens.session("cold-retry")
              approved.complete(session)
              assertNotNull(preparing.await().getOrThrow())
              assertEquals(session.encode(), storage.values[application.origin])
              assertNull(owner.presentation.value.attention)
              assertEquals(1, prompts)
            } finally {
              drain.complete(Unit)
              preparing?.cancelAndJoin()
              supervisor.cancelAndJoin()
              assertTrue(uncaught.isEmpty())
            }
          }
        }
      }
    }

  @Test fun coldSignOutCannotBindAReplacedSavedEntry() =
    runTest {
      for (acknowledgeFirst in listOf(false, true)) {
        val registry = registry()
        registry.setAccessOrigin(endpoint.stableId, application.origin)
        val storage = Storage()
        storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
        val drain = CompletableDeferred<Unit>()
        var prompts = 0
        val owner =
          GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, { drain.await() }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, _ ->
            prompts += 1
            CloudflareAccessTestTokens.session()
          })
        val oldCheckpoint = owner.admissionCheckpoint()
        val stopped = checkNotNull(owner.signOut(endpoint.stableId))
        try {
          runCurrent()
          val queued = checkNotNull(owner.retry(owner.admissionCheckpoint()) { true })
          if (acknowledgeFirst) {
            drain.complete(Unit)
            stopped.await()
            runCurrent()
          }
          val saved = registry.entries.value.first { it.stableId == endpoint.stableId }
          registry.upsert(saved.copy(name = "Replaced saved entry"))
          // Register before the queued registry collector can clear the old action.
          assertTrue(runCatching { owner.prepare(endpoint, tls, true, oldCheckpoint) { true } }.exceptionOrNull() is CancellationException)
          assertNull(owner.presentation.value.attention)
          drain.complete(Unit)
          stopped.await()
          runCurrent()
          assertNull(owner.presentation.value.attention)
          assertTrue(runCatching { queued.prepare(endpoint, tls) }.exceptionOrNull() is CancellationException)
          assertEquals(0, prompts)
          assertNull(owner.presentation.value.browserLaunch)
          val denied = checkNotNull(owner.authorization(endpoint))
          val request = Request.Builder().url(buildGatewayWebSocketUrl(endpoint.host, endpoint.port, true, endpoint.contextPath)).build()
          assertTrue(runCatching { denied.requireCurrent(request) }.exceptionOrNull() is GatewayExternalAuthorizationException)
        } finally {
          drain.complete(Unit)
        }
      }
    }

  @Test fun pendingSignOutCannotAdoptAReplacementRegistrationDuringItsRawProbe() =
    runTest {
      for (deleteSucceeds in listOf(false, true)) {
        val registry = registry()
        val sibling = endpoint.copy(stableId = "ordinary-sign-out-sibling")
        add(registry, sibling)
        registry.setAccessOrigin(sibling.stableId, application.origin)
        val storage = Storage().also { it.deleteSucceeds = deleteSucceeds }
        storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
        val drain = CompletableDeferred<Unit>()
        val probe = CompletableDeferred<Unit>()
        var entered = false
        val replacement = endpoint.copy(contextPath = "/replacement/socket")
        val uncaught = mutableListOf<Throwable>()
        val supervisor = SupervisorJob()
        val scope = CoroutineScope(supervisor + StandardTestDispatcher(testScheduler) + CoroutineExceptionHandler { _, error -> uncaught += error })
        val owner =
          GatewayIngressController(scope, registry, storage.persistence, { emptyMap() }, { drain.await() }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ ->
            client { request ->
              if (target == replacement) {
                entered = true
                probe.await()
                throw java.io.IOException("test-only replacement probe failure")
              }
              target.stableId != sibling.stableId && request.header("Cf-Access-Token") == null
            }
          })
        var preparing: Deferred<Result<GatewayIngressAuthorization?>>? = null
        try {
          assertNotNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
          assertNull(owner.prepare(sibling, tls.copy(stableId = sibling.stableId), false, owner.admissionCheckpoint()) { true })
          val stopped = checkNotNull(owner.signOut(endpoint.stableId))
          runCurrent()
          assertEquals("Signing out…", checkNotNull(owner.presentation.value.attention).message)
          preparing = async { runCatching { owner.prepare(replacement, tls, false, owner.admissionCheckpoint()) { true } } }
          runCurrent()
          assertTrue(entered)
          assertFalse(preparing.isCompleted)
          assertNull(owner.presentation.value.attention)
          val siblingStop = checkNotNull(owner.signOut(sibling.stableId))
          assertNull(owner.presentation.value.attention)
          drain.complete(Unit)
          val stoppedResult = runCatching { stopped.await() }
          assertEquals(deleteSucceeds, stoppedResult.isSuccess)
          if (!deleteSucceeds) assertEquals(CloudflareAccessException.Kind.StorageFailed, (stoppedResult.exceptionOrNull() as? CloudflareAccessException)?.kind)
          val siblingStopResult = runCatching { siblingStop.await() }
          assertEquals(deleteSucceeds, siblingStopResult.isSuccess)
          if (!deleteSucceeds) assertEquals(CloudflareAccessException.Kind.StorageFailed, (siblingStopResult.exceptionOrNull() as? CloudflareAccessException)?.kind)
          runCurrent()
          assertNull(owner.presentation.value.attention)
          probe.complete(Unit)
          assertTrue(preparing.await().isFailure)
          assertNull(owner.presentation.value.attention)
        } finally {
          drain.complete(Unit)
          probe.complete(Unit)
          preparing?.cancelAndJoin()
          supervisor.cancelAndJoin()
          assertTrue(uncaught.isEmpty())
        }
      }
    }

  @Test fun pendingSignOutClearsWhenItsProfileLosesManagedOwnership() =
    runTest {
      for (change in listOf("forget", "ordinary", "association")) {
        val registry = registry()
        val sibling = endpoint.copy(stableId = "retained-origin-sibling")
        add(registry, sibling)
        registry.setAccessOrigin(sibling.stableId, application.origin)
        val storage = Storage()
        storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
        val drain = CompletableDeferred<Unit>()
        var ordinary = false
        val owner =
          GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, { drain.await() }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ ->
            client { !ordinary && it.header("Cf-Access-Token") == null }
          })
        assertNotNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
        val stopped = checkNotNull(owner.signOut(endpoint.stableId))
        try {
          runCurrent()
          assertEquals("Signing out…", checkNotNull(owner.presentation.value.attention).message)
          when (change) {
            "forget" -> {
              owner.forget(endpoint.stableId)
            }

            "ordinary" -> {
              ordinary = true
              assertNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
            }

            "association" -> {
              registry.setAccessOrigin(endpoint.stableId, CloudflareAccessOrigin.from("https://replacement.example.test"))
            }
          }
          runCurrent()
          assertNull(owner.presentation.value.attention)
          drain.complete(Unit)
          stopped.await()
          runCurrent()
          assertNull(owner.presentation.value.attention)
          assertNull(storage.values[application.origin])
        } finally {
          drain.complete(Unit)
        }
      }
    }

  @Test fun signOutRevokesBeforeItsAttentionCollectorCanFinishCachedAdmission() =
    runTest {
      val storage = Storage()
      storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
      val retirement = CompletableDeferred<Unit>()
      val release = CompletableDeferred<Unit>()
      val entered = CompletableDeferred<Unit>()
      val ownerScope = OwnedTestScope(UnconfinedTestDispatcher(testScheduler))
      var holdProbe = false
      var pending: Deferred<Result<GatewayIngressAuthorization?>>? = null
      var observer: Job? = null
      try {
        val owner =
          GatewayIngressController(ownerScope, registry(), storage.persistence, { emptyMap() }, { retirement.await() }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ ->
            client {
              if (it.header("Cf-Access-Token") == null) {
                true
              } else {
                if (holdProbe) {
                  entered.complete(Unit)
                  release.await()
                }
                false
              }
            }
          })
        val old = checkNotNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
        holdProbe = true
        val checkpoint = owner.admissionCheckpoint()
        val caller = async(UnconfinedTestDispatcher(testScheduler)) { runCatching { owner.prepare(endpoint, tls, false, checkpoint) { true } } }
        pending = caller
        assertTrue(entered.isCompleted)
        assertFalse(caller.isCompleted)
        observer =
          ownerScope.launch {
            owner.presentation.collect { presentation ->
              if (presentation.attention?.message == "Signing out…") release.complete(Unit)
            }
          }
        val stopped = checkNotNull(owner.signOut(endpoint.stableId))
        assertTrue(caller.await().exceptionOrNull() is CancellationException)
        assertEquals("Signing out…", checkNotNull(owner.presentation.value.attention).message)
        assertTrue(runCatching { old.requireCurrent(Request.Builder().url(application.origin.uri.toString()).build()) }.exceptionOrNull() is GatewayExternalAuthorizationException)
        retirement.complete(Unit)
        stopped.await()
      } finally {
        ownerScope.close({ listOfNotNull(observer, pending).asSequence() }) {
          release.complete(Unit)
          retirement.complete(Unit)
        }
      }
    }

  @Test fun signOutRetiresBrowserStartedWhileWaitingForTheStoreMonitor() =
    runTest {
      val registry = registry()
      registry.setAccessOrigin(endpoint.stableId, application.origin)
      val storage = Storage()
      val gateOrigin = CloudflareAccessOrigin.from("https://monitor.example.test")
      val grant = CompletableDeferred<CloudflareAccessSession>()
      val stopped = CompletableDeferred<Deferred<Unit>>()
      val uncaught = ConcurrentLinkedQueue<Throwable>()
      val ownerScope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher(testScheduler) + CoroutineExceptionHandler { _, error -> uncaught += error })
      lateinit var owner: GatewayIngressController
      lateinit var pending: Deferred<Result<GatewayIngressAuthorization?>>
      var launch: GatewayAccessBrowserLaunch? = null
      var gateFailure: Throwable? = null
      val worker =
        Thread({
          try {
            stopped.complete(checkNotNull(owner.signOut(endpoint.stableId)))
          } catch (error: Throwable) {
            stopped.completeExceptionally(error)
          }
        }, "access-sign-out-test").apply { isDaemon = true }
      val persistence =
        CloudflareAccessSessionStore.Persistence(
          load = { origin ->
            if (origin == gateOrigin) {
              try {
                worker.start()
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                while (worker.state != Thread.State.BLOCKED || worker.stackTrace.none { it.className == CloudflareAccessSessionStore::class.java.name && it.methodName == "forget" }) {
                  check(worker.isAlive && System.nanoTime() < deadline) { "Sign out did not reach the held store monitor" }
                  Thread.sleep(1)
                }
                pending = ownerScope.async { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } } }
                launch = checkNotNull(owner.presentation.value.browserLaunch)
                check(!pending.isCompleted)
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
        GatewayIngressController(ownerScope, registry, persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
          open("https://example.cloudflareaccess.com/login")
          grant.await()
        })
      try {
        val store =
          GatewayIngressController::class.java
            .getDeclaredField("store")
            .apply { isAccessible = true }
            .get(owner) as CloudflareAccessSessionStore
        // The unrelated load holds the real monitor while this thread reentrantly
        // starts the browser. Join only after snapshot has released that monitor.
        store.snapshot(gateOrigin)
        worker.join(5000)
        assertFalse("Sign out worker did not finish", worker.isAlive)
        gateFailure?.let { throw it }
        stopped.await().await()
        assertTrue(pending.await().exceptionOrNull() is CancellationException)
        assertNull(owner.consumeBrowserLaunch(checkNotNull(launch).attemptId))
        assertNull(owner.presentation.value.browserLaunch)
        val attention = checkNotNull(owner.presentation.value.attention)
        assertEquals(endpoint.stableId, attention.stableId)
        assertNull(attention.attemptId)
        assertTrue(attention.message.contains("signed out"))
      } finally {
        worker.join(5000)
        ownerScope.cancel()
        runCurrent()
        assertFalse("Sign out worker leaked", worker.isAlive)
        assertTrue(uncaught.isEmpty())
      }
    }

  @Test fun signOutPreservesPostRevocationBrowserAdmissionAndExpiry() =
    runTest {
      for (completeImmediately in listOf(false, true)) {
        val registry = registry()
        val storage = Storage()
        var now = System.currentTimeMillis() / 1000.0
        storage.values[application.origin] = CloudflareAccessTestTokens.session(expires = now + 100).encode()
        val grant = CompletableDeferred<CloudflareAccessSession>()
        if (completeImmediately) grant.complete(CloudflareAccessTestTokens.session("fresh", now + 1))
        val uncaught = mutableListOf<Throwable>()
        val ownerScope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher(testScheduler) + CoroutineExceptionHandler { _, error -> uncaught += error })
        lateinit var owner: GatewayIngressController
        lateinit var fresh: Deferred<GatewayIngressAuthorization?>
        var retirements = 0
        owner =
          GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, {
            if (++retirements == 1) {
              fresh = ownerScope.async { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } }
            }
          }, now = { now }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
            open("https://example.cloudflareaccess.com/login")
            grant.await()
          })
        try {
          val old = checkNotNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
          val stopped = checkNotNull(owner.signOut(endpoint.stableId))
          if (completeImmediately) {
            assertTrue("Fresh admission must finish before Sign out returns", fresh.isCompleted)
          } else {
            assertNotNull("Fresh browser must start before Sign out returns", owner.presentation.value.browserLaunch)
          }
          stopped.await()
          runCurrent()
          val request = Request.Builder().url(application.origin.uri.toString()).build()
          assertTrue(runCatching { old.requireCurrent(request) }.exceptionOrNull() is GatewayExternalAuthorizationException)
          if (!completeImmediately) {
            val launch = checkNotNull(owner.presentation.value.browserLaunch)
            assertEquals(
              launch.attemptId,
              owner.presentation.value.attention
                ?.attemptId,
            )
            assertFalse(fresh.isCompleted)
            grant.complete(CloudflareAccessTestTokens.session("fresh", now + 1))
          }
          val current = checkNotNull(fresh.await())
          current.requireCurrent(request)
          assertNull(owner.presentation.value.attention)
          assertNull(owner.presentation.value.browserLaunch)
          assertEquals("fresh", CloudflareAccessSession.decode(checkNotNull(storage.values[application.origin])).subject)
          assertEquals(2, retirements)
          now += 2
          advanceTimeBy(1001)
          runCurrent()
          assertEquals(3, retirements)
          assertTrue(runCatching { current.requireCurrent(request) }.exceptionOrNull() is GatewayExternalAuthorizationException)
          assertNotNull(owner.presentation.value.attention)
        } finally {
          ownerScope.cancel()
          runCurrent()
          assertTrue(uncaught.isEmpty())
        }
      }
    }

  @Test fun ordinaryReadmissionDropsOldManagedCapabilityAndReconnectBlock() =
    runTest {
      val registry = registry()
      val storage = Storage()
      storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
      var ordinary = false
      val owner =
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ ->
          client { !ordinary && it.header("Cf-Access-Token") == null }
        })
      val old = checkNotNull(owner.prepare(endpoint, tls, false, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      assertTrue(endpoint.stableId in owner.presentation.value.browserRequired)
      owner.signOut(endpoint.stableId)?.await()
      assertTrue(owner.blocksAutomaticReconnect(endpoint.stableId))
      ordinary = true
      assertNull(owner.prepare(endpoint, tls, true, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      assertNull(owner.authorization(endpoint))
      assertFalse(owner.blocksAutomaticReconnect(endpoint.stableId))
      assertFalse(endpoint.stableId in owner.presentation.value.browserRequired)
      assertNotNull(
        registry.entries.value
          .single()
          .accessOrigin,
      )
      assertFalse(owner.needsEmbeddedBrowserSignIn(endpoint.stableId))
      assertTrue(runCatching { old.requireCurrent(Request.Builder().url(application.origin.uri.toString()).build()) }.isFailure)
    }

  @Test fun ordinaryOriginChangeRetiresOnlyThePreviousOriginsLastOwner() =
    runTest {
      for (hasSibling in listOf(false, true)) {
        val registry = registry()
        val storage = Storage()
        storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
        registry.setAccessOrigin(endpoint.stableId, application.origin)
        if (hasSibling) {
          val sibling = endpoint.copy(stableId = "old-origin-sibling")
          add(registry, sibling)
          registry.setAccessOrigin(sibling.stableId, application.origin)
        }
        val replacement = endpoint.copy(host = "ordinary.example.test")
        add(registry, replacement)
        val owner = GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client { false } })
        assertNull(owner.prepare(replacement, tls, false, admissionCheckpoint = owner.admissionCheckpoint()) { true })
        assertAccessOrigin(null, registry, endpoint.stableId)
        assertEquals(hasSibling, application.origin in storage.values)
        owner.forget(endpoint.stableId)
        assertEquals(hasSibling, application.origin in storage.values)
      }
    }

  @Test fun originChangeKeepsItsDurableOwnerThroughFailureAndReconstruction() =
    runTest {
      for (failure in listOf("drain", "delete", "interruption")) {
        val context = RuntimeEnvironment.getApplication()
        val preferences = context.getSharedPreferences("access-retirement-${UUID.randomUUID()}", Context.MODE_PRIVATE)

        fun restoredRegistry() = GatewayRegistryStore(SecurePrefs(context, preferences))
        val registry = restoredRegistry().also { add(it, endpoint) }
        registry.setAccessOrigin(endpoint.stableId, application.origin)
        val replacement = endpoint.copy(host = "replacement.example.test")
        add(registry, replacement)
        val storage = Storage()
        val encoded = CloudflareAccessTestTokens.session().encode()
        storage.values[application.origin] = encoded
        storage.deleteSucceeds = failure != "delete"
        val release = CompletableDeferred<Unit>()
        val uncaught = mutableListOf<Throwable>()
        val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler) + CoroutineExceptionHandler { _, error -> uncaught += error })
        var entered = false
        var probes = 0
        val owner =
          GatewayIngressController(scope, registry, storage.persistence, { emptyMap() }, {
            entered = true
            release.await()
            if (failure == "drain") throw java.io.IOException("Old origin drain failed")
          }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ ->
            client {
              probes++
              false
            }
          })
        try {
          val pending = async { runCatching { owner.prepare(replacement, tls, false, owner.admissionCheckpoint()) { true } } }
          runCurrent()
          assertTrue(entered)
          assertSingleAccessOrigin(application.origin.uri.toString(), restoredRegistry())
          assertEquals(encoded, storage.values[application.origin])
          assertEquals(0, probes)
          if (failure == "interruption") scope.cancel() else release.complete(Unit)
          runCurrent()
          val error = pending.await().exceptionOrNull()
          when (failure) {
            "drain" -> assertTrue(error is java.io.IOException)
            "delete" -> assertTrue(error is CloudflareAccessException)
            else -> assertTrue(error is CancellationException)
          }
          assertSingleAccessOrigin(application.origin.uri.toString(), restoredRegistry())
          assertEquals(encoded, storage.values[application.origin])
          assertEquals(0, probes)

          // Rebuild from persisted ownership, without the failed controller's registrations.
          // A valid encoded grant must remain discoverable for a later cleanup attempt.
          scope.cancel()
          runCurrent()
          storage.deleteSucceeds = true
          val restoredStore = CloudflareAccessSessionStore(backgroundScope, storage.persistence, retireTransports = {})
          assertNotNull(restoredStore.snapshot(application.origin))
          val coldRegistry = restoredRegistry()
          val retired = mutableListOf<CloudflareAccessOrigin>()
          val cold = GatewayIngressController(backgroundScope, coldRegistry, storage.persistence, { emptyMap() }, { retired += it }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client { false } })
          if (failure == "delete") {
            cold.forget(endpoint.stableId)
            assertTrue(coldRegistry.remove(endpoint.stableId))
          } else {
            assertNull(cold.prepare(replacement, tls, false, cold.admissionCheckpoint()) { true })
            assertSingleAccessOrigin(null, restoredRegistry())
          }
          assertEquals(listOf(application.origin), retired)
          assertNull(storage.values[application.origin])
          assertTrue(uncaught.isEmpty())
        } finally {
          release.complete(Unit)
          scope.cancel()
          runCurrent()
        }
      }
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

  @Test fun concurrentProfilesUseOneBrowserAndEachRetainsOwnership() =
    runTest {
      val registry = registry()
      val sibling = endpoint.copy(stableId = "discovered-sibling", contextPath = "/mcp")
      add(registry, sibling)
      val storage = Storage()
      val grant = CompletableDeferred<CloudflareAccessSession>()
      var prompts = 0
      val owner =
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
          prompts++
          open("https://example.cloudflareaccess.com/login")
          grant.await()
        })
      val first = async { owner.prepare(endpoint, tls, true, admissionCheckpoint = owner.admissionCheckpoint()) { true } }
      runCurrent()
      val launch = checkNotNull(owner.presentation.value.browserLaunch)
      assertNotNull(owner.consumeBrowserLaunch(launch.attemptId))
      assertNull(owner.consumeBrowserLaunch(launch.attemptId))
      val second = async { owner.prepare(sibling, tls.copy(stableId = sibling.stableId), true, admissionCheckpoint = owner.admissionCheckpoint()) { true } }
      runCurrent()
      advanceTimeBy(21_000)
      runCurrent()
      assertEquals(1, prompts)
      assertFalse(first.isCompleted)
      assertNull(owner.presentation.value.browserLaunch)
      grant.complete(CloudflareAccessTestTokens.session())
      assertNotNull(first.await())
      assertNotNull(second.await())
      assertEquals(
        setOf(application.origin.uri.toString()),
        registry.entries.value
          .map { it.accessOrigin }
          .toSet(),
      )
      assertNull(owner.presentation.value.attention)
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

  @Test fun forgettingPendingProfileClearsItsActionAndPreservesSharedGrant() =
    runTest {
      val registry = registry()
      val sibling = endpoint.copy(stableId = "shared-origin-sibling")
      add(registry, sibling)
      registry.setAccessOrigin(sibling.stableId, application.origin)
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
      var resumeOnClear = false
      var resumedDuringClear = false
      backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
        owner.presentation.collect { presentation ->
          val it = presentation.attention
          if (resumeOnClear && it == null) {
            resumeOnClear = false
            resumedDuringClear = true
            waiter.resumeImmediately()
          }
        }
      }
      try {
        grant.complete(CloudflareAccessTestTokens.session())
        runCurrent()
        val persisted = checkNotNull(storage.values[application.origin])
        assertFalse(pending.isCompleted)
        resumeOnClear = true
        owner.forget(endpoint.stableId)
        assertTrue(resumedDuringClear)
        assertTrue(pending.isCompleted)
        registry.remove(endpoint.stableId)
        assertNull(owner.consumeBrowserLaunch(id))
        assertNull(owner.presentation.value.attention)
        assertEquals(persisted, storage.values[application.origin])
        assertSingleAccessOrigin(application.origin.uri.toString(), registry)
      } finally {
        waiter.resume()
      }
      runCurrent()
      assertTrue(pending.await().exceptionOrNull() is CancellationException)
      assertNotNull(owner.prepare(sibling, tls.copy(stableId = sibling.stableId), false, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      assertNull(owner.presentation.value.attention)
      assertNull(owner.presentation.value.browserLaunch)
    }

  @Test fun associationObserverCannotPublishRequiredForForgottenOrRevokedAction() =
    runTest {
      for (forget in listOf(true, false)) {
        val registry = registry()
        val sibling = endpoint.copy(stableId = "association-sibling")
        add(registry, sibling)
        registry.setAccessOrigin(sibling.stableId, application.origin)
        val owner = GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() })
        var armed = true
        var observed = false
        val observer =
          backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            registry.entries.collect { entries ->
              if (armed && entries.any { it.stableId == endpoint.stableId && it.accessOrigin != null }) {
                armed = false
                observed = true
                if (forget) {
                  owner.forget(endpoint.stableId)
                  registry.remove(endpoint.stableId)
                } else {
                  owner.signOut(endpoint.stableId)
                }
              }
            }
          }
        val result = runCatching { owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true } }
        assertTrue(observed)
        assertTrue(result.exceptionOrNull() is CancellationException)
        assertNull(owner.presentation.value.browserLaunch)
        runCurrent()
        if (forget) assertNull(owner.presentation.value.attention) else assertTrue(checkNotNull(owner.presentation.value.attention).message.contains("signed out"))
        observer.cancel()
      }
    }

  @Test fun pendingPresentationIsAtomicWhenObserverCancelsOrForgets() =
    runTest {
      for (forget in listOf(false, true)) {
        val registry = registry()
        val sibling = endpoint.copy(stableId = "presentation-sibling")
        add(registry, sibling)
        registry.setAccessOrigin(sibling.stableId, application.origin)
        val owner =
          GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
            open("https://example.cloudflareaccess.com/login")
            CompletableDeferred<CloudflareAccessSession>().await()
          })
        var observed = false
        val observer =
          backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            owner.presentation.collect { state ->
              state.browserLaunch?.let { assertEquals(it.attemptId, state.attention?.attemptId) }
              val id = state.attention?.attemptId
              if (!observed && id != null) {
                observed = true
                assertEquals(id, state.browserLaunch?.attemptId)
                if (forget) {
                  owner.forget(endpoint.stableId)
                  registry.remove(endpoint.stableId)
                } else {
                  owner.cancel(id)
                }
              }
            }
          }
        val pending = async { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } } }
        runCurrent()
        assertTrue(observed)
        assertTrue(pending.await().exceptionOrNull() is CancellationException)
        assertNull(owner.presentation.value.browserLaunch)
        assertNull(
          owner.presentation.value.attention
            ?.attemptId,
        )
        if (forget) assertNull(owner.presentation.value.attention)
        observer.cancel()
      }
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

  @Test fun nestedSignOutKeepsTheNewerProfilesPresentation() =
    runTest {
      val registry = registry()
      val sibling = endpoint.copy(stableId = "nested-sign-out")
      add(registry, sibling)
      val storage = Storage()
      storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
      val uncaught = mutableListOf<Throwable>()
      val ownerScope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher(testScheduler) + CoroutineExceptionHandler { _, error -> uncaught += error })
      lateinit var owner: GatewayIngressController
      var nested = false
      owner =
        GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, {
          if (!nested) {
            nested = true
            owner.signOut(sibling.stableId)
          }
        }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() })
      try {
        owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true }
        owner.prepare(sibling, tls.copy(stableId = sibling.stableId), false, owner.admissionCheckpoint()) { true }
        checkNotNull(owner.signOut(endpoint.stableId)).await()
        runCurrent()
        assertTrue(nested)
        assertAttentionProfile(sibling.stableId, owner)
        assertTrue(checkNotNull(owner.presentation.value.attention).message.contains("signed out"))
        assertNull(owner.presentation.value.browserLaunch)
      } finally {
        ownerScope.cancel()
        runCurrent()
        assertTrue(uncaught.isEmpty())
      }
    }

  @Test fun retryFailureRemainsOwnedByItsOriginalAction() =
    runTest {
      for (retirement in listOf("forget", "replacement", "sign-out", "caller")) {
        val registry = registry()
        val owner = GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() })
        assertTrue(runCatching { owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true } }.exceptionOrNull() is GatewayExternalAuthorizationException)
        var current = true
        val reporter = checkNotNull(owner.retry(owner.admissionCheckpoint()) { current })
        when (retirement) {
          "forget" -> {
            owner.forget(endpoint.stableId)
            registry.remove(endpoint.stableId)
          }

          "replacement" -> {
            runCatching { owner.prepare(endpoint.copy(name = "New registration"), tls, false, owner.admissionCheckpoint()) { true } }
          }

          "sign-out" -> {
            checkNotNull(owner.signOut(endpoint.stableId)).await()
          }

          "caller" -> {
            current = false
          }
        }
        val expected = owner.presentation.value
        reporter.reportFailure("Old retry failed")
        assertEquals(expected, owner.presentation.value)
      }
      val registry = registry()
      registry.setAccessOrigin(endpoint.stableId, application.origin)
      val owner =
        GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
          open("https://example.cloudflareaccess.com/login")
          CompletableDeferred<CloudflareAccessSession>().await()
        })
      checkNotNull(owner.signOut(endpoint.stableId)).await()
      checkNotNull(owner.retry(owner.admissionCheckpoint()) { true }).reportFailure("Saved endpoint unavailable")
      assertAttentionMessage("Saved endpoint unavailable", owner)
      val reporter = checkNotNull(owner.retry(owner.admissionCheckpoint()) { true })
      val prepared = async { runCatching { reporter.prepare(endpoint, tls) } }
      runCurrent()
      owner.cancel(
        checkNotNull(
          owner.presentation.value.attention
            ?.attemptId,
        ),
      )
      runCurrent()
      assertTrue(prepared.await().exceptionOrNull() is CancellationException)
      reporter.reportFailure("Current retry failed")
      assertAttentionMessage("Current retry failed", owner)
    }

  @Test fun queuedRetryOwnsPendingSignOutPresentationBeforeAdmission() =
    runTest {
      for (registered in listOf(false, true)) {
        for (deleteSucceeds in listOf(false, true)) {
          for (next in listOf("prepare", "sign-out", "caller-before-ack", "caller-after-ack")) {
            val registry = registry()
            registry.setAccessOrigin(endpoint.stableId, application.origin)
            val storage = Storage()
            val encoded = CloudflareAccessTestTokens.session().encode()
            storage.values[application.origin] = encoded
            val drain = CompletableDeferred<Unit>()
            val approved = CompletableDeferred<CloudflareAccessSession>()
            val supervisor = SupervisorJob()
            val uncaught = mutableListOf<Throwable>()
            val ownerScope = CoroutineScope(supervisor + StandardTestDispatcher(testScheduler) + CoroutineExceptionHandler { _, error -> uncaught.add(error) })
            val owner =
              GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, { drain.await() }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
                open("https://example.cloudflareaccess.com/login")
                approved.await()
              })
            var preparing: Deferred<Result<GatewayIngressAuthorization?>>? = null
            try {
              if (registered) assertNotNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
              storage.deleteSucceeds = deleteSucceeds
              val stopped = checkNotNull(owner.signOut(endpoint.stableId))
              runCurrent()
              assertFalse(stopped.isCompleted)
              val captured = checkNotNull(owner.presentation.value.attention)
              assertEquals("Signing out…", captured.message)
              var current = true
              val queued = checkNotNull(owner.retry(owner.admissionCheckpoint()) { current })
              if (next == "caller-before-ack") current = false
              drain.complete(Unit)
              val failure = runCatching { stopped.await() }.exceptionOrNull()
              if (deleteSucceeds) assertNull(failure) else assertEquals(CloudflareAccessException.Kind.StorageFailed, (failure as? CloudflareAccessException)?.kind)
              runCurrent()
              assertEquals(if (deleteSucceeds) null else encoded, storage.values[application.origin])
              val completed = checkNotNull(owner.presentation.value.attention)
              assertFalse(captured === completed)
              assertTrue(completed.message.contains(if (deleteSucceeds) "is signed out" else "Try Sign out again"))
              storage.deleteSucceeds = true
              if (next == "caller-after-ack") current = false
              if (next == "sign-out") {
                checkNotNull(owner.signOut(endpoint.stableId)).await()
                runCurrent()
              }
              val beforePrepare = owner.presentation.value
              preparing = ownerScope.async { runCatching { queued.prepare(endpoint, tls) } }
              runCurrent()
              if (next != "prepare") {
                assertTrue(preparing.await().exceptionOrNull() is CancellationException)
                assertEquals(beforePrepare, owner.presentation.value)
                assertNull(owner.presentation.value.browserLaunch)
              } else {
                val launch = checkNotNull(owner.presentation.value.browserLaunch)
                assertEquals("https://example.cloudflareaccess.com/login", owner.consumeBrowserLaunch(launch.attemptId))
                assertFalse(preparing.isCompleted)
                approved.complete(CloudflareAccessTestTokens.session("queued-retry"))
                assertNotNull(preparing.await().getOrThrow())
                assertNull(owner.presentation.value.attention)
                assertNotNull(storage.values[application.origin])
              }
            } finally {
              drain.complete(Unit)
              preparing?.cancelAndJoin()
              supervisor.cancelAndJoin()
              assertTrue(uncaught.isEmpty())
            }
          }
        }
      }
    }

  @Test fun capturedRetryCanAcquireDuringSignOutCompletionPublication() =
    runTest {
      val registry = registry()
      registry.setAccessOrigin(endpoint.stableId, application.origin)
      val drain = CompletableDeferred<Unit>()
      val approved = CompletableDeferred<CloudflareAccessSession>()
      val owner =
        GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, { drain.await() }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
          open("https://example.cloudflareaccess.com/login")
          approved.await()
        })
      val stopped = checkNotNull(owner.signOut(endpoint.stableId))
      runCurrent()
      val queued = checkNotNull(owner.retry(owner.admissionCheckpoint()) { true })
      var preparing: Deferred<Result<GatewayIngressAuthorization?>>? = null
      val observer =
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
          owner.presentation.collect { value ->
            if (preparing == null && value.attention?.message?.contains("is signed out") == true) {
              preparing = async(start = CoroutineStart.UNDISPATCHED) { runCatching { queued.prepare(endpoint, tls) } }
            }
          }
        }
      try {
        drain.complete(Unit)
        stopped.await()
        runCurrent()
        assertNotNull(owner.presentation.value.browserLaunch)
        approved.complete(CloudflareAccessTestTokens.session("reentrant-retry"))
        assertNotNull(checkNotNull(preparing).await().getOrThrow())
        assertNull(owner.presentation.value.attention)
      } finally {
        drain.complete(Unit)
        preparing?.cancelAndJoin()
        observer.cancelAndJoin()
      }
    }

  @Test fun queuedColdRetryCannotEraseASecondSignOut() =
    runTest {
      for (duringAcquisition in listOf(false, true)) {
        val registry = registry()
        val sibling = endpoint.copy(stableId = "ordinary-retry-sibling")
        add(registry, sibling)
        registry.setAccessOrigin(endpoint.stableId, application.origin)
        var probes = 0
        val owner =
          GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ ->
            client {
              probes++
              target.stableId != sibling.stableId
            }
          })
        checkNotNull(owner.signOut(endpoint.stableId)).await()
        val checkpoint = owner.admissionCheckpoint()
        var predicateCalls = 0
        var second: Deferred<Unit>? = null
        var signedOut: GatewayAccessPresentation? = null
        val queued =
          checkNotNull(
            owner.retry(checkpoint) {
              // register checks the caller once before the Retry ownership callback.
              if (duringAcquisition && ++predicateCalls == 2) {
                second = checkNotNull(owner.signOut(endpoint.stableId))
                signedOut = owner.presentation.value
              }
              true
            },
          )
        if (!duringAcquisition) {
          second = checkNotNull(owner.signOut(endpoint.stableId))
          checkNotNull(second).await()
          signedOut = owner.presentation.value
        }
        assertTrue(runCatching { queued.prepare(endpoint, tls) }.exceptionOrNull() is CancellationException)
        assertNotNull(second)
        if (duringAcquisition) assertEquals(2, predicateCalls)
        assertSame(checkNotNull(signedOut), owner.presentation.value)
        assertEquals(0, probes)
        assertNull(owner.presentation.value.browserLaunch)
        checkNotNull(second).await()
        runCurrent()
        val completed = owner.presentation.value
        assertTrue(checkNotNull(completed.attention).message.contains("is signed out"))
        assertNull(owner.prepare(sibling, tls.copy(stableId = sibling.stableId), false, checkpoint) { true })
        assertEquals(completed.attention, owner.presentation.value.attention)
      }
    }

  @Test fun retryAcquisitionRejectsReplacementButCanReplaceItsOwnRegistration() =
    runTest {
      val registry = registry()
      val owner =
        GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
          open("https://example.cloudflareaccess.com/login")
          CompletableDeferred<CloudflareAccessSession>().await()
        })
      assertTrue(runCatching { owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true } }.exceptionOrNull() is GatewayExternalAuthorizationException)
      val stale = checkNotNull(owner.retry(owner.admissionCheckpoint()) { true })
      val replacement = endpoint.copy(name = "Replacement owner")
      val pending = async { runCatching { owner.prepare(replacement, tls, true, owner.admissionCheckpoint()) { true } } }
      runCurrent()
      val current = owner.presentation.value
      val launch = checkNotNull(current.browserLaunch)
      assertTrue(runCatching { stale.prepare(endpoint, tls) }.exceptionOrNull() is CancellationException)
      assertEquals(current, owner.presentation.value)
      assertEquals(launch.url, owner.consumeBrowserLaunch(launch.attemptId))
      owner.cancel(launch.attemptId)
      runCurrent()
      assertTrue(pending.await().exceptionOrNull() is CancellationException)
      val legitimate = checkNotNull(owner.retry(owner.admissionCheckpoint()) { true })
      val ownReplacement = async { runCatching { legitimate.prepare(replacement.copy(name = "Resolved own route"), tls) } }
      runCurrent()
      val ownLaunch = checkNotNull(owner.presentation.value.browserLaunch)
      assertFalse(launch.attemptId == ownLaunch.attemptId)
      owner.cancel(ownLaunch.attemptId)
      runCurrent()
      assertTrue(ownReplacement.await().exceptionOrNull() is CancellationException)
    }

  @Test fun retryOriginChangeReportsRawFailureAndRemainsActionable() =
    runTest {
      val registry = registry()
      registry.setAccessOrigin(endpoint.stableId, application.origin)
      val replacement = endpoint.copy(host = "replacement.example.test")
      var fail = true
      val owner =
        GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ ->
          if (target.host == replacement.host) {
            CloudflareAccessClient { request, _, _ ->
              if (fail) throw java.io.IOException("Replacement discovery failed")
              CloudflareAccessClient.Reply(request.url.toString(), 200, Headers.Builder().build(), byteArrayOf())
            }
          } else {
            client()
          }
        })
      assertTrue(runCatching { owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true } }.exceptionOrNull() is GatewayExternalAuthorizationException)
      add(registry, replacement)
      val retry = checkNotNull(owner.retry(owner.admissionCheckpoint()) { true })
      val error = runCatching { retry.prepare(replacement, tls) }.exceptionOrNull()
      assertTrue(error is java.io.IOException)
      assertSingleAccessOrigin(null, registry)
      retry.reportFailure(checkNotNull(error).message!!)
      assertAttentionMessage("Replacement discovery failed", owner)
      val fresh = checkNotNull(owner.retry(owner.admissionCheckpoint()) { true })
      fail = false
      assertNull(fresh.prepare(replacement, tls))
      assertNull(owner.presentation.value.attention)
      assertNull(owner.presentation.value.browserLaunch)
      assertFalse(owner.blocksAutomaticReconnect(endpoint.stableId))
    }

  @Test fun acquiredRetryPreservesSignOutFromReentrantBrowserPredicates() =
    runTest {
      for (repeated in listOf(false, true)) {
        for (deleteSucceeds in listOf(false, true)) {
          val registry = registry()
          val other = endpoint.copy(stableId = "reentrant-retry", host = "retry.example.test")
          val otherTls = tls.copy(stableId = other.stableId)
          val otherApplication = application.copy(origin = CloudflareAccessOrigin.from("https://retry.example.test:8443"))
          add(registry, other)
          val storage = Storage()
          val grant = CompletableDeferred<CloudflareAccessSession>()
          val retirement = CompletableDeferred<Unit>()
          val retirementStarted = CompletableDeferred<Unit>()
          val pending = mutableListOf<Job>()
          val signOuts = mutableListOf<Deferred<Unit>>()
          val ownerScope = OwnedTestScope(StandardTestDispatcher(testScheduler))
          var ordinary = false
          var failProbe = false
          var signOutOnPredicate = false
          var acknowledgement: GatewayAccessPresentation? = null
          var authentication: Job? = null
          try {
            val owner =
              GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, { origin ->
                if (origin == otherApplication.origin) {
                  retirementStarted.complete(Unit)
                  retirement.await()
                }
              }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ ->
                if (target.stableId == other.stableId) {
                  client({ otherApplication }) { request ->
                    if (failProbe) throw java.io.IOException("Controlled Retry probe failure")
                    request.header("Cf-Access-Token") == null
                  }
                } else {
                  client { request -> !ordinary && request.header("Cf-Access-Token") == null }
                }
              }, authenticate = { _, open ->
                authentication = kotlin.coroutines.coroutineContext[Job]
                open("https://example.cloudflareaccess.com/login")
                grant.await()
              })
            val original =
              async {
                runCatching {
                  owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) {
                    if (signOutOnPredicate) {
                      signOutOnPredicate = false
                      signOuts += checkNotNull(owner.signOut(other.stableId))
                      acknowledgement = owner.presentation.value
                    }
                    true
                  }
                }
              }.also(pending::add)
            runCurrent()
            assertNotNull(owner.presentation.value.browserLaunch)
            ordinary = true
            assertNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
            assertFalse(original.isCompleted)
            assertTrue(checkNotNull(authentication).isActive)
            assertTrue(runCatching { owner.prepare(other, otherTls, false, owner.admissionCheckpoint()) { true } }.exceptionOrNull() is GatewayExternalAuthorizationException)
            runCurrent()
            storage.deleteSucceeds = deleteSucceeds
            if (repeated) {
              signOuts += checkNotNull(owner.signOut(other.stableId))
              runCurrent()
              assertTrue(retirementStarted.isCompleted)
            }
            val retry = checkNotNull(owner.retry(owner.admissionCheckpoint()) { true })
            failProbe = true
            assertTrue(runCatching { retry.prepare(other, otherTls) }.exceptionOrNull() is java.io.IOException)
            val before = owner.presentation.value
            signOutOnPredicate = true
            retry.reportFailure("Obsolete Retry failure")
            assertFalse(signOutOnPredicate)
            val pendingSignOut = checkNotNull(acknowledgement)
            assertSame(pendingSignOut, owner.presentation.value)
            assertEquals("Signing out…", checkNotNull(pendingSignOut.attention).message)
            assertEquals(other.stableId, pendingSignOut.attention.stableId)
            if (repeated) assertSame(before, pendingSignOut)
            runCurrent()
            assertTrue(retirementStarted.isCompleted)
            assertTrue(signOuts.all { !it.isCompleted })
            assertFalse(original.isCompleted)
            assertTrue(checkNotNull(authentication).isActive)
            retirement.complete(Unit)
            for (signedOut in signOuts) {
              val result = runCatching { signedOut.await() }
              if (deleteSucceeds) result.getOrThrow() else assertEquals(CloudflareAccessException.Kind.StorageFailed, (result.exceptionOrNull() as? CloudflareAccessException)?.kind)
            }
            runCurrent()
            assertEquals(List(if (repeated) 2 else 1) { otherApplication.origin }, storage.deleted)
            val completed = checkNotNull(owner.presentation.value.attention)
            assertEquals(other.stableId, completed.stableId)
            assertNull(completed.attemptId)
            assertTrue(completed.message.contains(if (deleteSucceeds) "is signed out" else "Try Sign out again"))
            assertTrue(owner.blocksAutomaticReconnect(other.stableId))
            assertNull(owner.presentation.value.browserLaunch)
          } finally {
            ownerScope.close({ pending.asSequence() + signOuts.asSequence() }) {
              retirement.complete(Unit)
              grant.cancel()
            }
          }
        }
      }
    }

  @Test fun failedOriginReplacementRetryKeepsThePersistedSignOutOwner() =
    runTest {
      for (next in listOf("same-profile-predicate", "ordinary-sibling-predicate", "before-report")) {
        for (deleteSucceeds in listOf(false, true)) {
          val registry = registry()
          val browserEndpoint = endpoint.copy(stableId = "persisted-retry-browser", host = "browser.example.test")
          val browserApplication = application.copy(origin = CloudflareAccessOrigin.from("https://browser.example.test:8443"))
          val replacement = endpoint.copy(host = "replacement.example.test")
          val sibling = endpoint.copy(stableId = "persisted-retry-ordinary-sibling")
          add(registry, browserEndpoint)
          val storage = Storage()
          val encoded = CloudflareAccessTestTokens.session().encode()
          storage.values[application.origin] = encoded
          val grant = CompletableDeferred<CloudflareAccessSession>()
          val retirement = CompletableDeferred<Unit>()
          val retirementStarted = CompletableDeferred<Unit>()
          val ownerScope = OwnedTestScope(StandardTestDispatcher(testScheduler))
          val pending = mutableListOf<Job>()
          val signOuts = mutableListOf<Deferred<Unit>>()
          var ordinary = false
          var holdRetirement = false
          var signOutOnPredicate = false
          var replacementProbes = 0
          var authentication: Job? = null
          var acknowledgement: GatewayAccessPresentation? = null
          lateinit var owner: GatewayIngressController

          fun signOutPersistedOwner() {
            val stableId = if (next == "ordinary-sibling-predicate") sibling.stableId else endpoint.stableId
            signOuts += checkNotNull(owner.signOut(stableId))
            acknowledgement = owner.presentation.value
          }
          try {
            owner =
              GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, { origin ->
                if (origin == application.origin && holdRetirement) {
                  retirementStarted.complete(Unit)
                  retirement.await()
                }
              }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ ->
                when (target.stableId) {
                  browserEndpoint.stableId -> {
                    client({ browserApplication }) { request -> !ordinary && request.header("Cf-Access-Token") == null }
                  }

                  sibling.stableId -> {
                    client { false }
                  }

                  else -> {
                    client { request ->
                      if (target.host == replacement.host) replacementProbes++
                      request.header("Cf-Access-Token") == null
                    }
                  }
                }
              }, authenticate = { _, open ->
                authentication = kotlin.coroutines.coroutineContext[Job]
                open("https://example.cloudflareaccess.com/login")
                grant.await()
              })
            val browser =
              async {
                runCatching {
                  owner.prepare(browserEndpoint, tls.copy(stableId = browserEndpoint.stableId), true, owner.admissionCheckpoint()) {
                    if (signOutOnPredicate) {
                      signOutOnPredicate = false
                      signOutPersistedOwner()
                    }
                    true
                  }
                }
              }.also(pending::add)
            runCurrent()
            assertNotNull(owner.presentation.value.browserLaunch)
            ordinary = true
            assertNull(owner.prepare(browserEndpoint, tls.copy(stableId = browserEndpoint.stableId), false, owner.admissionCheckpoint()) { true })
            assertNotNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
            storage.deleteSucceeds = false
            val initial = checkNotNull(owner.signOut(endpoint.stableId)).also(signOuts::add)
            assertEquals(CloudflareAccessException.Kind.StorageFailed, (runCatching { initial.await() }.exceptionOrNull() as? CloudflareAccessException)?.kind)
            runCurrent()
            add(registry, replacement)
            val legitimate = checkNotNull(owner.retry(owner.admissionCheckpoint()) { true })
            assertEquals(CloudflareAccessException.Kind.StorageFailed, (runCatching { legitimate.prepare(replacement, tls) }.exceptionOrNull() as? CloudflareAccessException)?.kind)
            assertAccessOrigin(application.origin.uri.toString(), registry, endpoint.stableId)
            assertEquals(encoded, storage.values[application.origin])
            assertEquals(0, replacementProbes)
            legitimate.reportFailure("Old origin deletion failed")
            assertAttentionMessage("Old origin deletion failed", owner)

            // Acquire a Retry from this acknowledgement. Its failed departure supersedes
            // retirement, while the saved old origin and equal pending action remain owned.
            val pendingSignOut = checkNotNull(owner.signOut(endpoint.stableId)).also(signOuts::add)
            val retry = checkNotNull(owner.retry(owner.admissionCheckpoint()) { true })
            assertEquals(CloudflareAccessException.Kind.StorageFailed, (runCatching { retry.prepare(replacement, tls) }.exceptionOrNull() as? CloudflareAccessException)?.kind)
            assertEquals(CloudflareAccessException.Kind.StorageFailed, (runCatching { pendingSignOut.await() }.exceptionOrNull() as? CloudflareAccessException)?.kind)
            runCurrent()
            assertAttentionMessage("Signing out…", owner)
            assertAccessOrigin(application.origin.uri.toString(), registry, endpoint.stableId)
            assertEquals(encoded, storage.values[application.origin])
            assertEquals(0, replacementProbes)
            if (next == "ordinary-sibling-predicate") {
              // Adding the sibling earlier would take the shared-association fast path.
              add(registry, sibling)
              registry.setAccessOrigin(sibling.stableId, application.origin)
              assertNull(owner.prepare(sibling, tls.copy(stableId = sibling.stableId), false, owner.admissionCheckpoint()) { true })
              runCurrent()
            }
            val before = owner.presentation.value
            assertEquals(endpoint.stableId, before.attention?.stableId)
            holdRetirement = true
            storage.deleteSucceeds = deleteSucceeds
            if (next == "before-report") signOutPersistedOwner() else signOutOnPredicate = true
            retry.reportFailure("Obsolete replacement Retry failure")
            assertFalse(signOutOnPredicate)
            assertSame(before, checkNotNull(acknowledgement))
            assertSame(before, owner.presentation.value)
            runCurrent()
            assertTrue(retirementStarted.isCompleted)
            assertFalse(signOuts.last().isCompleted)
            assertFalse(browser.isCompleted)
            assertTrue(checkNotNull(authentication).isActive)
            retirement.complete(Unit)
            val result = runCatching { signOuts.last().await() }
            if (deleteSucceeds) result.getOrThrow() else assertEquals(CloudflareAccessException.Kind.StorageFailed, (result.exceptionOrNull() as? CloudflareAccessException)?.kind)
            runCurrent()
            assertEquals(List(5) { application.origin }, storage.deleted)
            assertEquals(if (deleteSucceeds) null else encoded, storage.values[application.origin])
            val completed = checkNotNull(owner.presentation.value.attention)
            assertEquals(endpoint.stableId, completed.stableId)
            assertNull(completed.attemptId)
            assertTrue(completed.message.contains(if (deleteSucceeds) "is signed out" else "Try Sign out again"))
            assertNull(owner.presentation.value.browserLaunch)
          } finally {
            ownerScope.close({ pending.asSequence() + signOuts.asSequence() }) {
              retirement.complete(Unit)
              grant.cancel()
            }
          }
        }
      }
    }

  @Test fun interruptedOriginReplacementForgetsThePersistedOwnerOnly() =
    runTest {
      for (scenario in listOf("last-owner", "sibling", "repeat-sign-out")) {
        val hasSibling = scenario == "sibling"
        val registry = registry()
        val sibling = endpoint.copy(stableId = "persisted-origin-sibling")
        if (hasSibling) {
          add(registry, sibling)
          registry.setAccessOrigin(sibling.stableId, application.origin)
        }
        val storage = Storage()
        val grant = CompletableDeferred<CloudflareAccessSession>()
        val waiter = PausingDispatcher(StandardTestDispatcher(testScheduler))
        val owner =
          GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
            open("https://example.cloudflareaccess.com/login")
            grant.await()
          })
        val first = async(waiter) { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } } }
        runCurrent()
        waiter.paused = true
        grant.complete(CloudflareAccessTestTokens.session())
        runCurrent()
        val persisted = checkNotNull(storage.values[application.origin])
        var replacementCurrent = true
        var interrupted = false
        val observer =
          backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            owner.presentation.collect { state ->
              if (state.attention == null && state.browserLaunch == null) {
                interrupted = true
                replacementCurrent = false
              }
            }
          }
        try {
          val replacement = endpoint.copy(host = "interrupted.example.test")
          add(registry, replacement)
          val result = runCatching { owner.prepare(replacement, tls, false, owner.admissionCheckpoint()) { replacementCurrent } }
          assertTrue(interrupted)
          assertTrue(result.exceptionOrNull() is CancellationException)
          assertAccessOrigin(application.origin.uri.toString(), registry, endpoint.stableId)
          if (scenario == "repeat-sign-out") {
            checkNotNull(owner.signOut(endpoint.stableId)).await()
            runCurrent()
            val queued = checkNotNull(owner.retry(owner.admissionCheckpoint()) { true })
            val previousSignedOut = owner.presentation.value
            checkNotNull(owner.signOut(endpoint.stableId)).await()
            runCurrent()
            val signedOut = owner.presentation.value
            assertEquals(previousSignedOut, signedOut)
            val stale = runCatching { queued.prepare(replacement, tls) }
            assertTrue(stale.exceptionOrNull() is CancellationException)
            assertTrue(signedOut === owner.presentation.value)
            assertAccessOrigin(application.origin.uri.toString(), registry, endpoint.stableId)
          }
          owner.forget(endpoint.stableId)
          registry.remove(endpoint.stableId)
          if (hasSibling) {
            assertEquals(persisted, storage.values[application.origin])
            assertNotNull(owner.prepare(sibling, tls.copy(stableId = sibling.stableId), false, owner.admissionCheckpoint()) { true })
          } else {
            assertNull(storage.values[application.origin])
          }
          assertNull(owner.presentation.value.attention)
          assertNull(owner.presentation.value.browserLaunch)
        } finally {
          observer.cancel()
          waiter.resume()
        }
        runCurrent()
        assertTrue(first.await().exceptionOrNull() is CancellationException)
      }
    }

  @Test fun sharedWaiterCannotPublishForRetiredProfileAndFailureBelongsToCurrentWaiter() =
    runTest {
      for (outcome in listOf("forget", "replace", "caller", "failure")) {
        val uncaught = mutableListOf<Throwable>()
        val ownerScope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler) + CoroutineExceptionHandler { _, error -> uncaught += error })
        val registry = registry()
        val sibling = endpoint.copy(stableId = "shared-waiter")
        add(registry, sibling)
        val storage = Storage()
        val grant = CompletableDeferred<CloudflareAccessSession>()
        val firstDispatcher = PausingDispatcher(StandardTestDispatcher(testScheduler))
        val secondDispatcher = PausingDispatcher(StandardTestDispatcher(testScheduler))
        var secondCurrent = true
        var authentications = 0
        val owner =
          GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
            authentications++
            open("https://example.cloudflareaccess.com/login")
            grant.await()
          })
        val first = async(firstDispatcher) { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } } }
        runCurrent()
        val attention = checkNotNull(owner.presentation.value.attention)
        val launch = checkNotNull(owner.presentation.value.browserLaunch)
        val second = async(secondDispatcher) { runCatching { owner.prepare(sibling, tls.copy(stableId = sibling.stableId), true, owner.admissionCheckpoint()) { secondCurrent } } }
        runCurrent()
        firstDispatcher.paused = true
        secondDispatcher.paused = true
        try {
          if (outcome == "failure") grant.completeExceptionally(java.io.IOException("shared sign-in failed")) else grant.complete(CloudflareAccessTestTokens.session())
          runCurrent()
          assertFalse(first.isCompleted)
          assertFalse(second.isCompleted)
          when (outcome) {
            "forget" -> {
              owner.forget(sibling.stableId)
              registry.remove(sibling.stableId)
            }

            "replace" -> {
              assertNotNull(owner.prepare(sibling.copy(name = "Replacement"), tls.copy(stableId = sibling.stableId), false, owner.admissionCheckpoint()) { true })
            }

            "caller" -> {
              secondCurrent = false
            }
          }
          secondDispatcher.resume()
          runCurrent()
          if (outcome == "failure") {
            assertTrue(second.await().exceptionOrNull() is java.io.IOException)
            assertAttentionProfile(sibling.stableId, owner)
          } else {
            assertTrue(second.await().exceptionOrNull() is CancellationException)
            assertEquals(attention, owner.presentation.value.attention)
            assertEquals(launch, owner.presentation.value.browserLaunch)
          }
          firstDispatcher.resume()
          runCurrent()
          if (outcome == "failure") {
            assertTrue(first.await().exceptionOrNull() is java.io.IOException)
            assertAttentionProfile(sibling.stableId, owner)
          } else {
            val lease = checkNotNull(first.await().getOrThrow())
            lease.requireCurrent(Request.Builder().url(application.origin.uri.toString()).build())
            assertNotNull(storage.values[application.origin])
            assertNull(owner.presentation.value.attention)
          }
          assertNull(owner.presentation.value.browserLaunch)
          assertEquals(1, authentications)
        } finally {
          firstDispatcher.resume()
          secondDispatcher.resume()
          ownerScope.cancel()
          runCurrent()
          assertTrue(uncaught.isEmpty())
        }
      }
    }

  @Test fun forgettingLastAdmittedProfilePreservesSiblingCapabilityAndItsExpiry() =
    runTest {
      val registry = registry()
      val sibling = endpoint.copy(stableId = "discovered-sibling")
      add(registry, sibling)
      val storage = Storage()
      var now = System.currentTimeMillis() / 1000.0
      var retirements = 0
      storage.values[application.origin] = CloudflareAccessTestTokens.session(expires = now + 1).encode()
      val owner = GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, { retirements++ }, now = { now }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() })
      val first = checkNotNull(owner.prepare(endpoint, tls, false, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      val last = checkNotNull(owner.prepare(sibling, tls.copy(stableId = sibling.stableId), false, admissionCheckpoint = owner.admissionCheckpoint()) { true })
      val request = Request.Builder().url(application.origin.uri.toString()).build()
      owner.forget(sibling.stableId)
      registry.remove(sibling.stableId)
      assertTrue(runCatching { last.requireCurrent(request) }.exceptionOrNull() is GatewayExternalAuthorizationException)
      first.requireCurrent(request)
      assertNotNull(storage.values[application.origin])
      now += 2
      advanceTimeBy(1001)
      runCurrent()
      assertEquals(1, retirements)
      assertTrue(runCatching { first.requireCurrent(request) }.exceptionOrNull() is GatewayExternalAuthorizationException)
      assertNull(storage.values[application.origin])
    }

  @Test fun detachedSignOutAndExpiryReportDeletionAndDrainFailuresWithoutEscaping() =
    runTest {
      for (signOut in listOf(false, true)) {
        for (failDrain in listOf(false, true)) {
          val uncaught = mutableListOf<Throwable>()
          val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler) + CoroutineExceptionHandler { _, error -> uncaught += error })
          val registry = registry()
          val storage = Storage()
          var now = System.currentTimeMillis() / 1000.0
          val encoded = CloudflareAccessTestTokens.session(expires = now + 1).encode()
          storage.values[application.origin] = encoded
          storage.deleteSucceeds = failDrain
          val owner = GatewayIngressController(scope, registry, storage.persistence, { emptyMap() }, { if (failDrain) throw java.io.IOException("test-only drain failure") }, now = { now }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() })
          try {
            val lease = checkNotNull(owner.prepare(endpoint, tls, false, admissionCheckpoint = owner.admissionCheckpoint()) { true })
            if (signOut) {
              owner.signOut(endpoint.stableId)
            } else {
              now += 2
              owner.revalidate()
            }
            runCurrent()
            assertTrue(uncaught.isEmpty())
            assertTrue(checkNotNull(owner.presentation.value.attention).message.contains(if (signOut) "Try Sign out again" else "Sign in to retry"))
            assertEquals(encoded, storage.values[application.origin])
            assertTrue(runCatching { lease.requireCurrent(Request.Builder().url(application.origin.uri.toString()).build()) }.exceptionOrNull() is GatewayExternalAuthorizationException)
          } finally {
            scope.cancel()
          }
        }
      }
    }

  @Test fun detachedFailureUsesItsOriginTransitionAndPreservesCancellation() =
    runTest {
      for (next in listOf("renewal", "sign-out", "other-origin", "cancel")) {
        val uncaught = mutableListOf<Throwable>()
        val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler) + CoroutineExceptionHandler { _, error -> uncaught += error })
        val registry = registry()
        val storage = Storage()
        storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
        val release = CompletableDeferred<Unit>()
        var retirementCount = 0
        val owner =
          GatewayIngressController(scope, registry, storage.persistence, { emptyMap() }, { origin ->
            if (origin == application.origin && ++retirementCount == 1) {
              release.await()
              if (next == "cancel") throw CancellationException("test-only cancellation")
              throw java.io.IOException("test-only old drain failure")
            }
          }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, _ -> CloudflareAccessTestTokens.session("replacement") })
        val messages = mutableListOf<String>()
        scope.launch(UnconfinedTestDispatcher(testScheduler)) {
          owner.presentation.collect { presentation ->
            presentation.attention?.message?.let(messages::add)
          }
        }
        try {
          owner.prepare(endpoint, tls, false, admissionCheckpoint = owner.admissionCheckpoint()) { true }
          owner.signOut(endpoint.stableId)
          runCurrent()
          val store =
            GatewayIngressController::class.java
              .getDeclaredField("store")
              .apply { isAccessible = true }
              .get(owner) as CloudflareAccessSessionStore
          val renewal = if (next == "renewal") store.signIn(application) {} else null
          if (next == "sign-out") owner.signOut(endpoint.stableId)
          if (next == "other-origin") store.forget(CloudflareAccessOrigin.from("https://other.example.test")).task.await()
          runCurrent()
          release.complete(Unit)
          runCurrent()
          renewal?.await()
          assertTrue(uncaught.isEmpty())
          assertEquals(next == "other-origin", messages.any { it.contains("Could not clear") })
          if (next == "renewal") {
            assertNotNull(owner.prepare(endpoint, tls, false, admissionCheckpoint = owner.admissionCheckpoint()) { true })
            assertEquals("replacement", CloudflareAccessSession.decode(checkNotNull(storage.values[application.origin])).subject)
          }
        } finally {
          release.complete(Unit)
          scope.cancel()
        }
      }
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

  @Test fun coldForgetRetainsSiblingGrantAndLastOwnerDeletesIt() =
    runTest {
      val registry = registry()
      val storage = Storage()
      val sibling = endpoint.copy(stableId = "discovered-sibling")
      add(registry, sibling)
      storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()

      fun owner() = GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() })
      val producer = owner()
      producer.prepare(endpoint, tls, false, admissionCheckpoint = producer.admissionCheckpoint()) { true }
      producer.prepare(sibling, tls.copy(stableId = sibling.stableId), false, admissionCheckpoint = producer.admissionCheckpoint()) { true }
      val cold = owner()
      cold.forget(sibling.stableId)
      assertNotNull(storage.values[application.origin])
      registry.remove(sibling.stableId)
      cold.forget(endpoint.stableId)
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

  @Test fun queuedPreRegistrationWorkCannotBorrowANewGrantAfterSignOut() =
    runTest {
      for (ordinary in listOf(false, true)) {
        val registry = registry()
        registry.setAccessOrigin(endpoint.stableId, application.origin)
        val storage = Storage()
        var prompts = 0
        val owner =
          GatewayIngressController(
            backgroundScope,
            registry,
            storage.persistence,
            { emptyMap() },
            {},
            registryObserverDispatcher = StandardTestDispatcher(testScheduler),
            clientForRoute = { _, _ -> client { !ordinary && it.header("Cf-Access-Token") == null } },
            authenticate = { _, open ->
              prompts++
              open("https://example.cloudflareaccess.com/login")
              CloudflareAccessTestTokens.session()
            },
          )
        val checkpoint = owner.admissionCheckpoint()
        val queued = CompletableDeferred<Unit>()
        val pending =
          async {
            queued.await()
            runCatching { owner.prepare(endpoint, tls, true, checkpoint) { true } }
          }
        owner.signOut(endpoint.stableId)?.await()
        // A legitimate fresh request may renew the same origin while the older
        // unresolved request is queued; renewal must not restore its authority.
        val renewed = owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true }
        queued.complete(Unit)
        val result = pending.await()
        if (ordinary) {
          assertTrue(result.isSuccess)
          assertNull(result.getOrNull())
          assertEquals(0, prompts)
        } else {
          assertNotNull(renewed)
          assertTrue(result.exceptionOrNull() is CancellationException)
          assertEquals(1, prompts)
          assertNotNull(storage.values[application.origin])
        }
        assertNull(owner.presentation.value.browserLaunch)
      }
    }

  @Test fun alreadyCancelledJobCannotReplaceOrDowngradeLiveRegistration() =
    runTest {
      for (cleartext in listOf(false, true)) {
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
            error = runCatching { owner.prepare(endpoint.copy(contextPath = "/replacement"), if (cleartext) null else tls, true, owner.admissionCheckpoint()) { true } }.exceptionOrNull()
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
    }

  @Test fun cleartextDowngradeRetiresOnlyItsProfileAndLastOwnerAssociation() =
    runTest {
      for (shared in listOf(false, true)) {
        val registry = registry()
        val sibling = endpoint.copy(stableId = "retained-sibling")
        if (shared) add(registry, sibling)
        val storage = Storage()
        storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
        var retirements = 0
        val owner = GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, { retirements++ }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() })
        val old = checkNotNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
        val retained = if (shared) owner.prepare(sibling, tls.copy(stableId = sibling.stableId), false, owner.admissionCheckpoint()) { true } else null
        assertNull(owner.prepare(endpoint, null, false, owner.admissionCheckpoint()) { true })
        val request = Request.Builder().url(application.origin.uri.toString()).build()
        assertTrue(runCatching { old.requireCurrent(request) }.exceptionOrNull() is GatewayExternalAuthorizationException)
        retained?.requireCurrent(request)
        assertNull(owner.authorization(endpoint))
        assertAccessOrigin(null, registry, endpoint.stableId)
        assertEquals(shared, application.origin in storage.values)
        assertEquals(if (shared) 0 else 1, retirements)
        assertNull(owner.presentation.value.attention)
        assertNull(owner.presentation.value.browserLaunch)
        assertFalse(owner.needsEmbeddedBrowserSignIn(endpoint.stableId))
        if (shared) {
          assertAccessOrigin(application.origin.uri.toString(), registry, sibling.stableId)
          owner.forget(sibling.stableId)
          assertEquals(1, retirements)
          assertNull(storage.values[application.origin])
        }
      }
    }

  @Test fun cleartextDowngradeCancelsBrowserBeforeLateAuthenticationCompletes() =
    runTest {
      val registry = registry()
      val storage = Storage()
      val grant = CompletableDeferred<Unit>()
      val owner =
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
          open("https://example.cloudflareaccess.com/login")
          withContext(NonCancellable) { grant.await() }
          CloudflareAccessTestTokens.session()
        })
      val pending = async { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } } }
      try {
        runCurrent()
        assertNotNull(owner.presentation.value.browserLaunch)
        assertNull(owner.prepare(endpoint, null, false, owner.admissionCheckpoint()) { true })
        assertNull(owner.presentation.value.browserLaunch)
        assertNull(owner.presentation.value.attention)
        assertSingleAccessOrigin(null, registry)
      } finally {
        grant.complete(Unit)
      }
      assertTrue(pending.await().exceptionOrNull() is CancellationException)
      assertNull(storage.values[application.origin])
    }

  @Test fun cleartextRetryValidatesCapturedOwnershipAndCallerCancellation() =
    runTest {
      for (mode in listOf("current", "replaced", "canceled")) {
        val registry = registry()
        registry.setAccessOrigin(endpoint.stableId, application.origin)
        val owner = GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client { false } })
        owner.signOut(endpoint.stableId)?.await()
        val retry = checkNotNull(owner.retry(owner.admissionCheckpoint()) { true })
        if (mode == "replaced") {
          assertNull(owner.prepare(endpoint.copy(contextPath = "/replacement"), tls, false, owner.admissionCheckpoint()) { true })
        }
        val before = registry.entries.value.single()
        val presentation = owner.presentation.value
        var reached = false
        var error: Throwable? = null
        val caller =
          launch {
            if (mode == "canceled") coroutineContext[Job]!!.cancel()
            reached = true
            error = runCatching { retry.prepare(endpoint, null) }.exceptionOrNull()
          }
        caller.join()
        assertTrue(reached)
        if (mode == "current") {
          assertNull(error)
          assertSingleAccessOrigin(null, registry)
          assertNull(owner.presentation.value.attention)
        } else {
          assertTrue(error is CancellationException)
          assertSame(before, registry.entries.value.single())
          assertEquals(presentation, owner.presentation.value)
        }
      }
    }

  @Test fun cleartextLastOwnerKeepsRecoverableAssociationUntilDeletionAcknowledges() =
    runTest {
      for (deleteSucceeds in listOf(false, true)) {
        val registry = registry()
        val storage = Storage()
        storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
        storage.deleteSucceeds = deleteSucceeds
        val drain = CompletableDeferred<Unit>()
        var entered = false
        val pendingCallers = mutableListOf<Job>()
        val ownerScope = OwnedTestScope(StandardTestDispatcher(testScheduler))
        try {
          val owner =
            GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, {
              entered = true
              drain.await()
            }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() })
          owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true }
          val pending = async { runCatching { owner.prepare(endpoint, null, false, owner.admissionCheckpoint()) { true } } }.also(pendingCallers::add)
          runCurrent()
          assertTrue(entered)
          assertSingleAccessOrigin(application.origin.uri.toString(), registry)
          assertNotNull(storage.values[application.origin])
          drain.complete(Unit)
          val result = pending.await()
          if (deleteSucceeds) {
            assertTrue(result.isSuccess)
            assertSingleAccessOrigin(null, registry)
            assertNull(storage.values[application.origin])
          } else {
            assertTrue(result.exceptionOrNull() is CloudflareAccessException)
            assertSingleAccessOrigin(application.origin.uri.toString(), registry)
            assertNotNull(storage.values[application.origin])
            storage.deleteSucceeds = true
            owner.forget(endpoint.stableId)
            assertSingleAccessOrigin(null, registry)
            assertNull(storage.values[application.origin])
          }
        } finally {
          ownerScope.close({ pendingCallers.asSequence() }) {
            drain.complete(Unit)
          }
        }
      }
    }

  @Test fun downgradeCompletionCannotEraseAReplacementRegistrationAssociation() =
    runTest {
      val registry = registry()
      val storage = Storage()
      storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
      val drain = CompletableDeferred<Unit>()
      val owner = GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, { drain.await() }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() })
      owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true }
      val old = async { runCatching { owner.prepare(endpoint, null, false, owner.admissionCheckpoint()) { true } } }
      runCurrent()
      val replacement = endpoint.copy(contextPath = "/replacement")
      val fresh = async { runCatching { owner.prepare(replacement, tls, false, owner.admissionCheckpoint()) { true } } }
      runCurrent()
      drain.complete(Unit)
      assertTrue(old.await().exceptionOrNull() is CancellationException)
      assertTrue(fresh.await().exceptionOrNull() is GatewayExternalAuthorizationException)
      assertSingleAccessOrigin(application.origin.uri.toString(), registry)
      assertNotNull(owner.authorization(replacement))
      assertAttentionProfile(endpoint.stableId, owner)
    }

  @Test fun cleartextCompletionRequiresCurrentCallerButAllowsSiblingRetirement() =
    runTest {
      for (useRetry in listOf(false, true)) {
        for (supersedeCaller in listOf(false, true)) {
          val registry = registry()
          val drain = CompletableDeferred<Unit>()
          var entered = false
          var current = true
          val owner =
            GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {
              entered = true
              drain.await()
            }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() })
          assertTrue(runCatching { owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true } }.exceptionOrNull() is GatewayExternalAuthorizationException)
          val retry = if (useRetry) checkNotNull(owner.retry(owner.admissionCheckpoint()) { current }) else null
          val pending =
            async {
              runCatching {
                if (retry != null) retry.prepare(endpoint, null) else owner.prepare(endpoint, null, false, owner.admissionCheckpoint()) { current }
              }
            }
          runCurrent()
          assertTrue(entered)
          val sibling = endpoint.copy(stableId = "independent-sibling")
          val siblingRetirement =
            if (supersedeCaller) {
              current = false
              null
            } else {
              add(registry, sibling)
              registry.setAccessOrigin(sibling.stableId, application.origin)
              checkNotNull(owner.signOut(sibling.stableId))
            }
          drain.complete(Unit)
          val result = pending.await()
          if (supersedeCaller) {
            assertTrue(result.exceptionOrNull() is CancellationException)
          } else {
            assertTrue(result.isSuccess)
            assertNull(result.getOrNull())
            siblingRetirement?.await()
            runCurrent()
            assertAttentionProfile(sibling.stableId, owner)
          }
          assertAccessOrigin(null, registry, endpoint.stableId)
          assertNull(owner.authorization(endpoint))
          assertFalse(
            owner.presentation.value.browserRequired
              .contains(endpoint.stableId),
          )
          if (!supersedeCaller) {
            assertAccessOrigin(application.origin.uri.toString(), registry, sibling.stableId)
            assertTrue(
              owner.presentation.value.browserRequired
                .contains(sibling.stableId),
            )
          }
          assertNull(owner.presentation.value.browserLaunch)
        }
      }
    }

  @Test fun overlappingDeparturesShareTheLatestRetirementAcknowledgement() =
    runTest {
      for (mode in listOf("forget", "cleartext", "origin-change")) {
        for (succeeds in listOf(false, true)) {
          val registry = registry()
          val storage =
            Storage().also {
              it.values[application.origin] = CloudflareAccessTestTokens.session().encode()
              it.deleteSucceeds = succeeds
            }
          val release = CompletableDeferred<Unit>()
          val firstDispatcher = PausingDispatcher(StandardTestDispatcher(testScheduler))
          val secondDispatcher = PausingDispatcher(StandardTestDispatcher(testScheduler))
          val replacement = endpoint.copy(host = "replacement.example.test")
          var entered = 0
          val pendingCallers = mutableListOf<Job>()
          val ownerScope = OwnedTestScope(StandardTestDispatcher(testScheduler))
          try {
            val owner =
              GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, {
                entered++
                release.await()
              }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ -> client { target.host == endpoint.host && it.header("Cf-Access-Token") == null } })
            owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true }

            suspend fun depart(): GatewayIngressAuthorization? =
              when (mode) {
                "forget" -> {
                  owner.forget(endpoint.stableId)
                  null
                }

                "origin-change" -> {
                  owner.prepare(replacement, tls, false, owner.admissionCheckpoint()) { true }
                }

                else -> {
                  owner.prepare(endpoint, null, false, owner.admissionCheckpoint()) { true }
                }
              }
            val first = async(firstDispatcher) { runCatching { depart() } }.also(pendingCallers::add)
            var second: Deferred<Result<GatewayIngressAuthorization?>>? = null
            try {
              runCurrent()
              assertEquals(1, entered)
              val secondCaller = async(secondDispatcher) { runCatching { depart() } }.also(pendingCallers::add)
              second = secondCaller
              runCurrent()
              firstDispatcher.paused = true
              secondDispatcher.paused = true
              release.complete(Unit)
              runCurrent()
              assertEquals(2, storage.deleted.size)
              assertFalse(first.isCompleted)
              assertFalse(secondCaller.isCompleted)
              // R1 and R2 are terminal before either caller can consume them. The
              // stale R1 waiter must follow R2, not reserve another revocation.
              firstDispatcher.resume()
              val firstResult = first.await()
              assertEquals(2, storage.deleted.size)
              secondDispatcher.resume()
              val secondResult = secondCaller.await()
              if (succeeds) {
                assertTrue(firstResult.isSuccess)
                assertNull(firstResult.getOrThrow())
                if (mode == "origin-change") {
                  // Route prepares still reject a changed captured association;
                  // public cleanup and cleartext admission remain idempotent.
                  assertTrue(secondResult.exceptionOrNull() is CancellationException)
                } else {
                  assertTrue(secondResult.isSuccess)
                  assertNull(secondResult.getOrThrow())
                }
                assertSingleAccessOrigin(null, registry)
                assertNull(storage.values[application.origin])
              } else {
                assertEquals(CloudflareAccessException.Kind.StorageFailed, (firstResult.exceptionOrNull() as? CloudflareAccessException)?.kind)
                assertEquals(CloudflareAccessException.Kind.StorageFailed, (secondResult.exceptionOrNull() as? CloudflareAccessException)?.kind)
                assertSingleAccessOrigin(application.origin.uri.toString(), registry)
                assertNotNull(storage.values[application.origin])
                storage.deleteSucceeds = true
                owner.forget(endpoint.stableId)
                assertSingleAccessOrigin(null, registry)
                assertNull(storage.values[application.origin])
              }
            } finally {
              release.complete(Unit)
              firstDispatcher.resume()
              secondDispatcher.resume()
              first.cancelAndJoin()
              second?.cancelAndJoin()
            }
          } finally {
            ownerScope.close({ pendingCallers.asSequence() }) {
              release.complete(Unit)
              firstDispatcher.resume()
              secondDispatcher.resume()
            }
          }
        }
      }
    }

  @Test fun finalDepartureReconcilesGrantRenewedAfterAcknowledgedDeletion() =
    runTest {
      for (mode in listOf("origin-change", "forget", "cleartext", "retry")) {
        for (outcome in listOf("leaves", "stays", "delete-fails")) {
          val registry = registry()
          val storage = Storage()
          storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
          val sibling = endpoint.copy(stableId = "renewed-origin-sibling")
          val replacement = endpoint.copy(host = "replacement.example.test")
          val release = CompletableDeferred<Unit>()
          val waiter = PausingDispatcher(StandardTestDispatcher(testScheduler))
          var holdRetirement = false
          var retirementEntered = false
          var prompts = 0
          val pendingCallers = mutableListOf<Job>()
          val ownerScope = OwnedTestScope(StandardTestDispatcher(testScheduler))
          try {
            val owner =
              GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, {
                if (holdRetirement) {
                  retirementEntered = true
                  release.await()
                }
              }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ -> client { target.host == endpoint.host && it.header("Cf-Access-Token") == null } }, authenticate = { _, open ->
                prompts++
                open("https://example.cloudflareaccess.com/login")
                CloudflareAccessTestTokens.session("renewed")
              })
            val original = checkNotNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
            val retry =
              if (mode == "retry") {
                checkNotNull(owner.signOut(endpoint.stableId)).await()
                runCurrent()
                checkNotNull(owner.retry(owner.admissionCheckpoint()) { true })
              } else {
                null
              }
            val deletedBefore = storage.deleted.size
            holdRetirement = true
            val pending =
              async(waiter) {
                runCatching {
                  when (mode) {
                    "origin-change" -> {
                      owner.prepare(replacement, tls, false, owner.admissionCheckpoint()) { true }
                    }

                    "forget" -> {
                      owner.forget(endpoint.stableId)
                      null
                    }

                    "retry" -> {
                      checkNotNull(retry).prepare(endpoint, null)
                    }

                    else -> {
                      owner.prepare(endpoint, null, false, owner.admissionCheckpoint()) { true }
                    }
                  }
                }
              }.also(pendingCallers::add)
            try {
              runCurrent()
              assertTrue(retirementEntered)
              waiter.paused = true
              release.complete(Unit)
              runCurrent()
              // R1 has deleted the key; only A's continuation is paused. B can now
              // obtain a fresh checkpoint and persist G2 while A still owns cleanup.
              assertEquals(deletedBefore + 1, storage.deleted.size)
              assertNull(storage.values[application.origin])
              assertFalse(pending.isCompleted)
              assertAccessOrigin(application.origin.uri.toString(), registry, endpoint.stableId)
              val request = Request.Builder().url(application.origin.uri.toString()).build()
              assertTrue(runCatching { original.requireCurrent(request) }.exceptionOrNull() is GatewayExternalAuthorizationException)
              add(registry, sibling)
              val peer = checkNotNull(owner.prepare(sibling, tls.copy(stableId = sibling.stableId), true, owner.admissionCheckpoint()) { true })
              val renewedBytes = checkNotNull(storage.values[application.origin])
              assertEquals("renewed", CloudflareAccessSession.decode(renewedBytes).subject)
              assertEquals(1, prompts)
              peer.requireCurrent(request)
              val deletedAfterRenewal = storage.deleted.size
              if (outcome != "stays") {
                owner.forget(sibling.stableId)
                assertAccessOrigin(null, registry, sibling.stableId)
                assertEquals(renewedBytes, storage.values[application.origin])
                assertEquals(deletedAfterRenewal, storage.deleted.size)
              }
              storage.deleteSucceeds = outcome != "delete-fails"
              waiter.resume()
              val result = pending.await()
              if (outcome == "delete-fails") {
                assertEquals(CloudflareAccessException.Kind.StorageFailed, (result.exceptionOrNull() as? CloudflareAccessException)?.kind)
                assertAccessOrigin(application.origin.uri.toString(), registry, endpoint.stableId)
                assertEquals(renewedBytes, storage.values[application.origin])
                storage.deleteSucceeds = true
                owner.forget(endpoint.stableId)
                assertNull(storage.values[application.origin])
              } else {
                assertTrue(result.isSuccess)
                assertNull(result.getOrThrow())
                assertEquals(deletedAfterRenewal + if (outcome == "stays") 0 else 1, storage.deleted.size)
                if (outcome == "stays") {
                  assertEquals(renewedBytes, storage.values[application.origin])
                  peer.requireCurrent(request)
                  assertAccessOrigin(application.origin.uri.toString(), registry, sibling.stableId)
                } else {
                  assertNull(storage.values[application.origin])
                  assertTrue(runCatching { peer.requireCurrent(request) }.exceptionOrNull() is GatewayExternalAuthorizationException)
                }
              }
              assertAccessOrigin(null, registry, endpoint.stableId)
              assertNull(owner.authorization(if (mode == "origin-change") replacement else endpoint))
              assertFalse(
                owner.presentation.value.browserRequired
                  .contains(endpoint.stableId),
              )
              assertNull(owner.presentation.value.browserLaunch)
            } finally {
              release.complete(Unit)
              waiter.resume()
              pending.cancelAndJoin()
            }
          } finally {
            ownerScope.close({ pendingCallers.asSequence() }) {
              release.complete(Unit)
              waiter.resume()
            }
          }
        }
      }
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
        for (hasPeer in listOf(false, true)) {
          val registry = registry()
          val sibling = endpoint.copy(stableId = "ordinary-browser-peer")
          add(registry, sibling)
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
          var peer: Deferred<GatewayIngressAuthorization?>? = null
          try {
            runCurrent()
            val queued = owner.presentation.value.browserLaunch
            assertEquals(!delayed, queued != null)
            if (hasPeer) {
              peer = async { owner.prepare(sibling, tls.copy(stableId = sibling.stableId), true, owner.admissionCheckpoint()) { true } }
              runCurrent()
            }
            ordinary = true
            assertNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
            // Repeated ordinary preparation keeps its current owner and cannot revive the old waiter.
            assertNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
            assertTrue(checkNotNull(authentication).isActive)
            assertNull(owner.authorization(endpoint))
            assertFalse(endpoint.stableId in owner.presentation.value.browserRequired)
            if (!hasPeer) {
              assertNull(owner.presentation.value.browserLaunch)
              assertNull(owner.presentation.value.attention)
              if (queued != null) assertNull(owner.consumeBrowserLaunch(queued.attemptId))
            }
            publish.complete(Unit)
            runCurrent()
            if (hasPeer) {
              val launch = checkNotNull(owner.presentation.value.browserLaunch)
              if (queued != null) assertEquals(queued, launch)
              assertAttentionProfile(sibling.stableId, owner)
              assertEquals(launch.url, owner.consumeBrowserLaunch(launch.attemptId))
              assertNull(owner.consumeBrowserLaunch(launch.attemptId))
            } else {
              assertNull(owner.presentation.value.browserLaunch)
              assertNull(owner.presentation.value.attention)
            }
            grant.complete(CloudflareAccessTestTokens.session("ordinary-peer"))
            assertTrue(first.await().exceptionOrNull() is CancellationException)
            if (hasPeer) {
              checkNotNull(peer?.await()).requireCurrent(Request.Builder().url(application.origin.uri.toString()).build())
              assertEquals("ordinary-peer", CloudflareAccessSession.decode(checkNotNull(storage.values[application.origin])).subject)
            }
            assertEquals(1, prompts)
            assertNull(owner.authorization(endpoint))
            assertFalse(endpoint.stableId in owner.presentation.value.browserRequired)
            assertNull(owner.presentation.value.browserLaunch)
            assertNull(owner.presentation.value.attention)
          } finally {
            publish.complete(Unit)
            grant.cancel()
            first.cancelAndJoin()
            peer?.cancelAndJoin()
          }
        }
      }
    }

  @Test fun ordinaryAdmissionPermanentlyRetiresCompletedBrowserWaitersAcrossManagedReadmission() =
    runTest {
      val registry = registry()
      val sibling = endpoint.copy(stableId = "settled-browser-peer")
      add(registry, sibling)
      val storage = Storage()
      val grant = CompletableDeferred<CloudflareAccessSession>()
      val paused = PausingDispatcher(StandardTestDispatcher(testScheduler))
      var ordinary = false
      var prompts = 0
      val owner =
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ ->
          client { request -> !(ordinary && target.stableId == endpoint.stableId) && request.header("Cf-Access-Token") == null }
        }, authenticate = { _, open ->
          prompts++
          open("https://example.cloudflareaccess.com/login")
          grant.await()
        })
      val first = async(paused) { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } } }
      var peer: Deferred<GatewayIngressAuthorization?>? = null
      try {
        runCurrent()
        peer = async { owner.prepare(sibling, tls.copy(stableId = sibling.stableId), true, owner.admissionCheckpoint()) { true } }
        runCurrent()
        val launch = checkNotNull(owner.presentation.value.browserLaunch)
        assertEquals(launch.url, owner.consumeBrowserLaunch(launch.attemptId))
        paused.paused = true
        grant.complete(CloudflareAccessTestTokens.session("completed-peer"))
        runCurrent()
        val request = Request.Builder().url(application.origin.uri.toString()).build()
        checkNotNull(peer.await()).requireCurrent(request)
        assertFalse(first.isCompleted)
        assertNull(owner.presentation.value.browserLaunch)
        assertNull(owner.presentation.value.attention)
        ordinary = true
        assertNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
        ordinary = false
        val current = checkNotNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
        current.requireCurrent(request)
        paused.resume()
        runCurrent()
        assertTrue(first.await().exceptionOrNull() is CancellationException)
        assertSame(current, owner.authorization(endpoint))
        current.requireCurrent(request)
        assertEquals(1, prompts)
        assertEquals("completed-peer", CloudflareAccessSession.decode(checkNotNull(storage.values[application.origin])).subject)
        assertNull(owner.presentation.value.browserLaunch)
        assertNull(owner.presentation.value.attention)
      } finally {
        paused.resume()
        grant.cancel()
        first.cancelAndJoin()
        peer?.cancelAndJoin()
      }
    }

  @Test fun survivingParticipantsOwnDelayedBrowserPublicationAndLaterCoalescing() =
    runTest {
      for (delayed in listOf(false, true)) {
        val registry = registry()
        val sibling = endpoint.copy(stableId = "surviving-browser")
        val third = endpoint.copy(stableId = "later-browser")
        add(registry, sibling)
        add(registry, third)
        val storage = Storage()
        val publish = CompletableDeferred<Unit>()
        val grant = CompletableDeferred<CloudflareAccessSession>()
        var firstCurrent = true
        var prompts = 0
        val owner =
          GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
            prompts++
            if (delayed) publish.await()
            open("https://example.cloudflareaccess.com/login")
            grant.await()
          })
        val first = async { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { firstCurrent } } }
        var second: Deferred<GatewayIngressAuthorization?>? = null
        var last: Deferred<GatewayIngressAuthorization?>? = null
        try {
          runCurrent()
          val queued = owner.presentation.value.browserLaunch
          assertEquals(!delayed, queued != null)
          val peer = async { owner.prepare(sibling, tls.copy(stableId = sibling.stableId), true, owner.admissionCheckpoint()) { true } }
          second = peer
          runCurrent()
          firstCurrent = false
          first.cancelAndJoin()
          val later = async { owner.prepare(third, tls.copy(stableId = third.stableId), true, owner.admissionCheckpoint()) { true } }
          last = later
          runCurrent()
          assertEquals(1, prompts)
          assertFalse(peer.isCompleted)
          assertFalse(later.isCompleted)
          publish.complete(Unit)
          runCurrent()
          val launch = checkNotNull(owner.presentation.value.browserLaunch)
          if (queued != null) assertEquals(queued, launch)
          if (delayed) {
            assertAttentionProfile(sibling.stableId, owner)
          }
          assertEquals(launch.url, owner.consumeBrowserLaunch(launch.attemptId))
          assertNull(owner.consumeBrowserLaunch(launch.attemptId))
          grant.complete(CloudflareAccessTestTokens.session("surviving-subject"))
          val request = Request.Builder().url(application.origin.uri.toString()).build()
          checkNotNull(peer.await()).requireCurrent(request)
          checkNotNull(later.await()).requireCurrent(request)
          assertEquals("surviving-subject", CloudflareAccessSession.decode(checkNotNull(storage.values[application.origin])).subject)
          assertNull(owner.presentation.value.attention)
          assertNull(owner.presentation.value.browserLaunch)
        } finally {
          publish.complete(Unit)
          grant.cancel()
          first.cancelAndJoin()
          second?.cancelAndJoin()
          last?.cancelAndJoin()
        }
      }
    }

  @Test fun profileDeparturePreservesCoalescedBrowserAndTerminalWaiters() =
    runTest {
      for (departure in listOf("forget", "replacement")) {
        for (stage in listOf("delayed", "queued", "completed-success", "completed-failure")) {
          for (departCreator in listOf(false, true)) {
            val registry = registry()
            val sibling = endpoint.copy(stableId = "surviving-browser-profile")
            add(registry, sibling)
            val storage = Storage()
            val opening = CompletableDeferred<Unit>()
            val authenticationEntered = CompletableDeferred<Unit>()
            val grant = CompletableDeferred<CloudflareAccessSession>()
            val probeEntered = CompletableDeferred<Unit>()
            val probeRelease = CompletableDeferred<Unit>()
            val dispatchers = List(2) { PausingDispatcher(StandardTestDispatcher(testScheduler)) }
            val pending = mutableListOf<Job>()
            val ownerScope = OwnedTestScope(StandardTestDispatcher(testScheduler))
            val failure = SSLHandshakeException("test-only shared completion failure")
            var heldRoute: GatewayEndpoint? = null
            var authentication: Job? = null
            var prompts = 0
            if (stage != "delayed") opening.complete(Unit)
            try {
              val owner =
                GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ ->
                  client { request ->
                    if (target == heldRoute && request.header("Cf-Access-Token") == null) {
                      probeEntered.complete(Unit)
                      probeRelease.await()
                    }
                    request.header("Cf-Access-Token") == null
                  }
                }, authenticate = { _, open ->
                  prompts++
                  authentication = kotlin.coroutines.coroutineContext[Job]
                  authenticationEntered.complete(Unit)
                  opening.await()
                  open("https://example.cloudflareaccess.com/login")
                  grant.await()
                })
              val first = async(dispatchers[0]) { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } } }.also(pending::add)
              runCurrent()
              assertTrue(authenticationEntered.isCompleted)
              val second = async(dispatchers[1]) { runCatching { owner.prepare(sibling, tls.copy(stableId = sibling.stableId), true, owner.admissionCheckpoint()) { true } } }.also(pending::add)
              runCurrent()
              assertEquals(1, prompts)
              assertFalse(first.isCompleted)
              assertFalse(second.isCompleted)
              val initialLaunch = owner.presentation.value.browserLaunch
              val terminal = stage.startsWith("completed")
              if (terminal) {
                val launch = checkNotNull(initialLaunch)
                assertEquals(launch.url, owner.consumeBrowserLaunch(launch.attemptId))
                assertNull(owner.consumeBrowserLaunch(launch.attemptId))
                dispatchers.forEach { it.paused = true }
                if (stage == "completed-failure") grant.completeExceptionally(failure) else grant.complete(CloudflareAccessTestTokens.session("shared-survivor"))
                runCurrent()
                assertTrue(checkNotNull(authentication).isCompleted)
                assertFalse(first.isCompleted)
                assertFalse(second.isCompleted)
              }
              val selected = if (departCreator) endpoint else sibling
              val survivor = if (departCreator) sibling else endpoint
              val deletes = storage.deleted.size
              val taskWasCanceled = checkNotNull(authentication).isCancelled
              var replacement: Deferred<Result<GatewayIngressAuthorization?>>? = null
              if (departure == "forget") {
                owner.forget(selected.stableId)
              } else {
                val route = selected.copy(contextPath = "/replacement/socket")
                heldRoute = route
                replacement = async { runCatching { owner.prepare(route, tls.copy(stableId = route.stableId), false, owner.admissionCheckpoint()) { true } } }.also(pending::add)
                runCurrent()
                assertTrue(probeEntered.isCompleted)
                assertFalse(replacement.isCompleted)
              }
              assertEquals(taskWasCanceled, checkNotNull(authentication).isCancelled)
              assertEquals(deletes, storage.deleted.size)
              assertEquals(1, prompts)
              if (stage != "delayed") {
                assertAttentionProfile(survivor.stableId, owner)
                assertEquals(
                  initialLaunch?.attemptId,
                  owner.presentation.value.attention
                    ?.attemptId,
                )
              }
              if (!terminal) {
                opening.complete(Unit)
                runCurrent()
                val launch = checkNotNull(owner.presentation.value.browserLaunch)
                if (initialLaunch != null) assertEquals(initialLaunch, launch)
                assertAttentionProfile(survivor.stableId, owner)
                assertEquals(launch.url, owner.consumeBrowserLaunch(launch.attemptId))
                assertNull(owner.consumeBrowserLaunch(launch.attemptId))
                grant.complete(CloudflareAccessTestTokens.session("shared-survivor"))
              }
              dispatchers.forEach { it.resume() }
              val selectedResult = (if (departCreator) first else second).await()
              val survivorResult = (if (departCreator) second else first).await()
              if (stage == "completed-failure") {
                assertTlsFailure(failure, selectedResult.exceptionOrNull())
                assertTlsFailure(failure, survivorResult.exceptionOrNull())
                assertAttentionProfile(survivor.stableId, owner)
                assertTrue(checkNotNull(owner.presentation.value.attention).message.startsWith("TLS connection failed:"))
                assertNull(storage.values[application.origin])
              } else {
                assertTrue(selectedResult.exceptionOrNull() is CancellationException)
                val lease = checkNotNull(survivorResult.getOrThrow())
                lease.requireCurrent(Request.Builder().url(application.origin.uri.toString()).build())
                assertEquals("shared-survivor", CloudflareAccessSession.decode(checkNotNull(storage.values[application.origin])).subject)
                assertNull(owner.presentation.value.attention)
              }
              assertNull(owner.presentation.value.browserLaunch)
              assertAccessOrigin(application.origin.uri.toString(), registry, survivor.stableId)
              replacement?.cancel()
              probeRelease.complete(Unit)
              if (replacement != null) assertTrue(runCatching { replacement.await().getOrThrow() }.exceptionOrNull() is CancellationException)
            } finally {
              ownerScope.close({ pending.asSequence() }) {
                opening.complete(Unit)
                grant.cancel()
                probeRelease.complete(Unit)
                dispatchers.forEach { it.resume() }
              }
            }
          }
        }
      }
    }

  @Test fun passiveReplacementPreservesPeerUntilAnIncompatibleApplicationSignsIn() =
    runTest {
      val registry = registry()
      val sibling = endpoint.copy(stableId = "previous-application-peer")
      add(registry, sibling)
      val replacement = endpoint.copy(contextPath = "/other/socket")
      val other = application.copy(audience = "replacement-audience")
      val storage = Storage()
      val firstGrant = CompletableDeferred<CloudflareAccessSession>()
      val nextGrant = CompletableDeferred<CloudflareAccessSession>()
      val probeEntered = CompletableDeferred<Unit>()
      val probeRelease = CompletableDeferred<Unit>()
      val applications = mutableListOf<CloudflareAccessApplication>()
      val pending = mutableListOf<Job>()
      val ownerScope = OwnedTestScope(StandardTestDispatcher(testScheduler))
      var originalTask: Job? = null
      try {
        val owner =
          GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ ->
            client({ if (target == replacement) other else application }) { request ->
              if (target == replacement && request.header("Cf-Access-Token") == null) {
                probeEntered.complete(Unit)
                probeRelease.await()
              }
              request.header("Cf-Access-Token") == null
            }
          }, authenticate = { descriptor, open ->
            applications += descriptor
            open("https://example.cloudflareaccess.com/login")
            if (descriptor == application) {
              originalTask = kotlin.coroutines.coroutineContext[Job]
              withContext(NonCancellable) { firstGrant.await() }
            } else {
              nextGrant.await()
            }
          })
        val first = async { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } } }.also(pending::add)
        runCurrent()
        val launch = checkNotNull(owner.presentation.value.browserLaunch)
        val peer = async { runCatching { owner.prepare(sibling, tls.copy(stableId = sibling.stableId), true, owner.admissionCheckpoint()) { true } } }.also(pending::add)
        runCurrent()
        val next = async { owner.prepare(replacement, tls, true, owner.admissionCheckpoint()) { true } }.also(pending::add)
        runCurrent()
        assertTrue(probeEntered.isCompleted)
        assertFalse(checkNotNull(originalTask).isCancelled)
        assertEquals(listOf(application), applications)
        assertEquals(launch, owner.presentation.value.browserLaunch)
        assertAttentionProfile(sibling.stableId, owner)
        assertEquals(launch.url, owner.consumeBrowserLaunch(launch.attemptId))
        probeRelease.complete(Unit)
        runCurrent()
        assertTrue(checkNotNull(originalTask).isCancelled)
        assertEquals(listOf(application, other), applications)
        val currentLaunch = checkNotNull(owner.presentation.value.browserLaunch)
        assertTrue(currentLaunch.attemptId != launch.attemptId)
        assertEquals(currentLaunch.url, owner.consumeBrowserLaunch(currentLaunch.attemptId))
        firstGrant.complete(CloudflareAccessTestTokens.session())
        assertTrue(first.await().exceptionOrNull() is CancellationException)
        assertTrue(peer.await().exceptionOrNull() is CancellationException)
        nextGrant.complete(sessionFor(other))
        val lease = checkNotNull(next.await())
        lease.requireCurrent(Request.Builder().url(application.origin.uri.toString()).build())
        assertEquals(other, CloudflareAccessSession.decode(checkNotNull(storage.values[application.origin])).application)
        assertNull(owner.presentation.value.attention)
      } finally {
        ownerScope.close({ pending.asSequence() }) {
          firstGrant.complete(CloudflareAccessTestTokens.session())
          nextGrant.cancel()
          probeRelease.complete(Unit)
        }
      }
    }

  @Test fun explicitDepartureRetiresAnOrdinarySuccessorsObsoleteBrowserGeneration() =
    runTest {
      for (replace in listOf(false, true)) {
        val registry = registry()
        val sibling = endpoint.copy(stableId = "next-browser-profile")
        add(registry, sibling)
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
            if (replace) {
              async { runCatching { owner.prepare(replacement, tls, false, owner.admissionCheckpoint()) { true } } }.also(pending::add).also {
                runCurrent()
                assertTrue(probeEntered.isCompleted)
                assertFalse(it.isCompleted)
              }
            } else {
              owner.forget(endpoint.stableId)
              null
            }
          assertTrue(checkNotNull(authentication).isCancelled)
          assertTrue(old.await().exceptionOrNull() is CancellationException)
          assertNull(storage.values[application.origin])
          val result =
            if (automatic != null) {
              probeRelease.complete(Unit)
              automatic.await()
            } else {
              assertAccessOrigin(null, registry, endpoint.stableId)
              runCatching { owner.prepare(sibling, tls.copy(stableId = sibling.stableId), false, owner.admissionCheckpoint()) { true } }
            }
          assertTrue(result.exceptionOrNull() is GatewayExternalAuthorizationException)
          assertEquals(if (replace) endpoint.stableId else sibling.stableId, checkNotNull(owner.presentation.value.attention).stableId)
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

  @Test fun ordinaryBrowserOwnerDoesNotSuppressAnotherOriginsRequiredRetryOrRetirement() =
    runTest {
      for (settlesBefore in listOf(false, true)) {
        for (succeeds in listOf(false, true)) {
          for (deleteSucceeds in listOf(false, true)) {
            val registry = registry()
            val other = endpoint.copy(stableId = "independent-required", host = "other.example.test")
            val otherTls = tls.copy(stableId = other.stableId)
            val otherApplication = application.copy(origin = CloudflareAccessOrigin.from("https://other.example.test:8443"))
            add(registry, other)
            val storage = Storage()
            val grant = CompletableDeferred<CloudflareAccessSession>()
            val retirement = CompletableDeferred<Unit>()
            val retirementStarted = CompletableDeferred<Unit>()
            val failure = SSLHandshakeException("test-only retired browser failure")
            val pending = mutableListOf<Job>()
            val ownerScope = OwnedTestScope(StandardTestDispatcher(testScheduler))
            var ordinary = false
            var prompts = 0
            var authentication: Job? = null
            try {
              val owner =
                GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, { origin ->
                  if (origin == otherApplication.origin) {
                    retirementStarted.complete(Unit)
                    retirement.await()
                  }
                }, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ ->
                  if (target.stableId == other.stableId) client({ otherApplication }) else client { request -> !ordinary && request.header("Cf-Access-Token") == null }
                }, authenticate = { _, open ->
                  authentication = kotlin.coroutines.coroutineContext[Job]
                  prompts++
                  open("https://example.cloudflareaccess.com/login")
                  grant.await()
                })
              val original = async { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } } }.also(pending::add)

              suspend fun settleOriginal() {
                if (succeeds) grant.complete(CloudflareAccessTestTokens.session()) else grant.completeExceptionally(failure)
                runCurrent()
                val error = original.await().exceptionOrNull()
                if (succeeds) assertTrue(error is CancellationException) else assertTlsFailure(failure, error)
              }
              runCurrent()
              val launch = checkNotNull(owner.presentation.value.browserLaunch)
              ordinary = true
              assertNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
              assertTrue(checkNotNull(authentication).isActive)
              assertNull(owner.presentation.value.attention)
              assertNull(owner.presentation.value.browserLaunch)
              assertFalse(owner.blocksAutomaticReconnect(endpoint.stableId))
              if (settlesBefore) settleOriginal()
              val denied = runCatching { owner.prepare(other, otherTls, false, owner.admissionCheckpoint()) { true } }
              assertTrue(denied.exceptionOrNull() is GatewayExternalAuthorizationException)
              val required = checkNotNull(owner.presentation.value.attention)
              assertEquals(other.stableId, required.stableId)
              assertNull(required.attemptId)
              assertTrue(owner.blocksAutomaticReconnect(other.stableId))
              checkNotNull(owner.retry(owner.admissionCheckpoint()) { true }).reportFailure("Current independent retry failed")
              assertAttentionMessage("Current independent retry failed", owner)
              val signedOut = checkNotNull(owner.signOut(other.stableId)).also(pending::add)
              runCurrent()
              assertTrue(retirementStarted.isCompleted)
              assertFalse(signedOut.isCompleted)
              val signingOut = checkNotNull(owner.presentation.value.attention)
              assertEquals(other.stableId, signingOut.stableId)
              assertEquals("Signing out…", signingOut.message)
              if (!settlesBefore) settleOriginal()
              assertSame(signingOut, owner.presentation.value.attention)
              storage.deleteSucceeds = deleteSucceeds
              retirement.complete(Unit)
              val result = runCatching { signedOut.await() }
              if (deleteSucceeds) {
                result.getOrThrow()
              } else {
                assertEquals(CloudflareAccessException.Kind.StorageFailed, (result.exceptionOrNull() as? CloudflareAccessException)?.kind)
              }
              runCurrent()
              val completed = checkNotNull(owner.presentation.value.attention)
              assertEquals(other.stableId, completed.stableId)
              assertTrue(completed.message.contains(if (deleteSucceeds) "signed out" else "Could not clear"))
              checkNotNull(owner.retry(owner.admissionCheckpoint()) { true }).reportFailure("Retry after retirement remains actionable")
              assertAttentionMessage("Retry after retirement remains actionable", owner)
              assertNull(owner.consumeBrowserLaunch(launch.attemptId))
              assertNull(owner.presentation.value.browserLaunch)
              assertEquals(1, prompts)
            } finally {
              ownerScope.close({ pending.asSequence() }) {
                retirement.complete(Unit)
                grant.cancel()
              }
            }
          }
        }
      }
    }

  @Test fun withdrawnCoalescedOwnerRetainsExplicitDepartureCustodyUntilTransferSettles() =
    runTest {
      for (departure in listOf("forget", "replacement", "cancel-pending")) {
        for (hasLivePeer in listOf(false, true)) {
          if (departure == "cancel-pending" && hasLivePeer) continue
          val registry = registry()
          val sibling = endpoint.copy(stableId = "withdrawn-coalesced-owner")
          val siblingTls = tls.copy(stableId = sibling.stableId)
          val replacement = sibling.copy(name = "Replacement route")
          add(registry, sibling)
          val storage = Storage()
          val grant = CompletableDeferred<CloudflareAccessSession>()
          val pending = mutableListOf<Job>()
          val ownerScope = OwnedTestScope(StandardTestDispatcher(testScheduler))
          var authentication: Job? = null
          var prompts = 0
          try {
            val owner =
              GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { target, _ ->
                client { request -> target != replacement && request.header("Cf-Access-Token") == null }
              }, authenticate = { _, open ->
                authentication = kotlin.coroutines.coroutineContext[Job]
                prompts++
                open("https://example.cloudflareaccess.com/login")
                // Late results must fail Store admission even if the transfer ignores cancellation.
                withContext(NonCancellable) { grant.await() }
              })
            val first = async { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } } }.also(pending::add)
            runCurrent()
            val launch = checkNotNull(owner.presentation.value.browserLaunch)
            val second = async { owner.prepare(sibling, siblingTls, true, owner.admissionCheckpoint()) { true } }.also(pending::add)
            runCurrent()
            assertEquals(1, prompts)
            second.cancelAndJoin()
            if (!hasLivePeer) first.cancelAndJoin()
            assertTrue(checkNotNull(authentication).isActive)
            assertAccessOrigin(application.origin.uri.toString(), registry, endpoint.stableId)
            assertAccessOrigin(application.origin.uri.toString(), registry, sibling.stableId)
            val removed =
              async {
                runCatching {
                  when (departure) {
                    "forget" -> owner.forget(sibling.stableId)
                    "replacement" -> assertNull(owner.prepare(replacement, siblingTls, false, owner.admissionCheckpoint()) { true })
                    "cancel-pending" -> owner.cancelPending(sibling.stableId)
                  }
                }
              }.also(pending::add)
            runCurrent()
            if (hasLivePeer) {
              removed.await().getOrThrow()
              assertTrue(checkNotNull(authentication).isActive)
              assertAttentionProfile(endpoint.stableId, owner)
              assertEquals(launch, owner.presentation.value.browserLaunch)
            } else {
              assertTrue(checkNotNull(authentication).isCancelled)
              assertFalse(checkNotNull(authentication).isCompleted)
              assertNull(owner.presentation.value.browserLaunch)
              assertNull(owner.presentation.value.attention)
            }
            assertNull(storage.values[application.origin])
            grant.complete(CloudflareAccessTestTokens.session("retained-custody"))
            runCurrent()
            removed.await().getOrThrow()
            if (hasLivePeer) {
              checkNotNull(first.await().getOrThrow()).requireCurrent(Request.Builder().url(application.origin.uri.toString()).build())
              assertEquals("retained-custody", CloudflareAccessSession.decode(checkNotNull(storage.values[application.origin])).subject)
            } else {
              assertTrue(runCatching { first.await() }.exceptionOrNull() is CancellationException)
              assertNull(storage.values[application.origin])
              assertTrue(checkNotNull(authentication).isCompleted)
            }
            assertAccessOrigin(application.origin.uri.toString(), registry, endpoint.stableId)
            assertNull(owner.presentation.value.browserLaunch)
            assertEquals(1, prompts)
          } finally {
            ownerScope.close({ pending.asSequence() }) {
              grant.complete(CloudflareAccessTestTokens.session("cleanup"))
            }
          }
        }
      }
    }

  @Test fun browserEligibilityEndsWithParticipantsAndExplicitCancelTargetsTheSurvivor() =
    runTest {
      for (retireAll in listOf(false, true)) {
        val registry = registry()
        val sibling = endpoint.copy(stableId = "surviving-browser")
        add(registry, sibling)
        val storage = Storage()
        val grant = CompletableDeferred<CloudflareAccessSession>()
        var authentication: Job? = null
        var firstCurrent = true
        var peerCurrent = true
        val owner =
          GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
            authentication = kotlin.coroutines.coroutineContext[Job]
            open("https://example.cloudflareaccess.com/login")
            grant.await()
          })
        val first = async { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { firstCurrent } } }
        var second: Deferred<GatewayIngressAuthorization?>? = null
        try {
          runCurrent()
          val launch = checkNotNull(owner.presentation.value.browserLaunch)
          val peer = async { owner.prepare(sibling, tls.copy(stableId = sibling.stableId), true, owner.admissionCheckpoint()) { peerCurrent } }
          second = peer
          runCurrent()
          firstCurrent = false
          assertFalse(first.isCompleted)
          assertFalse(owner.blocksAutomaticReconnect(endpoint.stableId))
          assertTrue(owner.blocksAutomaticReconnect(sibling.stableId))
          assertTrue(checkNotNull(authentication).isActive)
          first.cancelAndJoin()
          assertFalse(owner.blocksAutomaticReconnect(endpoint.stableId))
          assertTrue(owner.blocksAutomaticReconnect(sibling.stableId))
          assertAttentionProfile(sibling.stableId, owner)
          if (retireAll) {
            peerCurrent = false
            assertFalse(peer.isCompleted)
            assertFalse(owner.blocksAutomaticReconnect(endpoint.stableId))
            assertFalse(owner.blocksAutomaticReconnect(sibling.stableId))
            assertNull(owner.consumeBrowserLaunch(launch.attemptId))
            assertTrue(checkNotNull(authentication).isActive)
            peer.cancelAndJoin()
            assertTrue(checkNotNull(authentication).isActive)
            assertNull(owner.consumeBrowserLaunch(launch.attemptId))
            assertFalse(owner.blocksAutomaticReconnect(sibling.stableId))
            assertNull(owner.presentation.value.attention)
            assertNull(owner.presentation.value.browserLaunch)
          }
          checkNotNull(owner.cancel(launch.attemptId)).join()
          runCurrent()
          assertTrue(runCatching { peer.await() }.exceptionOrNull() is CancellationException)
          assertFalse(checkNotNull(authentication).isActive)
          assertNull(owner.presentation.value.browserLaunch)
          assertNull(owner.consumeBrowserLaunch(launch.attemptId))
          if (retireAll) {
            assertNull(owner.presentation.value.attention)
          } else {
            val attention = checkNotNull(owner.presentation.value.attention)
            assertEquals(sibling.stableId, attention.stableId)
            assertNull(attention.attemptId)
            assertTrue(attention.message.contains("canceled"))
          }
          assertNull(storage.values[application.origin])
        } finally {
          grant.cancel()
          first.cancelAndJoin()
          second?.cancelAndJoin()
        }
      }
    }

  @Test fun cancelingEitherCoalescedWaiterLeavesThePeerAndBrowserOwnerIntact() =
    runTest {
      for (canceledIndex in listOf(0, 1)) {
        for (retirement in listOf("job", "caller", "both")) {
          for (succeeds in listOf(false, true)) {
            val registry = registry()
            val sibling = endpoint.copy(stableId = "coalesced-sibling")
            add(registry, sibling)
            val storage = Storage()
            val grant = CompletableDeferred<CloudflareAccessSession>()
            val current = mutableListOf(true, true)
            val failure = SSLHandshakeException("test-only shared TLS failure")
            var prompts = 0
            val pendingCallers = mutableListOf<Job>()
            val ownerScope = OwnedTestScope(StandardTestDispatcher(testScheduler))
            try {
              val owner =
                GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
                  prompts++
                  open("https://example.cloudflareaccess.com/login")
                  grant.await()
                })
              val first = async { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { current[0] } } }.also(pendingCallers::add)
              runCurrent()
              val launch = checkNotNull(owner.presentation.value.browserLaunch)
              val second = async { runCatching { owner.prepare(sibling, tls.copy(stableId = sibling.stableId), true, owner.admissionCheckpoint()) { current[1] } } }.also(pendingCallers::add)
              runCurrent()
              val callers = listOf(first, second)
              try {
                if (retirement != "job") current[canceledIndex] = false
                if (retirement != "caller") callers[canceledIndex].cancel()
                runCurrent()
                assertFalse(owner.blocksAutomaticReconnect(if (canceledIndex == 0) endpoint.stableId else sibling.stableId))
                assertTrue(owner.blocksAutomaticReconnect(if (canceledIndex == 0) sibling.stableId else endpoint.stableId))
                if (retirement == "caller") assertFalse(callers[canceledIndex].isCompleted)
                assertEquals(launch, owner.presentation.value.browserLaunch)
                assertEquals(1, prompts)
                assertEquals(launch.url, owner.consumeBrowserLaunch(launch.attemptId))
                assertNull(owner.consumeBrowserLaunch(launch.attemptId))
                if (succeeds) grant.complete(CloudflareAccessTestTokens.session()) else grant.completeExceptionally(failure)
                val retiredError = runCatching { callers[canceledIndex].await().getOrThrow() }.exceptionOrNull()
                if (!succeeds && retiredError !is CancellationException) {
                  assertTlsFailure(failure, retiredError)
                } else {
                  assertTrue(retiredError is CancellationException)
                }
                val peer = callers[1 - canceledIndex].await()
                if (succeeds) {
                  val lease = checkNotNull(peer.getOrThrow())
                  lease.requireCurrent(Request.Builder().url(application.origin.uri.toString()).build())
                  assertNotNull(storage.values[application.origin])
                  assertNull(owner.presentation.value.attention)
                } else {
                  assertTlsFailure(failure, peer.exceptionOrNull())
                  assertNull(storage.values[application.origin])
                  val attention = checkNotNull(owner.presentation.value.attention)
                  assertEquals(if (canceledIndex == 0) sibling.stableId else endpoint.stableId, attention.stableId)
                  assertTrue(attention.message.startsWith("TLS connection failed:"))
                  assertNotNull(owner.retry(owner.admissionCheckpoint()) { true })
                }
                assertNull(owner.presentation.value.browserLaunch)
                assertFalse(owner.blocksAutomaticReconnect(if (canceledIndex == 0) endpoint.stableId else sibling.stableId))
              } finally {
                grant.cancel()
                first.cancelAndJoin()
                second.cancelAndJoin()
              }
            } finally {
              ownerScope.close({ pendingCallers.asSequence() }) {
                grant.cancel()
              }
            }
          }
        }
      }
    }

  @Test fun completedSharedTaskCannotAcquireANewGenerationOnItsOldBrowserIntent() =
    runTest {
      for (reverse in listOf(false, true)) {
        val registry = registry()
        val sibling = endpoint.copy(stableId = "coalesced-sibling")
        val replacement = endpoint.copy(stableId = "replacement-browser")
        add(registry, sibling)
        add(registry, replacement)
        val storage = Storage()
        val firstGrant = CompletableDeferred<CloudflareAccessSession>()
        val replacementGrant = CompletableDeferred<CloudflareAccessSession>()
        val dispatchers = List(2) { PausingDispatcher(StandardTestDispatcher(testScheduler)) }
        val failure = SSLHandshakeException("test-only completed shared failure")
        var prompts = 0
        val pendingCallers = mutableListOf<Job>()
        val ownerScope = OwnedTestScope(StandardTestDispatcher(testScheduler))
        try {
          val owner =
            GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
              val grant = if (++prompts == 1) firstGrant else replacementGrant
              open("https://example.cloudflareaccess.com/login")
              grant.await()
            })
          val first = async(dispatchers[0]) { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } } }.also(pendingCallers::add)
          runCurrent()
          val oldLaunch = checkNotNull(owner.presentation.value.browserLaunch)
          val second = async(dispatchers[1]) { runCatching { owner.prepare(sibling, tls.copy(stableId = sibling.stableId), true, owner.admissionCheckpoint()) { true } } }.also(pendingCallers::add)
          runCurrent()
          assertEquals(1, prompts)
          var fresh: Job? = null
          try {
            dispatchers.forEach { it.paused = true }
            firstGrant.completeExceptionally(failure)
            runCurrent()
            assertFalse(first.isCompleted)
            assertFalse(second.isCompleted)
            assertEquals(oldLaunch, owner.presentation.value.browserLaunch)
            val replacementWaiter = async { owner.prepare(replacement, tls.copy(stableId = replacement.stableId), true, owner.admissionCheckpoint()) { true } }.also(pendingCallers::add)
            fresh = replacementWaiter
            runCurrent()
            val presentation = owner.presentation.value
            val currentLaunch = checkNotNull(presentation.browserLaunch)
            assertTrue(currentLaunch.attemptId != oldLaunch.attemptId)
            assertEquals(replacement.stableId, presentation.attention?.stableId)
            assertEquals(2, prompts)
            for (index in if (reverse) listOf(1, 0) else listOf(0, 1)) {
              dispatchers[index].resume()
              runCurrent()
              assertTlsFailure(failure, listOf(first, second)[index].await().exceptionOrNull())
              assertEquals(presentation, owner.presentation.value)
              assertNull(owner.consumeBrowserLaunch(oldLaunch.attemptId))
              assertNull(owner.cancel(oldLaunch.attemptId))
              assertEquals(presentation, owner.presentation.value)
            }
            val session = CloudflareAccessTestTokens.session("replacement-subject")
            replacementGrant.complete(session)
            val lease = checkNotNull(replacementWaiter.await())
            lease.requireCurrent(Request.Builder().url(application.origin.uri.toString()).build())
            val persisted = CloudflareAccessSession.decode(checkNotNull(storage.values[application.origin]))
            assertEquals(session.subject, persisted.subject)
            assertEquals(application, persisted.application)
            assertNull(owner.presentation.value.browserLaunch)
            assertNull(owner.presentation.value.attention)
          } finally {
            dispatchers.forEach { it.resume() }
            first.cancelAndJoin()
            second.cancelAndJoin()
            fresh?.cancelAndJoin()
          }
        } finally {
          ownerScope.close({ pendingCallers.asSequence() }) {
            firstGrant.cancel()
            replacementGrant.cancel()
            dispatchers.forEach { it.resume() }
          }
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

  @Test fun delayedCoalescedWaitersCannotSettleAReplacementBrowserIntent() =
    runTest {
      val registry = registry()
      val sibling = endpoint.copy(stableId = "coalesced-sibling")
      val replacement = endpoint.copy(stableId = "replacement-browser")
      add(registry, sibling)
      add(registry, replacement)
      val firstGrant = CompletableDeferred<CloudflareAccessSession>()
      val replacementGrant = CompletableDeferred<CloudflareAccessSession>()
      val paused = PausingDispatcher(StandardTestDispatcher(testScheduler))
      val failure = SSLHandshakeException("test-only completed shared failure")
      var prompts = 0
      val pendingCallers = mutableListOf<Job>()
      val ownerScope = OwnedTestScope(StandardTestDispatcher(testScheduler))
      try {
        val owner =
          GatewayIngressController(ownerScope, registry, Storage().persistence, { emptyMap() }, {}, registryObserverDispatcher = StandardTestDispatcher(testScheduler), clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
            val grant = if (++prompts == 1) firstGrant else replacementGrant
            open("https://example.cloudflareaccess.com/login")
            grant.await()
          })
        val first = async { runCatching { owner.prepare(endpoint, tls, true, owner.admissionCheckpoint()) { true } } }.also(pendingCallers::add)
        runCurrent()
        val second = async(paused) { runCatching { owner.prepare(sibling, tls.copy(stableId = sibling.stableId), true, owner.admissionCheckpoint()) { true } } }.also(pendingCallers::add)
        runCurrent()
        var fresh: Job? = null
        try {
          paused.paused = true
          firstGrant.completeExceptionally(failure)
          runCurrent()
          assertTlsFailure(failure, first.await().exceptionOrNull())
          assertNull(owner.presentation.value.browserLaunch)
          assertFalse(second.isCompleted)
          val replacementWaiter = async { owner.prepare(replacement, tls.copy(stableId = replacement.stableId), true, owner.admissionCheckpoint()) { true } }.also(pendingCallers::add)
          fresh = replacementWaiter
          runCurrent()
          val presentation = owner.presentation.value
          assertNotNull(presentation.browserLaunch)
          assertEquals(replacement.stableId, presentation.attention?.stableId)
          assertEquals(2, prompts)
          paused.resume()
          runCurrent()
          assertTlsFailure(failure, second.await().exceptionOrNull())
          assertEquals(presentation, owner.presentation.value)
          replacementGrant.complete(CloudflareAccessTestTokens.session())
          assertNotNull(replacementWaiter.await())
          assertNull(owner.presentation.value.browserLaunch)
          assertNull(owner.presentation.value.attention)
        } finally {
          paused.resume()
          first.cancelAndJoin()
          second.cancelAndJoin()
          fresh?.cancelAndJoin()
        }
      } finally {
        ownerScope.close({ pendingCallers.asSequence() }) {
          firstGrant.cancel()
          replacementGrant.cancel()
          paused.resume()
        }
      }
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

  @Test fun acknowledgedSignOutPreventsHeldDiscoveryFromTransmittingItsToken() =
    runBlocking {
      val (socketFactory, fingerprint) = gatewayTestTls()
      val server = MockWebServer()
      server.useHttps(socketFactory, false)
      server.enqueue(MockResponse().setResponseCode(200))
      server.enqueue(MockResponse().setResponseCode(200))
      server.start()
      val target = GatewayEndpoint.manual("localhost", server.port, true, "/gateway/socket")
      val targetTls = GatewayTlsParams(true, fingerprint, false, target.stableId)
      val descriptor = application.copy(origin = CloudflareAccessOrigin.from(server.url("/").toString()))
      val registry = registry()
      add(registry, target)
      val storage = Storage()
      storage.values[descriptor.origin] = sessionFor(descriptor).encode()
      val hold = AtomicBoolean(false)
      val entered = CompletableDeferred<Unit>()
      val settled = CompletableDeferred<Unit>()
      val release = CountDownLatch(1)
      val config = checkNotNull(buildGatewayTlsConfig(targetTls))
      val transport =
        OkHttpClient
          .Builder()
          .sslSocketFactory(config.sslSocketFactory, config.trustManager)
          .hostnameVerifier(config.hostnameVerifier)
          .addNetworkInterceptor { chain ->
            if (!hold.get()) return@addNetworkInterceptor chain.proceed(chain.request())
            entered.complete(Unit)
            try {
              check(release.await(5, TimeUnit.SECONDS)) { "Discovery test gate was not released" }
              chain.proceed(chain.request())
            } finally {
              settled.complete(Unit)
            }
          }.build()
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
      val owner =
        GatewayIngressController(scope, registry, storage.persistence, { emptyMap() }, {}, clientForRoute = { _, _ ->
          client(descriptor = { descriptor }) {
            if (it.header("Cf-Access-Token") == null) true else CloudflareAccessClient.send(it, 0, 5, transport).code == 302
          }
        })
      var pending: Deferred<Result<GatewayIngressAuthorization?>>? = null
      try {
        assertNotNull(withTimeout(5_000) { owner.prepare(target, targetTls, false, owner.admissionCheckpoint()) { true } })
        assertEquals(1, server.requestCount)
        assertNotNull(server.takeRequest().getHeader("Cf-Access-Token"))
        hold.set(true)
        pending = async { runCatching { owner.prepare(target, targetTls, false, owner.admissionCheckpoint()) { true } } }
        withTimeout(5_000) { entered.await() }
        withTimeout(5_000) { checkNotNull(owner.signOut(target.stableId)).await() }
        assertTrue(withTimeout(5_000) { pending.await() }.exceptionOrNull() is CancellationException)
        assertNull(storage.values[descriptor.origin])
        assertEquals(listOf(descriptor.origin), storage.deleted)
        assertEquals(1, server.requestCount)
        release.countDown()
        withTimeout(5_000) { settled.await() }
        assertEquals(1, server.requestCount)
        assertNull(owner.presentation.value.browserLaunch)
      } finally {
        release.countDown()
        pending?.cancelAndJoin()
        if (entered.isCompleted) withTimeout(5_000) { settled.await() }
        scope.coroutineContext[Job]?.cancelAndJoin()
        transport.dispatcher.executorService.shutdown()
        transport.connectionPool.evictAll()
        server.shutdown()
      }

      val replacement = PinnedIngressFixture()
      var oldProbe: Deferred<Result<GatewayIngressAuthorization>>? = null
      try {
        replacement.prepare()
        replacement.holdNextDiscovery.set(true)
        oldProbe = async { runCatching { replacement.prepare() } }
        withTimeout(5_000) { replacement.discoveryEntered.await() }
        replacement.replace()
        assertTrue(withTimeout(5_000) { oldProbe.await() }.exceptionOrNull() is CancellationException)
        val firstRequests = replacement.requests.count { it.getHeader("Cf-Access-Token") == replacement.firstHeader }
        replacement.releaseDiscovery.countDown()
        withTimeout(5_000) { replacement.discoverySettled.await() }
        assertEquals(firstRequests, replacement.requests.count { it.getHeader("Cf-Access-Token") == replacement.firstHeader })
        replacement.prepare()
        assertTrue(replacement.requests.any { it.getHeader("Cf-Access-Token") == replacement.secondHeader })
        assertEquals(1, replacement.authentications)
      } finally {
        withContext(NonCancellable) {
          replacement.releaseDiscovery.countDown()
          oldProbe?.cancel()
          replacement.close()
          oldProbe?.join()
        }
      }
    }

  @Test fun canonicalIpv6OriginsRestoreStorageRegistryAndAdmitCurrentLeases() =
    runTest {
      val context = RuntimeEnvironment.getApplication()
      val prefs = SecurePrefs(context, context.getSharedPreferences("access-ipv6-" + UUID.randomUUID(), Context.MODE_PRIVATE))
      val persistence = CloudflareAccessSessionStore.Persistence.securePrefs(prefs)
      val expanded = CloudflareAccessOrigin.from("wss://[0:0:0:0:0:0:0:1]:8443/gateway/socket")
      val canonical = CloudflareAccessOrigin.from("https://[::1]:8443")
      val descriptor = application.copy(origin = expanded)
      val session = sessionFor(descriptor)
      assertTrue(persistence.save(expanded, session.encode()))
      assertEquals(session.encode(), persistence.load(canonical))
      val restoredStore = CloudflareAccessSessionStore(backgroundScope, persistence, retireTransports = {})
      val snapshot = checkNotNull(restoredStore.snapshot(canonical))
      assertEquals(descriptor, snapshot.session.application)
      assertSame(snapshot, restoredStore.snapshot(expanded))

      val target = GatewayEndpoint.manual("0:0:0:0:0:0:0:1", 8443, true, "/gateway/socket")
      val registry = GatewayRegistryStore(prefs)
      add(registry, target)
      assertTrue(registry.setAccessOrigin(target.stableId, expanded))
      val restoredRegistry = GatewayRegistryStore(prefs)
      assertSingleAccessOrigin("https://[::1]:8443", restoredRegistry)
      var probes = 0
      val owner =
        GatewayIngressController(
          backgroundScope,
          restoredRegistry,
          persistence,
          { emptyMap() },
          {},
          clientForRoute = { _, _ ->
            client(descriptor = { descriptor }, probe = { request ->
              probes++
              if (probes == 1) {
                assertNull(request.header("Cf-Access-Token"))
                true
              } else {
                assertEquals(session.authorizationHeader(request.url.toString()), request.header("Cf-Access-Token"))
                false
              }
            })
          },
        )
      val lease = checkNotNull(owner.prepare(target, GatewayTlsParams(true, null, false, target.stableId), false, owner.admissionCheckpoint()) { true })
      for (url in listOf("wss://[::1]:8443/gateway/socket", "https://[0:0:0:0:0:0:0:1]:8443/media")) {
        val request = Request.Builder().url(url).build()
        lease.requireCurrent(request)
        assertEquals(session.authorizationHeader(request.url.toString()), lease.authorizeUpgrade(request).header("Cf-Access-Token"))
      }
      assertEquals(4, probes)
      for (url in listOf("https://[::2]:8443/media", "https://[::1]:8444/media", "http://[::1]:8443/media")) {
        val failure = runCatching { lease.requireCurrent(Request.Builder().url(url).build()) }.exceptionOrNull()
        assertTrue(failure is GatewayExternalAuthorizationException)
      }
      restoredStore.forget(expanded).task.await()
      assertNull(persistence.load(canonical))
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
