// Agent Eye — Content Script
// Injected into browser tabs to capture user actions and errors.
// Zero booleans. All state uses typed string enums with explicit equality checks.
// Privacy: NEVER captures input values — only field names.

;(() => {
  'use strict'

  // ---------------------------------------------------------------------------
  // Enums (must match background.js and server-side store.ts)
  // ---------------------------------------------------------------------------

  const ACTION_KIND = Object.freeze({
    CLICK: 'CLICK',
    INPUT: 'INPUT',
    SCROLL: 'SCROLL',
    NAVIGATE: 'NAVIGATE',
  })

  const TRIGGER_KIND = Object.freeze({
    JS_ERROR: 'JS_ERROR',
    UNHANDLED_REJECTION: 'UNHANDLED_REJECTION',
    CONSOLE_ERROR: 'CONSOLE_ERROR',
    NETWORK_ERROR: 'NETWORK_ERROR',
  })

  const REPORT_STATUS = Object.freeze({
    SENT: 'SENT',
    DROPPED: 'DROPPED',
    DEDUPED: 'DEDUPED',
  })

  // ---------------------------------------------------------------------------
  // Action buffer (circular, 50 max)
  // ---------------------------------------------------------------------------

  const MAX_ACTIONS = 50
  /** @type {Array<{kind: string, selector: string, text?: string, tag?: string, x?: number, y?: number, url?: string, timestamp: number}>} */
  const actionBuffer = []

  function pushAction(action) {
    actionBuffer.push(action)
    if (actionBuffer.length > MAX_ACTIONS) {
      actionBuffer.shift()
    }
  }

  // ---------------------------------------------------------------------------
  // Lightweight CSS selector — tagName + id/class, no expensive DOM walking
  // ---------------------------------------------------------------------------

  function quickSelector(el) {
    if (!el || !el.tagName) return ''
    let sel = el.tagName.toLowerCase()
    if (el.id) sel += '#' + el.id
    else if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.')
      if (cls) sel += '.' + cls
    }
    return sel
  }

  function visibleText(el) {
    if (!el) return ''
    const text = (el.textContent || '').trim()
    return text.slice(0, 60)
  }

  // ---------------------------------------------------------------------------
  // Rate limiter — max 10 reports per 5 seconds, dedup via message hash
  // ---------------------------------------------------------------------------

  const RATE_WINDOW_MS = 5000
  const RATE_MAX = 10
  /** @type {number[]} */
  const reportTimestamps = []
  /** @type {Set<string>} */
  const recentHashes = new Set()
  let hashCleanupTimer = 0

  function simpleHash(str) {
    let h = 0
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0
    }
    return String(h)
  }

  function canSendReport(message) {
    const now = Date.now()

    // Rate limit
    while (reportTimestamps.length > 0 && reportTimestamps[0] < now - RATE_WINDOW_MS) {
      reportTimestamps.shift()
    }
    if (reportTimestamps.length >= RATE_MAX) return REPORT_STATUS.DROPPED

    // Dedup
    const hash = simpleHash(message)
    if (recentHashes.has(hash)) return REPORT_STATUS.DEDUPED
    recentHashes.add(hash)

    // Clean up hashes every 10 seconds
    if (hashCleanupTimer === 0) {
      hashCleanupTimer = setTimeout(() => {
        recentHashes.clear()
        hashCleanupTimer = 0
      }, 10000)
    }

    reportTimestamps.push(now)
    return REPORT_STATUS.SENT
  }

  // ---------------------------------------------------------------------------
  // Send report to background.js
  // ---------------------------------------------------------------------------

  function sendReport(trigger, details) {
    const rateStatus = canSendReport(details.message || '')
    if (rateStatus !== REPORT_STATUS.SENT) return

    const report = {
      channel: 'AGENT_EYE_REPORT',
      trigger,
      payload: {
        ...details,
        url: location.href,
        timestamp: Date.now(),
        actions: actionBuffer.slice(),
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
      },
    }

    try {
      chrome.runtime.sendMessage(report)
    } catch {
      // Extension context invalidated — page outlived the extension
    }
  }

  // ---------------------------------------------------------------------------
  // User action listeners
  // ---------------------------------------------------------------------------

  // CLICK
  document.addEventListener(
    'click',
    (e) => {
      const target = /** @type {HTMLElement} */ (e.target)
      pushAction({
        kind: ACTION_KIND.CLICK,
        selector: quickSelector(target),
        text: visibleText(target),
        tag: target.tagName ? target.tagName.toLowerCase() : '',
        x: e.clientX,
        y: e.clientY,
        timestamp: Date.now(),
      })
    },
    { capture: true, passive: true },
  )

  // INPUT — captures field name ONLY, never values
  document.addEventListener(
    'input',
    (e) => {
      const target = /** @type {HTMLInputElement} */ (e.target)
      pushAction({
        kind: ACTION_KIND.INPUT,
        selector: quickSelector(target),
        tag: target.tagName ? target.tagName.toLowerCase() : '',
        text: target.name || target.getAttribute('aria-label') || target.placeholder || '',
        timestamp: Date.now(),
      })
    },
    { capture: true, passive: true },
  )

  // SCROLL — throttled to 1 per 500ms
  let lastScrollTime = 0
  document.addEventListener(
    'scroll',
    () => {
      const now = Date.now()
      if (now - lastScrollTime < 500) return
      lastScrollTime = now
      pushAction({
        kind: ACTION_KIND.SCROLL,
        selector: 'window',
        timestamp: now,
      })
    },
    { capture: true, passive: true },
  )

  // NAVIGATE — popstate (SPA navigation)
  window.addEventListener('popstate', () => {
    pushAction({
      kind: ACTION_KIND.NAVIGATE,
      selector: 'popstate',
      url: location.href,
      timestamp: Date.now(),
    })
  })

  // ---------------------------------------------------------------------------
  // Error triggers
  // ---------------------------------------------------------------------------

  // JS_ERROR — window.onerror
  const originalOnError = window.onerror
  window.onerror = function (message, filename, line, col, error) {
    sendReport(TRIGGER_KIND.JS_ERROR, {
      message: String(message),
      filename: filename || '',
      line: line || 0,
      col: col || 0,
      stack: error && error.stack ? error.stack : '',
    })
    if (typeof originalOnError === 'function') {
      return originalOnError.call(this, message, filename, line, col, error)
    }
  }

  // UNHANDLED_REJECTION — promise rejections
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason
    sendReport(TRIGGER_KIND.UNHANDLED_REJECTION, {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack || '' : '',
    })
  })

  // CONSOLE_ERROR — wraps console.error
  const originalConsoleError = console.error
  console.error = function (...args) {
    const message = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')
    sendReport(TRIGGER_KIND.CONSOLE_ERROR, {
      message: message.slice(0, 1000),
    })
    return originalConsoleError.apply(console, args)
  }

  // NETWORK_ERROR — wraps fetch()
  const originalFetch = window.fetch
  window.fetch = function (...args) {
    const request = args[0]
    let fetchUrl = ''
    let fetchMethod = 'GET'

    if (typeof request === 'string') {
      fetchUrl = request
    } else if (request instanceof URL) {
      fetchUrl = request.href
    } else if (request instanceof Request) {
      fetchUrl = request.url
      fetchMethod = request.method
    }

    if (typeof args[1] === 'object' && args[1] !== null && typeof args[1].method === 'string') {
      fetchMethod = args[1].method
    }

    return originalFetch.apply(window, args).then(
      (response) => {
        if (response.status >= 400) {
          sendReport(TRIGGER_KIND.NETWORK_ERROR, {
            message: `${fetchMethod} ${fetchUrl} → ${response.status} ${response.statusText}`,
            status: response.status,
            method: fetchMethod,
          })
        }
        return response
      },
      (error) => {
        sendReport(TRIGGER_KIND.NETWORK_ERROR, {
          message: `${fetchMethod} ${fetchUrl} → Network failure: ${error instanceof Error ? error.message : String(error)}`,
          method: fetchMethod,
        })
        throw error
      },
    )
  }
})()
