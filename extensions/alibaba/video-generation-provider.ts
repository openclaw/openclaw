import { buildDashscopeVideoGenerationProvider } from "openclaw/plugin-sdk/video-generation";

const DEFAULT_ALIBABA_VIDEO_BASE_URL = "https://dashscope-intl.aliyuncs.com";

function isAlibabaVideoEndpointSupported(baseUrl: string | undefined): boolean {
  const hostname = URL.parse(baseUrl ?? DEFAULT_ALIBABA_VIDEO_BASE_URL)?.hostname ?? "";
  return !/^(?:coding(?:-intl)?\.dashscope|token-plan\..+\.maas)\.aliyuncs\.com\.?$/iu.test(
    hostname,
  );
}

export const alibabaVideoGenerationProvider = buildDashscopeVideoGenerationProvider({
  providerId: "alibaba",
  label: "Alibaba Model Studio",
  taskLabel: "Alibaba Wan",
  defaultBaseUrl: DEFAULT_ALIBABA_VIDEO_BASE_URL,
  credentialPolicy: {
    // Coding/Token Plan keys share Alibaba's env aliases but cannot authenticate Wan requests.
    acceptsApiKey: (apiKey) => !apiKey.trim().startsWith("sk-sp-"),
    acceptsBaseUrl: isAlibabaVideoEndpointSupported,
    unsupportedMessage:
      "Alibaba Wan video generation requires a Standard DashScope endpoint and a same-region Standard API key; Coding Plan and Token Plan credentials are not supported.",
  },
});
