import { verifyTwilioWebhook } from "../../webhook-security.js";
function verifyTwilioProviderWebhook(params) {
  const result = verifyTwilioWebhook(params.ctx, params.authToken, {
    publicUrl: params.currentPublicUrl || void 0,
    allowNgrokFreeTierLoopbackBypass: params.options.allowNgrokFreeTierLoopbackBypass ?? false,
    skipVerification: params.options.skipVerification,
    allowedHosts: params.options.webhookSecurity?.allowedHosts,
    trustForwardingHeaders: params.options.webhookSecurity?.trustForwardingHeaders,
    trustedProxyIPs: params.options.webhookSecurity?.trustedProxyIPs,
    remoteIP: params.ctx.remoteAddress
  });
  if (!result.ok) {
    console.warn(`[twilio] Webhook verification failed: ${result.reason}`);
    if (result.verificationUrl) {
      console.warn(`[twilio] Verification URL: ${result.verificationUrl}`);
    }
  }
  return {
    ok: result.ok,
    reason: result.reason,
    isReplay: result.isReplay,
    verifiedRequestKey: result.verifiedRequestKey
  };
}
export {
  verifyTwilioProviderWebhook
};
