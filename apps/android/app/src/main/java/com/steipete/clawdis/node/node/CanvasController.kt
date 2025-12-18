package com.steipete.clawdis.node.node

import android.graphics.Bitmap
import android.os.Build
import android.graphics.Canvas
import android.os.Looper
import android.webkit.WebView
import org.json.JSONObject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import android.util.Base64
import kotlin.coroutines.resume

class CanvasController {
  @Volatile private var webView: WebView? = null
  @Volatile private var url: String? = null

  private val scaffoldAssetUrl = "file:///android_asset/CanvasScaffold/scaffold.html"

  fun attach(webView: WebView) {
    this.webView = webView
    reload()
  }

  fun navigate(url: String) {
    val trimmed = url.trim()
    this.url = if (trimmed.isBlank() || trimmed == "/") null else trimmed
    reload()
  }

  private inline fun withWebViewOnMain(crossinline block: (WebView) -> Unit) {
    val wv = webView ?: return
    if (Looper.myLooper() == Looper.getMainLooper()) {
      block(wv)
    } else {
      wv.post { block(wv) }
    }
  }

  private fun reload() {
    val currentUrl = url
    withWebViewOnMain { wv ->
      if (currentUrl == null) {
        wv.loadUrl(scaffoldAssetUrl)
      } else {
        wv.loadUrl(currentUrl)
      }
    }
  }

  suspend fun eval(javaScript: String): String =
    withContext(Dispatchers.Main) {
      val wv = webView ?: throw IllegalStateException("no webview")
      suspendCancellableCoroutine { cont ->
        wv.evaluateJavascript(javaScript) { result ->
          cont.resume(result ?: "")
        }
      }
    }

  suspend fun snapshotPngBase64(maxWidth: Int?): String =
    withContext(Dispatchers.Main) {
      val wv = webView ?: throw IllegalStateException("no webview")
      val bmp = wv.captureBitmap()
      val scaled =
        if (maxWidth != null && maxWidth > 0 && bmp.width > maxWidth) {
          val h = (bmp.height.toDouble() * (maxWidth.toDouble() / bmp.width.toDouble())).toInt().coerceAtLeast(1)
          Bitmap.createScaledBitmap(bmp, maxWidth, h, true)
        } else {
          bmp
        }

      val out = ByteArrayOutputStream()
      scaled.compress(Bitmap.CompressFormat.PNG, 100, out)
      Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

  private suspend fun WebView.captureBitmap(): Bitmap =
    suspendCancellableCoroutine { cont ->
      val width = width.coerceAtLeast(1)
      val height = height.coerceAtLeast(1)
      val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)

      // WebView isn't supported by PixelCopy.request(...) directly; draw() is the most reliable
      // cross-version snapshot for this lightweight "canvas" use-case.
      draw(Canvas(bitmap))
      cont.resume(bitmap)
    }

  companion object {
    fun parseNavigateUrl(paramsJson: String?): String {
      val obj = parseParamsObject(paramsJson)
      return obj?.optString("url", "")?.trim().orEmpty()
    }

    fun parseEvalJs(paramsJson: String?): String? {
      val obj = parseParamsObject(paramsJson) ?: return null
      val js = obj.optString("javaScript", "")
      return js.takeIf { it.isNotBlank() }
    }

    fun parseSnapshotMaxWidth(paramsJson: String?): Int? {
      val obj = parseParamsObject(paramsJson) ?: return null
      if (!obj.has("maxWidth")) return null
      val width = obj.optInt("maxWidth", 0)
      return width.takeIf { it > 0 }
    }

    private fun parseParamsObject(paramsJson: String?): JSONObject? {
      val raw = paramsJson?.trim() ?: return null
      if (raw.isBlank()) return null
      return try {
        JSONObject(raw)
      } catch (_: Throwable) {
        null
      }
    }
  }
}
