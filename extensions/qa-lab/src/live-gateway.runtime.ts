import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { startQaGatewayChild, type QaCliBackendAuthMode } from "./gateway-child.js";
import { startQaMockOpenAiServer } from "./mock-openai-server.js";
import type { QaThinkingLevel } from "./qa-gateway-config.js";

async function stopQaLiveLaneResources(resources: {
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>;
  mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | null;
}) {
  const errors: string[] = [];
  try {
    await resources.gateway.stop();
  } catch (error) {
    errors.push(`gateway stop failed: ${formatErrorMessage(error)}`);
  }
  if (resources.mock) {
    try {
      await resources.mock.stop();
    } catch (error) {
      errors.push(`mock provider stop failed: ${formatErrorMessage(error)}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`failed to stop QA live lane resources:\n${errors.join("\n")}`);
  }
}

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
      includeQaChannel: false,
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
        await stopQaLiveLaneResources({ gateway, mock });
      },
    };
  } catch (error) {
    await mock?.stop().catch(() => {});
    throw error;
  }
}
