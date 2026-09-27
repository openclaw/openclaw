(() => {
  const nonce = __GPUI_NONCE__;
  const control = __GPUI_CONTROL__;
  const documentId = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
  const post = payload => window.ipc.postMessage(JSON.stringify({ ...payload, nonce, document: documentId, viewportWidth: innerWidth, viewportHeight: innerHeight }));
  window.__OPENCLAW_GPUI_DOCUMENT__ = navigation => post({ type: 'gpui-document', navigation, url: location.href });
  post({ type: 'gpui-document-available' });
  addEventListener('pageshow', () => post({ type: 'gpui-document-available' }));
  const bridge = window.__OPENCLAW_NATIVE_PANEL__;
  window.__OPENCLAW_GPUI_ROUTE_ACK__ = url => post({
    type: 'gpui-route-ack', url,
    generation: window.__OPENCLAW_NATIVE_PRESENTATION__?.generation ?? 0,
  });
  let revision = 0;
  if (bridge) {
    const original = bridge.postMessage;
    bridge.postMessage = payload => {
      if (payload.type !== 'openclaw-presentation-state') { original(payload); return; }
      const current = ++revision;
      if (payload.phase === 'loading') { post(payload); return; }
      // The attached transparent native layer has committed the content before
      // its owner unmasks it; a superseding route cancels this receipt.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (current === revision) post(payload);
      }));
    };
  }
  if (!control || !bridge && location.protocol !== 'about:') {
    const loaded = async () => {
      await document.fonts?.ready;
      requestAnimationFrame(() => requestAnimationFrame(() => post({ type: 'gpui-reading-ready', url: location.href })));
    };
    window.__OPENCLAW_GPUI_READING_FRAME__ = () => {
      if (document.readyState === 'complete') void loaded();
    };
    if (document.readyState === 'complete') void loaded();
    else addEventListener('load', loaded, { once: true });
  }
})();
