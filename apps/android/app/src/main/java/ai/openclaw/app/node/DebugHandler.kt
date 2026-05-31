package ai.openclaw.app.node

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.serialization.json.JsonPrimitive
import java.io.InputStream
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

private const val LOGCAT_PATH = "/system/bin/logcat"
private const val LOGCAT_TIMEOUT_MS = 4_000L
private const val LOGCAT_MAX_CHARS = 128_000

class DebugHandler(
  private val identityStore: DeviceIdentityStore,
) {
  fun handleEd25519(): GatewaySession.InvokeResult {
    if (!BuildConfig.DEBUG) {
      return GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = "debug commands are disabled in release builds")
    }
    // Self-test Ed25519 signing and return diagnostic info
    try {
      val identity = identityStore.loadOrCreate()
      val testPayload = "test|${identity.deviceId}|${System.currentTimeMillis()}"
      val results = mutableListOf<String>()
      results.add("deviceId: ${identity.deviceId}")
      results.add("publicKeyRawBase64: ${identity.publicKeyRawBase64.take(20)}...")
      results.add("privateKeyPkcs8Base64: ${identity.privateKeyPkcs8Base64.take(20)}...")

      // Test publicKeyBase64Url
      val pubKeyUrl = identityStore.publicKeyBase64Url(identity)
      results.add("publicKeyBase64Url: ${pubKeyUrl ?: "NULL (FAILED)"}")

      // Test signing
      val signature = identityStore.signPayload(testPayload, identity)
      results.add("signPayload: ${if (signature != null) "${signature.take(20)}... (OK)" else "NULL (FAILED)"}")

      // Test self-verify
      if (signature != null) {
        val verifyOk = identityStore.verifySelfSignature(testPayload, signature, identity)
        results.add("verifySelfSignature: $verifyOk")
      }

      // Check available providers
      val providers = java.security.Security.getProviders()
      val ed25519Providers =
        providers.filter { p ->
          p.services.any { s -> s.algorithm.contains("Ed25519", ignoreCase = true) }
        }
      results.add("Ed25519 providers: ${ed25519Providers.map { "${it.name} v${it.version}" }}")
      results.add("Provider order: ${providers.take(5).map { it.name }}")

      // Test KeyFactory directly
      try {
        val kf = java.security.KeyFactory.getInstance("Ed25519")
        results.add("KeyFactory.Ed25519: ${kf.provider.name} (OK)")
      } catch (e: Throwable) {
        results.add("KeyFactory.Ed25519: FAILED - ${e.javaClass.simpleName}: ${e.message}")
      }

      // Test Signature directly
      try {
        val sig = java.security.Signature.getInstance("Ed25519")
        results.add("Signature.Ed25519: ${sig.provider.name} (OK)")
      } catch (e: Throwable) {
        results.add("Signature.Ed25519: FAILED - ${e.javaClass.simpleName}: ${e.message}")
      }

      val diagnostics = results.joinToString("\n")
      return GatewaySession.InvokeResult.ok("""{"diagnostics":${JsonPrimitive(diagnostics)}}""")
    } catch (e: Throwable) {
      return GatewaySession.InvokeResult.error(
        code = "ED25519_TEST_FAILED",
        message = "${e.javaClass.simpleName}: ${e.message}\n${e.stackTraceToString().take(500)}",
      )
    }
  }

  fun handleLogs(): GatewaySession.InvokeResult {
    if (!BuildConfig.DEBUG) {
      return GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = "debug commands are disabled in release builds")
    }
    val pid = android.os.Process.myPid()
    val rt = Runtime.getRuntime()
    val info = "v6 pid=$pid thread=${Thread.currentThread().name} free=${rt.freeMemory() / 1024}K total=${rt.totalMemory() / 1024}K max=${rt.maxMemory() / 1024}K uptime=${android.os.SystemClock.elapsedRealtime() / 1000}s sdk=${android.os.Build.VERSION.SDK_INT} device=${android.os.Build.MODEL}\n"
    // Run logcat on current dispatcher thread; output is bounded by -t and never staged to disk.
    val logResult =
      try {
        val pb = ProcessBuilder(LOGCAT_PATH, "-d", "-t", "200", "--pid=$pid")
        pb.redirectErrorStream(true)
        val proc = pb.start()
        val (finished, raw) = collectProcessOutput(proc, LOGCAT_TIMEOUT_MS, LOGCAT_MAX_CHARS)
        val normalizedRaw = raw.ifBlank { "(no output, finished=$finished)" }
        val spamPatterns =
          listOf(
            "setRequestedFrameRate",
            "I View    :",
            "BLASTBufferQueue",
            "VRI[Pop-Up",
            "InsetsController:",
            "VRI[MainActivity",
            "InsetsSource:",
            "handleResized",
            "ProfileInstaller",
            "I VRI[",
            "onStateChanged: host=",
            "D StrictMode:",
            "E StrictMode:",
            "ImeFocusController",
            "InputTransport",
            "IncorrectContextUseViolation",
          )
        val sb = StringBuilder()
        for (line in normalizedRaw.lineSequence()) {
          if (line.isBlank()) continue
          if (spamPatterns.any { line.contains(it) }) continue
          if (sb.length + line.length > 16000) {
            sb.append("\n(truncated)")
            break
          }
          if (sb.isNotEmpty()) sb.append('\n')
          sb.append(line)
        }
        sb.toString().ifEmpty { "(all ${normalizedRaw.lines().size} lines filtered as spam)" }
      } catch (e: Throwable) {
        "(logcat error: ${e::class.java.simpleName}: ${e.message})"
      }
    return GatewaySession.InvokeResult.ok("""{"logs":${JsonPrimitive(info + logResult)}}""")
  }
}

internal fun collectProcessOutput(
  process: Process,
  timeoutMs: Long,
  maxChars: Int,
): Pair<Boolean, String> {
  val output = AtomicReference("")
  val failure = AtomicReference<Throwable?>(null)
  val reader =
    Thread({
      try {
        output.set(readBoundedText(process.inputStream, maxChars))
      } catch (error: Throwable) {
        failure.set(error)
      }
    }, "openclaw-debug-output-reader")
  reader.isDaemon = true
  reader.start()

  val finished = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
  if (!finished) {
    process.destroyForcibly()
  }
  reader.join(1_000)
  failure.get()?.let { throw it }
  return finished to output.get()
}

private fun readBoundedText(
  stream: InputStream,
  maxChars: Int,
): String =
  stream.bufferedReader().use { reader ->
    val out = StringBuilder(minOf(maxChars, 8192))
    val buffer = CharArray(4096)
    while (true) {
      val read = reader.read(buffer)
      if (read < 0) break
      val remaining = maxChars - out.length
      if (remaining > 0) {
        out.append(buffer, 0, minOf(read, remaining))
      }
    }
    out.toString()
  }
