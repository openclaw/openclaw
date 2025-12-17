package com.steipete.clawdis.node.node

import android.graphics.Bitmap
import android.os.Build
import android.graphics.Canvas
import android.webkit.WebView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import android.util.Base64
import kotlin.coroutines.resume

class CanvasController {
  enum class Mode { CANVAS, WEB }

  @Volatile private var webView: WebView? = null
  @Volatile private var mode: Mode = Mode.CANVAS
  @Volatile private var url: String = ""

  fun attach(webView: WebView) {
    this.webView = webView
    reload()
  }

  fun setMode(mode: Mode) {
    this.mode = mode
    reload()
  }

  fun navigate(url: String) {
    this.url = url
    reload()
  }

  private fun reload() {
    val wv = webView ?: return
    when (mode) {
      Mode.WEB -> {
        // Match iOS behavior: if URL is missing/invalid, keep the current page (canvas scaffold).
        val trimmed = url.trim()
        if (trimmed.isBlank()) return
        wv.loadUrl(trimmed)
      }
      Mode.CANVAS -> wv.loadDataWithBaseURL(null, canvasHtml, "text/html", "utf-8", null)
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
    fun parseMode(paramsJson: String?): Mode {
      val raw = paramsJson ?: return Mode.CANVAS
      return if (raw.contains("\"web\"")) Mode.WEB else Mode.CANVAS
    }

    fun parseNavigateUrl(paramsJson: String?): String? {
      val raw = paramsJson ?: return null
      val key = "\"url\""
      val idx = raw.indexOf(key)
      if (idx < 0) return null
      val start = raw.indexOf('"', idx + key.length)
      if (start < 0) return null
      val end = raw.indexOf('"', start + 1)
      if (end < 0) return null
      return raw.substring(start + 1, end)
    }

    fun parseEvalJs(paramsJson: String?): String? {
      val raw = paramsJson ?: return null
      val key = "\"javaScript\""
      val idx = raw.indexOf(key)
      if (idx < 0) return null
      val start = raw.indexOf('"', idx + key.length)
      if (start < 0) return null
      val end = raw.lastIndexOf('"')
      if (end <= start) return null
      return raw.substring(start + 1, end)
        .replace("\\n", "\n")
        .replace("\\\"", "\"")
        .replace("\\\\", "\\")
    }

    fun parseSnapshotMaxWidth(paramsJson: String?): Int? {
      val raw = paramsJson ?: return null
      val key = "\"maxWidth\""
      val idx = raw.indexOf(key)
      if (idx < 0) return null
      val colon = raw.indexOf(':', idx + key.length)
      if (colon < 0) return null
      val tail = raw.substring(colon + 1).trimStart()
      val num = tail.takeWhile { it.isDigit() }
      return num.toIntOrNull()
    }
  }
}

private val canvasHtml =
  """
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>Canvas</title>
      <style>
        :root { color-scheme: dark; }
        @media (prefers-reduced-motion: reduce) {
          body::before, body::after { animation: none !important; }
        }
        html,body { height:100%; margin:0; }
        body {
          background: transparent;
          overflow: hidden;
        }
        canvas {
          display:block;
          width:100vw;
          height:100vh;
          touch-action: none;
        }
        #clawdis-status {
          position: fixed;
          inset: 0;
          display: grid;
          place-items: center;
          pointer-events: none;
        }
        #clawdis-status .card {
          text-align: center;
          padding: 16px 18px;
          border-radius: 14px;
          background: rgba(18, 18, 22, 0.70);
          border: 1px solid rgba(255,255,255,0.08);
          box-shadow: 0 18px 60px rgba(0,0,0,0.55);
          backdrop-filter: blur(14px);
        }
        #clawdis-status .title {
          font: 600 20px -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif;
          letter-spacing: 0.2px;
          color: rgba(255,255,255,0.92);
          text-shadow: 0 0 22px rgba(42, 113, 255, 0.35);
        }
        #clawdis-status .subtitle {
          margin-top: 6px;
          font: 500 12px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
          color: rgba(255,255,255,0.58);
        }
      </style>
    </head>
    <body>
      <canvas id="clawdis-canvas"></canvas>
      <div id="clawdis-status">
        <div class="card">
          <div class="title" id="clawdis-status-title">Ready</div>
          <div class="subtitle" id="clawdis-status-subtitle">Waiting for agent</div>
        </div>
      </div>
      <script>
        (() => {
          const canvas = document.getElementById('clawdis-canvas');
          const ctx = canvas.getContext('2d');
          const statusEl = document.getElementById('clawdis-status');
          const titleEl = document.getElementById('clawdis-status-title');
          const subtitleEl = document.getElementById('clawdis-status-subtitle');

          function resize() {
            const dpr = window.devicePixelRatio || 1;
            const w = Math.max(1, Math.floor(window.innerWidth * dpr));
            const h = Math.max(1, Math.floor(window.innerHeight * dpr));
            canvas.width = w;
            canvas.height = h;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          }

          window.addEventListener('resize', resize);
          resize();

          window.__clawdis = {
            canvas,
            ctx,
            setStatus: (title, subtitle) => {
              if (!statusEl) return;
              if (!title && !subtitle) {
                statusEl.style.display = 'none';
                return;
              }
              statusEl.style.display = 'grid';
              if (titleEl && typeof title === 'string') titleEl.textContent = title;
              if (subtitleEl && typeof subtitle === 'string') subtitleEl.textContent = subtitle;
            }
          };
        })();
      </script>
    </body>
  </html>
  """.trimIndent()
