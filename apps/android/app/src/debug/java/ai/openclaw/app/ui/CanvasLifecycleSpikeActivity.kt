package ai.openclaw.app.ui

import android.annotation.SuppressLint
import android.content.Context
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger

const val canvasLifecycleSlowPageDelayMs = 2_000L

class CanvasLifecycleSpikeActivity : ComponentActivity() {
  lateinit var host: CanvasLifecycleSpikeHost
    private set

  var underlayClickCount: Int = 0
    private set

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      CanvasLifecycleSpikeContent(
        onHostCreated = { host = it },
        onUnderlayClick = { underlayClickCount += 1 },
      )
    }
  }

  fun presentSlowPage(): Long = host.present(slowPageHtml)

  fun presentFastPage(): Long = host.present("<html><body>ready</body></html>")

  fun hideCanvas() {
    host.hide()
  }
}

@Composable
private fun CanvasLifecycleSpikeContent(
  onHostCreated: (CanvasLifecycleSpikeHost) -> Unit,
  onUnderlayClick: () -> Unit,
) {
  Box(modifier = Modifier.fillMaxSize()) {
    AndroidView(
      factory = { context ->
        Button(context).apply {
          text = "Underlying shell control"
          setOnClickListener { onUnderlayClick() }
        }
      },
      modifier = Modifier.fillMaxSize(),
    )
    AndroidView(
      factory = { context ->
        CanvasLifecycleSpikeHost(context).also(onHostCreated)
      },
      modifier = Modifier.fillMaxSize(),
      onRelease = { host ->
        host.release()
        CanvasLifecycleSpikeMetrics.hostReleaseCount.incrementAndGet()
      },
    )
  }
}

@SuppressLint("SetJavaScriptEnabled")
class CanvasLifecycleSpikeHost(
  context: Context,
) : FrameLayout(context) {
  var currentWebView: WebView? = null
    private set

  var webViewCreateCount: Int = 0
    private set

  var webViewDestroyCount: Int = 0
    private set

  val isCanvasVisible: Boolean
    get() = visibility == View.VISIBLE

  private var pageFinished = CountDownLatch(1)
  private var rendererGone = CountDownLatch(1)

  init {
    visibility = View.INVISIBLE
  }

  fun nextPageFinished(): CountDownLatch =
    CountDownLatch(1).also {
      pageFinished = it
    }

  fun nextRendererGone(): CountDownLatch =
    CountDownLatch(1).also {
      rendererGone = it
    }

  fun present(html: String): Long {
    val startedAt = SystemClock.elapsedRealtime()
    val webView = currentWebView ?: createWebView()
    visibility = View.VISIBLE
    webView.visibility = View.VISIBLE
    webView.onResume()
    webView.resumeTimers()
    webView.loadDataWithBaseURL("https://openclaw.invalid/", html, "text/html", "UTF-8", null)
    return SystemClock.elapsedRealtime() - startedAt
  }

  fun hide() {
    visibility = View.INVISIBLE
    currentWebView?.let { webView ->
      webView.onPause()
      webView.pauseTimers()
      webView.visibility = View.INVISIBLE
    }
  }

  fun terminateRenderer(): Boolean = currentWebView?.webViewRenderProcess?.terminate() == true

  fun release() {
    currentWebView?.let(::destroyWebView)
  }

  private fun createWebView(): WebView =
    WebView(context).also { webView ->
      webViewCreateCount += 1
      webView.settings.javaScriptEnabled = true
      webView.webViewClient =
        object : WebViewClient() {
          override fun onPageFinished(
            view: WebView,
            url: String?,
          ) {
            pageFinished.countDown()
          }

          override fun onRenderProcessGone(
            view: WebView,
            detail: RenderProcessGoneDetail,
          ): Boolean {
            if (view === currentWebView) {
              destroyWebView(view)
              visibility = View.INVISIBLE
            }
            rendererGone.countDown()
            return true
          }
        }
      addView(
        webView,
        ViewGroup.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.MATCH_PARENT,
        ),
      )
      currentWebView = webView
    }

  private fun destroyWebView(webView: WebView) {
    if (currentWebView !== webView) return
    removeView(webView)
    webView.stopLoading()
    webView.destroy()
    currentWebView = null
    webViewDestroyCount += 1
    CanvasLifecycleSpikeMetrics.webViewDestroyCount.incrementAndGet()
  }
}

object CanvasLifecycleSpikeMetrics {
  val hostReleaseCount = AtomicInteger()
  val webViewDestroyCount = AtomicInteger()

  fun reset() {
    hostReleaseCount.set(0)
    webViewDestroyCount.set(0)
  }
}

private val slowPageHtml =
  """
  <html>
    <body>
      <script>
        const deadline = Date.now() + $canvasLifecycleSlowPageDelayMs;
        while (Date.now() < deadline) {}
      </script>
      ready
    </body>
  </html>
  """.trimIndent()
