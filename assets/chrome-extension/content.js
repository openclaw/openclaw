// OpenClaw content script — DOM scanning, form filling, clicking, and page reading.
//
// Provides a non-CDP fallback channel for cases where Playwright's CDP approach
// fails: CSP restrictions, shadow DOM edge cases, cross-origin iframes,
// government sites with framesets, and React/Vue controlled inputs that ignore
// raw CDP DOM.setAttributeValue calls.
//
// The background service worker routes custom relay methods (OpenClaw.scanPage,
// OpenClaw.fillFields, etc.) to this script via chrome.tabs.sendMessage().

// Idempotency guard — prevent duplicate listeners on re-injection.
if (window.__openclawContentLoaded) {
  // Already loaded.
} else {
  window.__openclawContentLoaded = true

  // ---------------------------------------------------------------------------
  // Message router
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'OC_SCAN_PAGE') {
      sendResponse(scanPage())
    } else if (msg.type === 'OC_FILL_FIELDS') {
      fillFieldsAnimated(msg.fields, msg.delayMs || 100).then((result) => {
        sendResponse(result)
      })
      return true // async
    } else if (msg.type === 'OC_CLICK') {
      sendResponse(clickElement(msg.selector))
    } else if (msg.type === 'OC_CLICK_BY_TEXT') {
      sendResponse(clickByText(msg.text))
    } else if (msg.type === 'OC_READ_PAGE') {
      sendResponse(readPage(msg.selector))
    } else if (msg.type === 'OC_EXECUTE_JS') {
      sendResponse(executeSafeJS(msg.code))
    } else if (msg.type === 'OC_GET_PAGE_INFO') {
      const selection = window.getSelection()?.toString()?.trim()
      const meta = document.querySelector('meta[name="description"]')?.content || ''
      sendResponse({
        title: document.title,
        url: window.location.href,
        selectedText: selection || '',
        description: meta,
      })
    }
    return true
  })

  // ---------------------------------------------------------------------------
  // Selector builder
  // ---------------------------------------------------------------------------

  function buildSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`
    if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`
    for (const attr of ['data-field', 'data-name', 'data-id', 'data-testid']) {
      const val = el.getAttribute(attr)
      if (val) return `[${attr}="${CSS.escape(val)}"]`
    }
    const parent = el.parentElement
    if (parent) {
      const siblings = Array.from(parent.querySelectorAll(`:scope > ${el.tagName.toLowerCase()}`))
      const idx = siblings.indexOf(el)
      if (idx >= 0 && siblings.length > 1) {
        const parentSel = parent.id
          ? `#${CSS.escape(parent.id)}`
          : parent.className
            ? `.${CSS.escape(parent.className.split(' ')[0])}`
            : null
        if (parentSel) return `${parentSel} > ${el.tagName.toLowerCase()}:nth-of-type(${idx + 1})`
      }
    }
    return null
  }

  // ---------------------------------------------------------------------------
  // Deep querySelector — pierces shadow DOM
  // ---------------------------------------------------------------------------

  function querySelectorAllDeep(selector, root) {
    const results = []
    function traverse(node) {
      try {
        results.push(...node.querySelectorAll(selector))
      } catch {
        /* ignore */
      }
      try {
        node.querySelectorAll('*').forEach((el) => {
          if (el.shadowRoot) traverse(el.shadowRoot)
        })
      } catch {
        /* ignore */
      }
    }
    traverse(root || document)
    return results
  }

  // ---------------------------------------------------------------------------
  // Rich label detection (8 strategies)
  // ---------------------------------------------------------------------------

  function getFieldLabel(el, doc) {
    // 1. Explicit <label for="id">
    if (el.id) {
      const explicitLabel = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (explicitLabel) return explicitLabel.textContent.trim()
    }
    // 2. Wrapping <label>
    const wrapLabel = el.closest('label')
    if (wrapLabel) return wrapLabel.textContent.trim()
    // 3. el.labels API
    if (el.labels?.[0]) return el.labels[0].textContent.trim()
    // 4. aria-label
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label')
    // 5. aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy && doc) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent?.trim())
        .filter(Boolean)
      if (parts.length) return parts.join(' ')
    }
    // 6. Preceding sibling label/span/td (common in table-based gov forms)
    const prev = el.previousElementSibling
    if (prev) {
      const tag = prev.tagName?.toLowerCase()
      if (tag === 'label' || tag === 'span' || tag === 'td' || tag === 'th') {
        const t = prev.textContent?.trim()
        if (t && t.length < 100) return t
      }
    }
    // 7. Parent cell's preceding cell (table forms: <td>Label</td><td><input></td>)
    const parentTd = el.closest('td')
    if (parentTd) {
      const prevTd = parentTd.previousElementSibling
      if (prevTd) {
        const t = prevTd.textContent?.trim()
        if (t && t.length < 100) return t
      }
    }
    // 8. placeholder, name, title
    return el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || ''
  }

  // ---------------------------------------------------------------------------
  // Field group detection (fieldset legend / nearest heading)
  // ---------------------------------------------------------------------------

  function getFieldGroup(el) {
    const fieldset = el.closest('fieldset')
    if (fieldset) {
      const legend = fieldset.querySelector('legend')
      if (legend) return legend.textContent.trim()
    }
    let node = el
    for (let i = 0; i < 10 && node; i++) {
      node = node.parentElement
      if (!node) break
      const heading = node.querySelector(
        ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > legend, :scope > .section-title',
      )
      if (heading) return heading.textContent.trim()
    }
    return undefined
  }

  // ---------------------------------------------------------------------------
  // Page scanning — multi-frame with shadow DOM piercing
  // ---------------------------------------------------------------------------

  const PAYMENT_KEYWORDS = [
    'credit card',
    'card number',
    'cvv',
    'cvc',
    'expiry',
    'billing',
    'payment method',
    'pay now',
    'checkout',
    'debit card',
  ]
  const CAPTCHA_KEYWORDS = [
    'captcha',
    'security code',
    'verification code',
    'type the characters',
    'type the text',
    'enter the code',
    'security check',
  ]

  function scanPage() {
    const allFields = []
    const allButtons = []
    const allLinks = []
    const allSections = []
    const allErrors = []
    const allInstructions = []

    function scanDocument(doc, frameLabel) {
      if (!doc || !doc.body) return

      // Form fields (deep: pierces shadow DOM)
      const elements = querySelectorAllDeep(
        'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="listbox"], [role="spinbutton"]',
        doc,
      )
      elements.forEach((el) => {
        if (el.type === 'hidden') return
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) return

        const label = getFieldLabel(el, doc)
        const selector = buildSelector(el)
        if (!selector) return

        const ariaInvalid = el.getAttribute('aria-invalid')
        const hasError =
          ariaInvalid === 'true' || el.classList.contains('error') || el.classList.contains('invalid')

        allFields.push({
          tag: el.tagName.toLowerCase(),
          type: el.type || el.getAttribute('role') || '',
          name: el.name || '',
          id: el.id || '',
          label,
          value: el.value || el.textContent?.trim()?.slice(0, 200) || '',
          selector,
          required: el.required || el.getAttribute('aria-required') === 'true',
          disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
          readOnly: el.readOnly || false,
          options:
            el.tagName === 'SELECT'
              ? Array.from(el.options).map((o) => ({ value: o.value, text: o.text }))
              : undefined,
          group: getFieldGroup(el),
          validationError: hasError ? el.validationMessage || 'invalid' : undefined,
          frame: frameLabel,
        })
      })

      // Buttons
      const btnElements = querySelectorAllDeep(
        'button, [type="submit"], [type="reset"], [role="button"], input[type="button"], input[type="image"], a.btn, a.button, .btn, [onclick]',
        doc,
      )
      btnElements.forEach((el) => {
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) return
        const text =
          el.textContent?.trim() ||
          el.getAttribute('aria-label') ||
          el.getAttribute('value') ||
          el.getAttribute('title') ||
          ''
        if (!text || text.length > 200) return
        const selector = buildSelector(el) || (el.id ? `#${el.id}` : null)
        allButtons.push({
          text: text.slice(0, 100),
          selector,
          type: el.type || el.tagName.toLowerCase(),
          frame: frameLabel,
        })
      })

      // Navigation links (important for multi-page forms)
      doc
        .querySelectorAll(
          'a[href], [role="tab"], [role="link"], nav a, .nav a, .tabs a, .breadcrumb a, .pagination a',
        )
        .forEach((el) => {
          const rect = el.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) return
          const text = el.textContent?.trim() || el.getAttribute('aria-label') || ''
          if (!text || text.length > 150) return
          const href = el.getAttribute('href') || ''
          if (href.startsWith('javascript:') || href === '#') return
          allLinks.push({ text: text.slice(0, 80), href, selector: buildSelector(el), frame: frameLabel })
        })

      // Page structure
      doc
        .querySelectorAll(
          'h1, h2, h3, h4, legend, [role="heading"], .section-title, .step-title, .page-title',
        )
        .forEach((el) => {
          const text = el.textContent?.trim()
          if (text && text.length < 200) {
            allSections.push({ level: el.tagName?.toLowerCase() || 'heading', text, frame: frameLabel })
          }
        })

      // Error messages
      doc
        .querySelectorAll(
          '.error, .alert-danger, .alert-error, [role="alert"], .validation-error, .field-error, .form-error, .text-danger, .error-message, .errorMsg',
        )
        .forEach((el) => {
          const text = el.textContent?.trim()
          if (text && text.length > 0 && text.length < 500) {
            allErrors.push({ text, frame: frameLabel })
          }
        })

      // Instructions / help text
      doc
        .querySelectorAll(
          '.help-text, .hint, .instructions, .form-text, .description, [role="note"], .info-box, .alert-info, .notice',
        )
        .forEach((el) => {
          const text = el.textContent?.trim()
          if (text && text.length > 10 && text.length < 500) {
            allInstructions.push({ text, frame: frameLabel })
          }
        })
    }

    // Scan top document
    scanDocument(document, 'top')

    // Recursively scan same-origin frames (critical for gov sites using framesets)
    function scanFrames(doc, depth) {
      if (depth > 3) return
      for (const frameEl of doc.querySelectorAll('frame, iframe')) {
        try {
          const childDoc = frameEl.contentDocument
          if (!childDoc || childDoc === doc) continue
          if (childDoc.readyState !== 'complete' && childDoc.readyState !== 'interactive') continue
          const label = frameEl.name || frameEl.id || frameEl.src?.split('/').pop() || `frame-${depth}`
          scanDocument(childDoc, label)
          scanFrames(childDoc, depth + 1)
        } catch {
          // Cross-origin — skip.
        }
      }
    }
    scanFrames(document, 0)

    // Aggregate page text for signals
    let fullPageText = document.body?.innerText || ''
    for (const frameEl of document.querySelectorAll('frame, iframe')) {
      try {
        const ft = frameEl.contentDocument?.body?.innerText || ''
        if (ft) fullPageText += '\n' + ft
      } catch {
        /* cross-origin */
      }
    }
    const pageText = fullPageText.toLowerCase()
    const fieldLabels = allFields.map((f) => f.label.toLowerCase()).join(' ')
    const isPaymentPage = PAYMENT_KEYWORDS.some((kw) => pageText.includes(kw) || fieldLabels.includes(kw))
    const hasCaptcha = detectCaptcha(pageText)

    // Progress / breadcrumb detection
    let progress = null
    const progressSel =
      '[role="progressbar"], .progress-bar, .step-indicator, .breadcrumb, .wizard-steps, .steps'
    let progressEl = document.querySelector(progressSel)
    if (!progressEl) {
      for (const frameEl of document.querySelectorAll('frame, iframe')) {
        try {
          progressEl = frameEl.contentDocument?.querySelector(progressSel)
          if (progressEl) break
        } catch {
          /* cross-origin */
        }
      }
    }
    if (progressEl) {
      progress =
        progressEl.textContent?.trim()?.slice(0, 200) || progressEl.getAttribute('aria-valuenow') || null
    }

    return {
      url: window.location.href,
      title: document.title,
      formCount: document.querySelectorAll('form').length,
      fields: allFields,
      buttons: allButtons,
      links: allLinks.slice(0, 30),
      sections: allSections,
      errors: allErrors,
      instructions: allInstructions.slice(0, 10),
      progress,
      isPaymentPage,
      hasCaptcha,
      visibleText: fullPageText.slice(0, 2000),
    }
  }

  // ---------------------------------------------------------------------------
  // CAPTCHA detection
  // ---------------------------------------------------------------------------

  function detectCaptcha(pageText) {
    if (CAPTCHA_KEYWORDS.some((kw) => pageText.includes(kw))) return true
    for (const img of document.querySelectorAll('img')) {
      const src = (img.src || '').toLowerCase()
      const alt = (img.alt || '').toLowerCase()
      const id = (img.id || '').toLowerCase()
      const cls = (img.className || '').toLowerCase()
      if (
        src.includes('captcha') ||
        alt.includes('captcha') ||
        id.includes('captcha') ||
        cls.includes('captcha')
      )
        return true
    }
    for (const iframe of document.querySelectorAll('iframe')) {
      const src = (iframe.src || '').toLowerCase()
      if (src.includes('recaptcha') || src.includes('hcaptcha') || src.includes('captcha')) return true
    }
    return false
  }

  // ---------------------------------------------------------------------------
  // Animated form filling — React/Vue compatible via native setters
  // ---------------------------------------------------------------------------

  async function fillFieldsAnimated(fields, delayMs) {
    const results = []

    for (const field of fields) {
      await new Promise((r) => setTimeout(r, delayMs))

      // Search top document first, then same-origin frames
      let el = document.querySelector(field.selector)
      if (!el) {
        for (const frameEl of document.querySelectorAll('frame, iframe')) {
          try {
            el = frameEl.contentDocument?.querySelector(field.selector)
            if (el) break
          } catch {
            /* cross-origin */
          }
        }
      }
      if (!el) {
        results.push({ selector: field.selector, label: field.label, status: 'not_found' })
        continue
      }

      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      await new Promise((r) => setTimeout(r, 50))

      // Visual feedback
      const originalOutline = el.style.outline
      const originalTransition = el.style.transition
      el.style.transition = 'outline 0.2s'
      el.style.outline = '2px solid #FF5A36' // OpenClaw orange

      if (el.tagName === 'SELECT') {
        const option =
          Array.from(el.options).find((o) => o.value === field.value) ||
          Array.from(el.options).find(
            (o) => o.text.trim().toLowerCase() === field.value.toLowerCase(),
          ) ||
          Array.from(el.options).find(
            (o) =>
              o.text.trim().toLowerCase().includes(field.value.toLowerCase()) ||
              field.value.toLowerCase().includes(o.text.trim().toLowerCase()),
          )
        if (option) {
          el.selectedIndex = option.index
          option.selected = true
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLSelectElement.prototype,
            'value',
          )?.set
          if (nativeSetter) nativeSetter.call(el, option.value)
          else el.value = option.value
          el.dispatchEvent(new Event('change', { bubbles: true }))
        } else {
          el.value = field.value
          el.dispatchEvent(new Event('change', { bubbles: true }))
        }
      } else if (el.type === 'radio') {
        el.checked = true
        el.dispatchEvent(new Event('change', { bubbles: true }))
        el.dispatchEvent(new Event('click', { bubbles: true }))
      } else if (el.type === 'checkbox') {
        const shouldCheck = field.value === 'true' || field.value === '1' || field.value === 'yes'
        if (el.checked !== shouldCheck) {
          el.checked = shouldCheck
          el.dispatchEvent(new Event('change', { bubbles: true }))
          el.dispatchEvent(new Event('click', { bubbles: true }))
        }
      } else {
        // Text input/textarea — character-by-character with native setter for React compat.
        // Use element-specific setter: HTMLInputElement for inputs, HTMLTextAreaElement for textareas.
        const proto =
          el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        el.focus()
        // Clear existing value
        if (nativeSetter) nativeSetter.call(el, '')
        else el.value = ''
        el.dispatchEvent(new Event('input', { bubbles: true }))

        for (const char of field.value) {
          const current = el.value
          if (nativeSetter) nativeSetter.call(el, current + char)
          else el.value = current + char
          el.dispatchEvent(new Event('input', { bubbles: true }))
          await new Promise((r) => setTimeout(r, 15))
        }
        el.dispatchEvent(new Event('change', { bubbles: true }))
        el.dispatchEvent(new Event('blur', { bubbles: true }))
      }

      await new Promise((r) => setTimeout(r, 300))
      el.style.outline = originalOutline
      el.style.transition = originalTransition

      results.push({ selector: field.selector, label: field.label, status: 'filled' })
    }

    return { status: 'complete', results }
  }

  // ---------------------------------------------------------------------------
  // Click by selector
  // ---------------------------------------------------------------------------

  function clickElement(selector) {
    let el = document.querySelector(selector)
    if (!el) {
      for (const frameEl of document.querySelectorAll('frame, iframe')) {
        try {
          el = frameEl.contentDocument?.querySelector(selector)
          if (el) break
        } catch {
          /* cross-origin */
        }
      }
    }
    if (!el) return { status: 'not_found', selector }

    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    if (el.style !== undefined) {
      const orig = el.style.outline
      el.style.outline = '2px solid #F59E0B'
      setTimeout(() => {
        el.style.outline = orig
      }, 500)
    }
    el.click()

    return {
      status: 'clicked',
      selector,
      text: el.textContent?.trim()?.slice(0, 100) || '',
      url: window.location.href,
    }
  }

  // ---------------------------------------------------------------------------
  // Click by visible text
  // ---------------------------------------------------------------------------

  function clickByText(text) {
    const lowerText = text.toLowerCase()
    const docs = [document]
    for (const frameEl of document.querySelectorAll('frame, iframe')) {
      try {
        if (frameEl.contentDocument) docs.push(frameEl.contentDocument)
      } catch {
        /* cross-origin */
      }
    }

    for (const doc of docs) {
      const candidates = doc.querySelectorAll(
        'button, a, [type="submit"], [role="button"], input[type="button"], input[type="submit"], .btn, .button',
      )
      for (const el of candidates) {
        const elText = (
          el.textContent?.trim() ||
          el.getAttribute('value') ||
          el.getAttribute('aria-label') ||
          ''
        ).toLowerCase()
        if (elText && (elText.includes(lowerText) || lowerText.includes(elText))) {
          const rect = el.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) continue
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          if (el.style !== undefined) {
            const orig = el.style.outline
            el.style.outline = '2px solid #F59E0B'
            setTimeout(() => {
              el.style.outline = orig
            }, 500)
          }
          el.click()
          return {
            status: 'clicked',
            text: el.textContent?.trim()?.slice(0, 100) || '',
            url: window.location.href,
          }
        }
      }
    }
    return { status: 'not_found', text }
  }

  // ---------------------------------------------------------------------------
  // Read page text
  // ---------------------------------------------------------------------------

  function readPage(selector) {
    let text = ''
    if (!selector) {
      text = (document.body?.innerText || '').slice(0, 3000)
      for (const frameEl of document.querySelectorAll('frame, iframe')) {
        try {
          const frameText = frameEl.contentDocument?.body?.innerText || ''
          if (frameText)
            text +=
              '\n--- [frame: ' + (frameEl.name || frameEl.src || 'iframe') + '] ---\n' + frameText.slice(0, 3000)
        } catch {
          /* cross-origin */
        }
      }
      text = text.slice(0, 8000)
    } else {
      let target = document.querySelector(selector)
      if (!target) {
        for (const frameEl of document.querySelectorAll('frame, iframe')) {
          try {
            target = frameEl.contentDocument?.querySelector(selector)
            if (target) break
          } catch {
            /* cross-origin */
          }
        }
      }
      if (!target) return { status: 'not_found', selector }
      text = target.innerText?.slice(0, 5000) || ''
    }

    const lowerText = text.toLowerCase()
    return {
      status: 'ok',
      title: document.title,
      url: window.location.href,
      text,
      indicators: {
        hasSuccess:
          lowerText.includes('success') ||
          lowerText.includes('confirmed') ||
          lowerText.includes('thank you'),
        hasError:
          lowerText.includes('error') || lowerText.includes('failed') || lowerText.includes('invalid'),
      },
    }
  }

  // ---------------------------------------------------------------------------
  // CSP-safe JS execution — pattern-matches common agent DOM commands
  // instead of eval (which is blocked by MV3 CSP).
  // ---------------------------------------------------------------------------

  function executeSafeJS(code) {
    try {
      // Pattern: enumerate form elements
      if (
        code.includes('querySelectorAll') &&
        (code.includes('.map(') || code.includes('JSON.stringify'))
      ) {
        const fields = Array.from(document.querySelectorAll('select, input, textarea, button'))
          .slice(0, 30)
          .map((e) => ({
            tag: e.tagName,
            id: e.id,
            name: e.name,
            type: e.type,
            value: e.value,
            options:
              e.tagName === 'SELECT'
                ? Array.from(e.options)
                    .slice(0, 20)
                    .map((o) => o.text + ':' + o.value)
                : undefined,
          }))
        return { status: 'executed', result: JSON.stringify(fields) }
      }

      // Pattern: set value on a specific element
      const setValueMatch = code.match(
        /querySelector\(\s*['"](.+?)['"]\s*\)[\s\S]*?\.value\s*=\s*['"](.+?)['"]/,
      )
      if (setValueMatch) {
        const [, selector, value] = setValueMatch
        const el = document.querySelector(selector)
        if (!el) return { status: 'executed', result: 'element not found: ' + selector }
        if (el.tagName === 'SELECT') {
          const opt =
            Array.from(el.options).find((o) => o.value === value) ||
            Array.from(el.options).find((o) => o.text.trim().toLowerCase() === value.toLowerCase()) ||
            Array.from(el.options).find((o) => o.text.trim().toLowerCase().includes(value.toLowerCase()))
          if (opt) {
            el.selectedIndex = opt.index
            opt.selected = true
            el.value = opt.value
          } else {
            el.value = value
          }
        } else {
          const proto =
            el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
          const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
          if (nativeSetter) nativeSetter.call(el, value)
          else el.value = value
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { status: 'executed', result: 'done' }
      }

      // Pattern: click an element
      const clickMatch = code.match(/querySelector\(\s*['"](.+?)['"]\s*\)\.click\(\)/)
      if (clickMatch) {
        const el = document.querySelector(clickMatch[1])
        if (!el) return { status: 'executed', result: 'element not found: ' + clickMatch[1] }
        el.click()
        return { status: 'executed', result: 'clicked' }
      }

      // Pattern: read text content
      if (code.includes('innerText') || code.includes('textContent')) {
        const selectorMatch = code.match(/querySelector\(\s*['"](.+?)['"]\s*\)/)
        const el = selectorMatch ? document.querySelector(selectorMatch[1]) : document.body
        const text = (el?.innerText || el?.textContent || '').slice(0, 3000)
        return { status: 'executed', result: text }
      }

      // Pattern: dispatch event
      const eventMatch = code.match(/querySelector\(\s*['"](.+?)['"]\s*\)\.dispatchEvent/)
      if (eventMatch) {
        const el = document.querySelector(eventMatch[1])
        if (!el) return { status: 'executed', result: 'element not found' }
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { status: 'executed', result: 'done' }
      }

      // Pattern: get element property
      const getPropMatch = code.match(/querySelector\(\s*['"](.+?)['"]\s*\)\.(\w+)/)
      if (getPropMatch) {
        const el = document.querySelector(getPropMatch[1])
        if (!el) return { status: 'executed', result: 'element not found: ' + getPropMatch[1] }
        const prop = el[getPropMatch[2]]
        return { status: 'executed', result: typeof prop === 'object' ? JSON.stringify(prop) : String(prop) }
      }

      return {
        error:
          'Cannot execute arbitrary JS (CSP restriction). Use OpenClaw.scanPage, OpenClaw.fillFields, or OpenClaw.clickElement relay methods instead.',
      }
    } catch (e) {
      return { error: e.message }
    }
  }

  // Close idempotency guard.
}
