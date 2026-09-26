// Debug-build proof: request to connected route content followed by two display frames.
(() => {
  let cancel;
  window.__OPENCLAW_GPUI_MEASURE__ = ({ id, url, control }) => {
    cancel?.();
    let frame;
    let stopped = false;
    const finish = () => {
      if (stopped) return;
      cancel();
      window.ipc.postMessage(JSON.stringify({ type: 'gpui-painted', id }));
    };
    const check = async () => {
      if (stopped) return;
      const outlet = document.querySelector('openclaw-router-outlet');
      const match = outlet?.router?.getState().matches?.[0];
      const target = new URL(url);
      const sameRoute = location.pathname === target.pathname && location.search === target.search;
      const panelReady = target.searchParams.get('slot') !== 'tasks' || Boolean(document.querySelector('.chat-tasks-rail openclaw-panel-empty-state, .chat-tasks-rail__list'));
      const settingsReady = !target.pathname.endsWith('/settings/appearance') || Boolean(document.querySelector('.settings-page .settings-group'));
      const ready = !control || (sameRoute && window.__OPENCLAW_NATIVE_GATEWAY_HEALTH__?.health === 'ok' && match?.status === 'success' && panelReady && settingsReady);
      if (ready && document.readyState !== 'loading') {
        await Promise.all([...document.querySelectorAll('*')].flatMap(el => el.updateComplete ? [el.updateComplete] : []));
        if (!stopped) frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
      } else {
        frame = requestAnimationFrame(check);
      }
    };
    const timeout = setTimeout(() => cancel(), 30000);
    cancel = () => { stopped = true; cancelAnimationFrame(frame); clearTimeout(timeout); };
    frame = requestAnimationFrame(check);
  };
})();
