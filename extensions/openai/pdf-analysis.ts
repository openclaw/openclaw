import type {
  PdfAnalysisRequest,
  PdfAnalysisResult,
} from "openclaw/plugin-sdk/media-understanding";
import {
  postJsonResponse,
  resolveProviderHttpRequestConfigWithOriginTrust,
  resolveProviderTransportSsrFPolicy,
} from "openclaw/plugin-sdk/provider-http";
import { classifyOpenAIBaseUrl, OPENAI_API_BASE_URL } from "./base-url.js";

const MAX_FILE_BYTES = 50_000_000;
const MAX_COMBINED_BYTES = 50_000_000;

export async function analyzeOpenAiPdf(
  req: PdfAnalysisRequest,
): Promise<PdfAnalysisResult | undefined> {
  const baseUrl = req.baseUrl ?? OPENAI_API_BASE_URL;
  if (
    req.api !== "openai-responses" ||
    classifyOpenAIBaseUrl(baseUrl) !== "platform" ||
    req.pdfs.length === 0 ||
    req.pdfs.some((pdf) => pdf.length >= MAX_FILE_BYTES) ||
    req.pdfs.reduce((total, pdf) => total + pdf.length, 0) > MAX_COMBINED_BYTES
  ) {
    return undefined;
  }
  req.signal?.throwIfAborted();
  const http = resolveProviderHttpRequestConfigWithOriginTrust({
    baseUrl,
    defaultBaseUrl: OPENAI_API_BASE_URL,
    defaultHeaders: {
      Authorization: `Bearer ${req.apiKey}`,
      "Content-Type": "application/json",
      ...req.headers,
    },
    request: req.request,
    provider: "openai",
    api: "openai-responses",
    capability: "other",
    transport: "http",
  });
  // The supported root spellings all address the Platform's /v1 endpoint.
  const url = "https://api.openai.com/v1/responses";
  const json = await postJsonResponse({
    url,
    headers: http.headers,
    body: {
      model: req.model,
      max_output_tokens: req.maxTokens ?? 4096,
      store: false,
      input: [
        {
          role: "user",
          content: [
            ...req.pdfs.map((pdf, index) => ({
              type: "input_file",
              filename: `document-${index + 1}.pdf`,
              file_data: `data:application/pdf;base64,${pdf.toString("base64")}`,
            })),
            { type: "input_text", text: req.prompt },
          ],
        },
      ],
    },
    timeoutMs: 120_000,
    signal: req.signal,
    fetchFn: fetch,
    allowPrivateNetwork: http.allowPrivateNetwork,
    dispatcherPolicy: http.dispatcherPolicy,
    ssrfPolicy: resolveProviderTransportSsrFPolicy({
      baseUrl: http.baseUrl,
      url,
      allowPrivateNetwork: http.allowPrivateNetwork,
      trustConfiguredBaseUrlOrigin: http.trustConfiguredBaseUrlOrigin,
    }),
    errorLabel: "OpenAI PDF request failed",
    errorOptions: { requestHeaders: http.headers },
    readOptions: { requestHeaders: http.headers },
    objectResponse: true,
  });
  const text = (Array.isArray(json.output) ? json.output : [])
    .flatMap((item: unknown) =>
      item && typeof item === "object" && "content" in item && Array.isArray(item.content)
        ? item.content
        : [],
    )
    .flatMap((part: unknown) =>
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "output_text" &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("")
    .trim();
  if (!text) {
    throw new Error("OpenAI PDF response missing output text.");
  }
  return { text };
}
