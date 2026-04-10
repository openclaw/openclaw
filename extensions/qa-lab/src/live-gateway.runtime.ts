import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { startQaGatewayChild, type QaCliBackendAuthMode } from "./gateway-child.js";
import { startQaMockOpenAiServer } from "./mock-openai-server.js";
import type { QaThinkingLevel } from "./qa-gateway-config.js";

export async function startQaLiveLaneGateway(params: {
  repoRoot: string;
  qaBusBaseUrl: string;
  controlUiAllowedOrigins?: string[];
  providerMode: "mock-openai" | "live-frontier";
  primaryModel: string;
  alternateModel: string;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
  claudeCliAuthMode?: QaCliBackendAuthMode;
  controlUiEnabled?: boolean;
  mutateConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
}) {
  const mock =
    params.providerMode === "mock-openai"
      ? await startQaMockOpenAiServer({
          host: "127.0.0.1",
          port: 0,
        })
      : null;
  try {
    const gateway = await startQaGatewayChild({
      repoRoot: params.repoRoot,
      providerBaseUrl: mock ? `${mock.baseUrl}/v1` : undefined,
      qaBusBaseUrl: params.qaBusBaseUrl,
      controlUiAllowedOrigins: params.controlUiAllowedOrigins,
      providerMode: params.providerMode,
      primaryModel: params.primaryModel,
      alternateModel: params.alternateModel,
      fastMode: params.fastMode,
      thinkingDefault: params.thinkingDefault,
      claudeCliAuthMode: params.claudeCliAuthMode,
      controlUiEnabled: params.controlUiEnabled,
      mutateConfig: params.mutateConfig,
    });
    return {
      gateway,
      mock,
      async stop() {
        await gateway.stop();
        await mock?.stop();
      },
    };
  } catch (error) {
    await mock?.stop().catch(() => {});
    throw error;
  }
}
