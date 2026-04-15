(function () {
  const target = "http://127.0.0.1:18789";
  const startedAt = Date.now();
  let progress = 0;

  function byId(id) {
    return document.getElementById(id);
  }

  function setProgress(value, phase, status) {
    progress = Math.max(progress, Math.min(100, Math.round(value)));
    byId("bar-fill").style.width = `${progress}%`;
    byId("percent").textContent = `${progress}%`;
    if (phase) {
      byId("phase").textContent = phase;
    }
    if (status) {
      byId("status").textContent = status;
    }
  }

  function showError(message) {
    byId("error").textContent = message;
    byId("error").style.display = "block";
    byId("phase").textContent = "Failed";
  }

  async function waitForGateway() {
    while (Date.now() - startedAt < 180000) {
      if (window.__OPENCLAW_GATEWAY_START_ERROR) {
        throw new Error(window.__OPENCLAW_GATEWAY_START_ERROR);
      }
      if (window.__OPENCLAW_GATEWAY_READY) {
        setProgress(100, "Ready", "Opening OpenClaw…");
        window.location.replace(target);
        return;
      }
      const elapsed = Date.now() - startedAt;
      setProgress(
        Math.min(96, 18 + elapsed / 1600),
        "Loading",
        "Loading local gateway…",
      );
      try {
        const response = await fetch(`${target}/health`, { cache: "no-store" });
        if (response.ok) {
          setProgress(100, "Ready", "Opening OpenClaw…");
          await new Promise((resolve) => setTimeout(resolve, 250));
          window.location.replace(target);
          return;
        }
      } catch {
        // Keep polling until the local gateway is ready.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Gateway did not become ready on 127.0.0.1:18789.");
  }

  async function main() {
    try {
      setProgress(5, "Starting", "Loading local gateway…");
      await waitForGateway();
    } catch (error) {
      showError(String(error?.message || error));
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main, { once: true });
  } else {
    void main();
  }
})();
