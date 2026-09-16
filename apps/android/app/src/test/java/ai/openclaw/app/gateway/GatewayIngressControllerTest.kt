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
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import okhttp3.Headers
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.lang.management.ManagementFactory
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
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
    val persistence =
      CloudflareAccessSessionStore.Persistence(
        load = { values[it] },
        save = { origin, value ->
          values[origin] = value
          true
        },
        delete = {
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

  private fun client(probe: suspend (Request) -> Boolean = { it.header("Cf-Access-Token") == null }): CloudflareAccessClient =
    CloudflareAccessClient { request, _, _ ->
      when {
        request.url.host == application.issuer.host -> {
          CloudflareAccessClient.Reply(request.url.toString(), 200, Headers.Builder().build(), CloudflareAccessTestTokens.jwks)
        }

        request.method == "HEAD" -> {
          CloudflareAccessClient.Reply(request.url.toString(), 200, Headers.Builder().add("Cf-Access-Metadata", CloudflareAccessTestTokens.metadata()).build(), byteArrayOf())
        }

        else -> {
          val challenged = probe(request)
          val headers = Headers.Builder()
          if (challenged) headers.add("WWW-Authenticate", "Cloudflare-Access resource_metadata=\"${application.origin.uri}/.well-known/cloudflare-access-protected-resource/gateway/socket\"")
          CloudflareAccessClient.Reply(request.url.toString(), if (challenged) 302 else 200, headers.build(), byteArrayOf())
        }
      }
    }

  @Test fun ordinaryAndServiceHeaderRoutesNeverPresentBrowser() =
    runTest {
      val registry = registry()
      var prompts = 0
      val owner =
        GatewayIngressController(backgroundScope, registry, Storage().persistence, { mapOf("Cf-Access-Client-Id" to "service-id") }, {}, clientForRoute = { _, _ ->
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
      val owner = GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() })
      assertTrue(runCatching { owner.prepare(endpoint, tls, false, admissionCheckpoint = owner.admissionCheckpoint()) { true } }.exceptionOrNull() is GatewayExternalAuthorizationException)
      assertEquals(
        endpoint.stableId,
        owner.presentation.value.attention
          ?.stableId,
      )
      assertNull(owner.presentation.value.browserLaunch)
      assertEquals(
        application.origin.uri.toString(),
        registry.entries.value
          .single()
          .accessOrigin,
      )
    }

  @Test fun aNewChallengeClearsPreviousOrdinaryAdmissionBeforeInteractiveLogin() =
    runTest {
      val registry = registry()
      var challenged = false
      val owner = GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client { challenged } })
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
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, clientForRoute = { target, _ ->
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

  @Test fun cachedGrantDoesNotEnrollIndependentServiceHeaderAdmission() =
    runTest {
      val registry = registry()
      val storage = Storage()
      storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
      val requests = mutableListOf<Request>()
      val owner =
        GatewayIngressController(backgroundScope, registry, storage.persistence, { mapOf("Cf-Access-Client-Id" to "service-id") }, {}, clientForRoute = { _, _ ->
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
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, clientForRoute = { _, _ ->
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
      val owner = GatewayIngressController(backgroundScope, registry(), storage.persistence, { emptyMap() }, { retirement.await() }, clientForRoute = { _, _ -> client() })
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
            assertEquals(
              "Signing out…",
              owner.presentation.value.attention
                ?.message,
            )
            storage.persistence.delete(origin)
          },
        )
      owner = GatewayIngressController(backgroundScope, registry(), persistence, { emptyMap() }, { drain.await() }, clientForRoute = { _, _ -> client() })
      val lease = checkNotNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
      val stopped = checkNotNull(owner.signOut(endpoint.stableId))
      try {
        runCurrent()
        assertEquals(
          "Signing out…",
          owner.presentation.value.attention
            ?.message,
        )
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
      val owner = GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, { drain.await() })
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
              }, clientForRoute = { _, _ -> client { false } })
            try {
              if (ordinarySibling) {
                assertNull(owner.prepare(sibling, tls.copy(stableId = sibling.stableId), false, owner.admissionCheckpoint()) { true })
                assertEquals(
                  application.origin.uri.toString(),
                  registry.entries.value
                    .first { it.stableId == sibling.stableId }
                    .accessOrigin,
                )
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
              GatewayIngressController(scope, registry, storage.persistence, { emptyMap() }, { drain.await() }, clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
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
          GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, { drain.await() }, clientForRoute = { _, _ -> client() }, authenticate = { _, _ ->
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
          GatewayIngressController(scope, registry, storage.persistence, { emptyMap() }, { drain.await() }, clientForRoute = { target, _ ->
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
          GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, { drain.await() }, clientForRoute = { _, _ ->
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
      var holdProbe = false
      val owner =
        GatewayIngressController(backgroundScope, registry(), storage.persistence, { emptyMap() }, { retirement.await() }, clientForRoute = { _, _ ->
          client {
            if (it.header("Cf-Access-Token") == null) {
              true
            } else {
              if (holdProbe) release.await()
              false
            }
          }
        })
      val old = checkNotNull(owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true })
      holdProbe = true
      val checkpoint = owner.admissionCheckpoint()
      val pending = async(UnconfinedTestDispatcher(testScheduler)) { runCatching { owner.prepare(endpoint, tls, false, checkpoint) { true } } }
      assertFalse(pending.isCompleted)
      backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
        owner.presentation.collect { presentation ->
          if (presentation.attention?.message == "Signing out…") release.complete(Unit)
        }
      }
      val stopped = checkNotNull(owner.signOut(endpoint.stableId))
      assertTrue(pending.await().exceptionOrNull() is CancellationException)
      assertEquals("Signing out…", checkNotNull(owner.presentation.value.attention).message)
      assertTrue(runCatching { old.requireCurrent(Request.Builder().url(application.origin.uri.toString()).build()) }.exceptionOrNull() is GatewayExternalAuthorizationException)
      retirement.complete(Unit)
      stopped.await()
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
        GatewayIngressController(ownerScope, registry, persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
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
          }, now = { now }, clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
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
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, clientForRoute = { _, _ ->
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
        val owner = GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client { false } })
        assertNull(owner.prepare(replacement, tls, false, admissionCheckpoint = owner.admissionCheckpoint()) { true })
        assertNull(
          registry.entries.value
            .first { it.stableId == endpoint.stableId }
            .accessOrigin,
        )
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
          }, clientForRoute = { _, _ ->
            client {
              probes++
              false
            }
          })
        try {
          val pending = async { runCatching { owner.prepare(replacement, tls, false, owner.admissionCheckpoint()) { true } } }
          runCurrent()
          assertTrue(entered)
          assertEquals(
            application.origin.uri.toString(),
            restoredRegistry()
              .entries.value
              .single()
              .accessOrigin,
          )
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
          assertEquals(
            application.origin.uri.toString(),
            restoredRegistry()
              .entries.value
              .single()
              .accessOrigin,
          )
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
          val cold = GatewayIngressController(backgroundScope, coldRegistry, storage.persistence, { emptyMap() }, { retired += it }, clientForRoute = { _, _ -> client { false } })
          if (failure == "delete") {
            cold.forget(endpoint.stableId)
            assertTrue(coldRegistry.remove(endpoint.stableId))
          } else {
            assertNull(cold.prepare(replacement, tls, false, cold.admissionCheckpoint()) { true })
            assertNull(
              restoredRegistry()
                .entries.value
                .single()
                .accessOrigin,
            )
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
        }, clientForRoute = { _, _ -> client { false } })
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
        assertEquals(
          application.origin.uri.toString(),
          registry.entries.value
            .first { it.stableId == sibling.stableId }
            .accessOrigin,
        )
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
          }, clientForRoute = { target, _ ->
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
          assertEquals(
            application.origin.uri.toString(),
            registry.entries.value
              .single()
              .accessOrigin,
          )
          assertTrue(probes.isEmpty())
          secondDrain.complete(Unit)
          assertNull(second.await().getOrThrow())
          assertNull(
            registry.entries.value
              .single()
              .accessOrigin,
          )
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
          }, clientForRoute = { target, _ -> client { target.host != departing.host && it.header("Cf-Access-Token") == null } }, authenticate = { _, _ -> CloudflareAccessTestTokens.session("fresh") })
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
          assertEquals(
            application.origin.uri.toString(),
            registry.entries.value
              .first { it.stableId == incoming.stableId }
              .accessOrigin,
          )
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
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
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
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
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
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, now = { now }, clientForRoute = { _, _ ->
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
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
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
        GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
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
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
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
        assertEquals(
          application.origin.uri.toString(),
          registry.entries.value
            .single()
            .accessOrigin,
        )
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
        val owner = GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() })
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
          GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
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
        GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
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
        GatewayIngressController(backgroundScope, registry(), Storage().persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
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
        }, clientForRoute = { _, _ -> client() })
      try {
        owner.prepare(endpoint, tls, false, owner.admissionCheckpoint()) { true }
        owner.prepare(sibling, tls.copy(stableId = sibling.stableId), false, owner.admissionCheckpoint()) { true }
        checkNotNull(owner.signOut(endpoint.stableId)).await()
        runCurrent()
        assertTrue(nested)
        assertEquals(
          sibling.stableId,
          owner.presentation.value.attention
            ?.stableId,
        )
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
        val owner = GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() })
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
        GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
          open("https://example.cloudflareaccess.com/login")
          CompletableDeferred<CloudflareAccessSession>().await()
        })
      checkNotNull(owner.signOut(endpoint.stableId)).await()
      checkNotNull(owner.retry(owner.admissionCheckpoint()) { true }).reportFailure("Saved endpoint unavailable")
      assertEquals(
        "Saved endpoint unavailable",
        owner.presentation.value.attention
          ?.message,
      )
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
      assertEquals(
        "Current retry failed",
        owner.presentation.value.attention
          ?.message,
      )
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
              GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, { drain.await() }, clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
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
        GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, { drain.await() }, clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
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
      val registry = registry()
      val sibling = endpoint.copy(stableId = "ordinary-retry-sibling")
      add(registry, sibling)
      registry.setAccessOrigin(endpoint.stableId, application.origin)
      val owner = GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, clientForRoute = { target, _ -> client { target.stableId != sibling.stableId } })
      checkNotNull(owner.signOut(endpoint.stableId)).await()
      val checkpoint = owner.admissionCheckpoint()
      val queued = checkNotNull(owner.retry(checkpoint) { true })
      checkNotNull(owner.signOut(endpoint.stableId)).await()
      val signedOut = owner.presentation.value
      assertTrue(runCatching { queued.prepare(endpoint, tls) }.exceptionOrNull() is CancellationException)
      assertEquals(signedOut, owner.presentation.value)
      assertNull(owner.presentation.value.browserLaunch)
      assertNull(owner.prepare(sibling, tls.copy(stableId = sibling.stableId), false, checkpoint) { true })
      assertEquals(signedOut.attention, owner.presentation.value.attention)
    }

  @Test fun retryAcquisitionRejectsReplacementButCanReplaceItsOwnRegistration() =
    runTest {
      val registry = registry()
      val owner =
        GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
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
        GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, clientForRoute = { target, _ ->
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
      assertNull(
        registry.entries.value
          .single()
          .accessOrigin,
      )
      retry.reportFailure(checkNotNull(error).message!!)
      assertEquals(
        "Replacement discovery failed",
        owner.presentation.value.attention
          ?.message,
      )
      val fresh = checkNotNull(owner.retry(owner.admissionCheckpoint()) { true })
      fail = false
      assertNull(fresh.prepare(replacement, tls))
      assertNull(owner.presentation.value.attention)
      assertNull(owner.presentation.value.browserLaunch)
      assertFalse(owner.blocksAutomaticReconnect(endpoint.stableId))
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
          GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
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
          assertEquals(
            application.origin.uri.toString(),
            registry.entries.value
              .first { it.stableId == endpoint.stableId }
              .accessOrigin,
          )
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
            assertEquals(
              application.origin.uri.toString(),
              registry.entries.value
                .first { it.stableId == endpoint.stableId }
                .accessOrigin,
            )
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

  @Test fun sharedWaiterCannotPublishForRetiredProfileAndFailureBelongsToBrowserOwner() =
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
          GatewayIngressController(ownerScope, registry, storage.persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
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
            assertEquals(
              endpoint.stableId,
              owner.presentation.value.attention
                ?.stableId,
            )
          } else {
            assertTrue(second.await().exceptionOrNull() is CancellationException)
            assertEquals(attention, owner.presentation.value.attention)
            assertEquals(launch, owner.presentation.value.browserLaunch)
          }
          firstDispatcher.resume()
          runCurrent()
          if (outcome == "failure") {
            assertTrue(first.await().exceptionOrNull() is java.io.IOException)
            assertEquals(
              endpoint.stableId,
              owner.presentation.value.attention
                ?.stableId,
            )
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
      val owner = GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, { retirements++ }, now = { now }, clientForRoute = { _, _ -> client() })
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
          val owner = GatewayIngressController(scope, registry, storage.persistence, { emptyMap() }, { if (failDrain) throw java.io.IOException("test-only drain failure") }, now = { now }, clientForRoute = { _, _ -> client() })
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
          }, clientForRoute = { _, _ -> client() }, authenticate = { _, _ -> CloudflareAccessTestTokens.session("replacement") })
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
        GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, { retirements++ }, now = { now }, clientForRoute = { target, _ ->
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
      val owner = GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() })
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
      val owner = GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, { retirements++ }, now = { now }, clientForRoute = { _, _ -> client() })
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

      fun owner() = GatewayIngressController(backgroundScope, registry, storage.persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() })
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
        GatewayIngressController(backgroundScope, registry, Storage().persistence, { emptyMap() }, {}, clientForRoute = { _, _ -> client() }, authenticate = { _, open ->
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
}
