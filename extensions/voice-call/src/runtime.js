import { resolveVoiceCallConfig, validateProviderConfig } from "./config.js";
import { CallManager } from "./manager.js";
import { MockProvider } from "./providers/mock.js";
import { PlivoProvider } from "./providers/plivo.js";
import { TelnyxProvider } from "./providers/telnyx.js";
import { TwilioProvider } from "./providers/twilio.js";
import { createTelephonyTtsProvider } from "./telephony-tts.js";
import { startTunnel } from "./tunnel.js";
import { VoiceCallWebhookServer } from "./webhook.js";
import { cleanupTailscaleExposure, setupTailscaleExposure } from "./webhook/tailscale.js";
function createRuntimeResourceLifecycle(params) {
  let tunnelResult = null;
  let stopped = false;
  const runStep = async (step, suppressErrors) => {
    if (suppressErrors) {
      await step().catch(() => {
      });
      return;
    }
    await step();
  };
  return {
    setTunnelResult: (result) => {
      tunnelResult = result;
    },
    stop: async (opts) => {
      if (stopped) {
        return;
      }
      stopped = true;
      const suppressErrors = opts?.suppressErrors ?? false;
      await runStep(async () => {
        if (tunnelResult) {
          await tunnelResult.stop();
        }
      }, suppressErrors);
      await runStep(async () => {
        await cleanupTailscaleExposure(params.config);
      }, suppressErrors);
      await runStep(async () => {
        await params.webhookServer.stop();
      }, suppressErrors);
    }
  };
}
function isLoopbackBind(bind) {
  if (!bind) {
    return false;
  }
  return bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
}
function resolveProvider(config) {
  const allowNgrokFreeTierLoopbackBypass = config.tunnel?.provider === "ngrok" && isLoopbackBind(config.serve?.bind) && (config.tunnel?.allowNgrokFreeTierLoopbackBypass ?? false);
  switch (config.provider) {
    case "telnyx":
      return new TelnyxProvider(
        {
          apiKey: config.telnyx?.apiKey,
          connectionId: config.telnyx?.connectionId,
          publicKey: config.telnyx?.publicKey
        },
        {
          skipVerification: config.skipSignatureVerification
        }
      );
    case "twilio":
      return new TwilioProvider(
        {
          accountSid: config.twilio?.accountSid,
          authToken: config.twilio?.authToken
        },
        {
          allowNgrokFreeTierLoopbackBypass,
          publicUrl: config.publicUrl,
          skipVerification: config.skipSignatureVerification,
          streamPath: config.streaming?.enabled ? config.streaming.streamPath : void 0,
          webhookSecurity: config.webhookSecurity
        }
      );
    case "plivo":
      return new PlivoProvider(
        {
          authId: config.plivo?.authId,
          authToken: config.plivo?.authToken
        },
        {
          publicUrl: config.publicUrl,
          skipVerification: config.skipSignatureVerification,
          ringTimeoutSec: Math.max(1, Math.floor(config.ringTimeoutMs / 1e3)),
          webhookSecurity: config.webhookSecurity
        }
      );
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`Unsupported voice-call provider: ${String(config.provider)}`);
  }
}
async function createVoiceCallRuntime(params) {
  const { config: rawConfig, coreConfig, ttsRuntime, logger } = params;
  const log = logger ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug
  };
  const config = resolveVoiceCallConfig(rawConfig);
  if (!config.enabled) {
    throw new Error("Voice call disabled. Enable the plugin entry in config.");
  }
  if (config.skipSignatureVerification) {
    log.warn(
      "[voice-call] SECURITY WARNING: skipSignatureVerification=true disables webhook signature verification (development only). Do not use in production."
    );
  }
  const validation = validateProviderConfig(config);
  if (!validation.valid) {
    throw new Error(`Invalid voice-call config: ${validation.errors.join("; ")}`);
  }
  const provider = resolveProvider(config);
  const manager = new CallManager(config);
  const webhookServer = new VoiceCallWebhookServer(config, manager, provider, coreConfig);
  const lifecycle = createRuntimeResourceLifecycle({ config, webhookServer });
  const localUrl = await webhookServer.start();
  try {
    let publicUrl = config.publicUrl ?? null;
    if (!publicUrl && config.tunnel?.provider && config.tunnel.provider !== "none") {
      try {
        const nextTunnelResult = await startTunnel({
          provider: config.tunnel.provider,
          port: config.serve.port,
          path: config.serve.path,
          ngrokAuthToken: config.tunnel.ngrokAuthToken,
          ngrokDomain: config.tunnel.ngrokDomain
        });
        lifecycle.setTunnelResult(nextTunnelResult);
        publicUrl = nextTunnelResult?.publicUrl ?? null;
      } catch (err) {
        log.error(
          `[voice-call] Tunnel setup failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (!publicUrl && config.tailscale?.mode !== "off") {
      publicUrl = await setupTailscaleExposure(config);
    }
    const webhookUrl = publicUrl ?? localUrl;
    if (publicUrl && provider.name === "twilio") {
      provider.setPublicUrl(publicUrl);
    }
    if (provider.name === "twilio" && config.streaming?.enabled) {
      const twilioProvider = provider;
      if (ttsRuntime?.textToSpeechTelephony) {
        try {
          const ttsProvider = createTelephonyTtsProvider({
            coreConfig,
            ttsOverride: config.tts,
            runtime: ttsRuntime
          });
          twilioProvider.setTTSProvider(ttsProvider);
          log.info("[voice-call] Telephony TTS provider configured");
        } catch (err) {
          log.warn(
            `[voice-call] Failed to initialize telephony TTS: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } else {
        log.warn("[voice-call] Telephony TTS unavailable; streaming TTS disabled");
      }
      const mediaHandler = webhookServer.getMediaStreamHandler();
      if (mediaHandler) {
        twilioProvider.setMediaStreamHandler(mediaHandler);
        log.info("[voice-call] Media stream handler wired to provider");
      }
    }
    await manager.initialize(provider, webhookUrl);
    const stop = async () => await lifecycle.stop();
    log.info("[voice-call] Runtime initialized");
    log.info(`[voice-call] Webhook URL: ${webhookUrl}`);
    if (publicUrl) {
      log.info(`[voice-call] Public URL: ${publicUrl}`);
    }
    return {
      config,
      provider,
      manager,
      webhookServer,
      webhookUrl,
      publicUrl,
      stop
    };
  } catch (err) {
    await lifecycle.stop({ suppressErrors: true });
    throw err;
  }
}
export {
  createVoiceCallRuntime
};
