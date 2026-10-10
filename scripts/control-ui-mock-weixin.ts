import type { ControlUiMockGateway } from "../ui/src/test-helpers/control-ui-e2e.ts";

/** Synthetic login only; the QR contains a demo marker and never contacts Tencent. */
function installWeixinLoginMock(qrDataUrl: string) {
  const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    throw new Error("Missing mock Gateway");
  }
  let cancelled = false;
  let verified = false;
  const sessionKey = "weixin-demo-session";
  let expiresAtMs = 0;
  const mode = new URL(window.location.href).searchParams.get("weixinDemo");
  const result = () => ({ connected: false, qrDataUrl, sessionKey, expiresAtMs });
  gateway.setRequestHandler("web.login.start", ({ params, respond }) => {
    const input = params as { channel?: string };
    if (input.channel !== "openclaw-weixin") {
      respond({ message: "Scan WhatsApp demo QR", qrDataUrl });
      return;
    }
    cancelled = false;
    verified = false;
    expiresAtMs = Date.now() + (mode === "expired" ? 3_000 : 300_000);
    respond({ ...result(), message: "Demo: this QR cannot sign in to Weixin." });
  });
  gateway.setRequestHandler("web.login.wait", ({ params, respond }) => {
    const input = params as { channel?: string; sessionKey?: string };
    if (input.channel !== "openclaw-weixin") {
      respond({ connected: true, message: "WhatsApp demo linked" });
      return;
    }
    if (cancelled || input.sessionKey !== sessionKey) {
      respond({ cancelled: true, connected: false });
      return;
    }
    if (mode === "error") {
      respond({
        connected: false,
        message: "Demo: Weixin returned no saved credentials. Reconnect to retry.",
      });
      return;
    }
    if (verified) {
      respond({
        connected: true,
        accountId: "weixin-demo-account",
        message: "Demo login confirmed; no real Weixin account was connected.",
      });
      return;
    }
    respond({
      ...result(),
      verificationRequired: mode === "verify",
      message:
        mode === "verify"
          ? "Demo: enter the number shown on your phone."
          : "Demo: waiting for a scan.",
    });
  });
  gateway.setRequestHandler("weixin.login.control", ({ params, respond }) => {
    const input = params as { action: string };
    if (input.action === "capabilities") {
      respond({ ok: true, supportsPageLogin: true });
      return;
    }
    cancelled = input.action === "cancel";
    verified = input.action === "verify";
    respond({ ok: true });
  });
}

export function weixinLoginMockInitScript(qrDataUrl: string) {
  return `(() => { const __name = (target) => target; (${installWeixinLoginMock.toString()})(${JSON.stringify(qrDataUrl)}); })();`;
}
