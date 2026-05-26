import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { s as AuthProfileStore } from "./types-BwDj5PsX.js";

//#region src/media-understanding/types.d.ts
type MediaUnderstandingKind = "audio.transcription" | "video.description" | "image.description";
type MediaUnderstandingCapability = "image" | "audio" | "video";
type MediaAttachment = {
  path?: string;
  url?: string;
  mime?: string;
  index: number;
  alreadyTranscribed?: boolean;
};
type MediaUnderstandingOutput = {
  kind: MediaUnderstandingKind;
  attachmentIndex: number;
  text: string;
  provider: string;
  model?: string;
};
type MediaUnderstandingDecisionOutcome = "success" | "failed" | "skipped" | "disabled" | "no-attachment" | "scope-deny";
type MediaUnderstandingModelDecision = {
  provider?: string;
  model?: string;
  type: "provider" | "cli";
  outcome: "success" | "skipped" | "failed";
  reason?: string;
};
type MediaUnderstandingAttachmentDecision = {
  attachmentIndex: number;
  attempts: MediaUnderstandingModelDecision[];
  chosen?: MediaUnderstandingModelDecision;
};
type MediaUnderstandingDecision = {
  capability: MediaUnderstandingCapability;
  outcome: MediaUnderstandingDecisionOutcome;
  attachments: MediaUnderstandingAttachmentDecision[];
};
type MediaUnderstandingProviderRequestAuthOverride = {
  mode: "provider-default";
} | {
  mode: "authorization-bearer";
  token: string;
} | {
  mode: "header";
  headerName: string;
  value: string;
  prefix?: string;
};
type MediaUnderstandingProviderRequestTlsOverride = {
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
  serverName?: string;
  insecureSkipVerify?: boolean;
};
type MediaUnderstandingProviderRequestProxyOverride = {
  mode: "env-proxy";
  tls?: MediaUnderstandingProviderRequestTlsOverride;
} | {
  mode: "explicit-proxy";
  url: string;
  tls?: MediaUnderstandingProviderRequestTlsOverride;
};
type MediaUnderstandingProviderRequestTransportOverrides = {
  headers?: Record<string, string>;
  auth?: MediaUnderstandingProviderRequestAuthOverride;
  proxy?: MediaUnderstandingProviderRequestProxyOverride;
  tls?: MediaUnderstandingProviderRequestTlsOverride; /** Runtime-only flag from trusted model-provider config; media config rejects it. */
  allowPrivateNetwork?: boolean;
};
type AudioTranscriptionRequest = {
  buffer: Buffer;
  fileName: string;
  mime?: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: MediaUnderstandingProviderRequestTransportOverrides;
  model?: string;
  language?: string;
  prompt?: string;
  query?: Record<string, string | number | boolean>;
  timeoutMs: number;
  fetchFn?: typeof fetch;
};
type AudioTranscriptionResult = {
  text: string;
  model?: string;
};
type VideoDescriptionRequest = {
  buffer: Buffer;
  fileName: string;
  mime?: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: MediaUnderstandingProviderRequestTransportOverrides;
  model?: string;
  prompt?: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
};
type VideoDescriptionResult = {
  text: string;
  model?: string;
};
type ImageDescriptionRequest = {
  buffer: Buffer;
  fileName: string;
  mime?: string;
  prompt?: string;
  maxTokens?: number;
  timeoutMs: number;
  profile?: string;
  preferredProfile?: string;
  authStore?: AuthProfileStore;
  agentDir: string;
  workspaceDir?: string;
  cfg: OpenClawConfig;
  model: string;
  provider: string;
};
type ImagesDescriptionInput = {
  buffer: Buffer;
  fileName: string;
  mime?: string;
};
type ImagesDescriptionRequest = {
  images: ImagesDescriptionInput[];
  model: string;
  provider: string;
  prompt?: string;
  maxTokens?: number;
  timeoutMs: number;
  profile?: string;
  preferredProfile?: string;
  authStore?: AuthProfileStore;
  agentDir: string;
  workspaceDir?: string;
  cfg: OpenClawConfig;
};
type ImageDescriptionResult = {
  text: string;
  model?: string;
};
type ImagesDescriptionResult = {
  text: string;
  model?: string;
};
type StructuredExtractionTextInput = {
  type: "text";
  text: string;
};
type StructuredExtractionImageInput = {
  type: "image";
  buffer: Buffer;
  fileName: string;
  mime?: string;
};
type StructuredExtractionInput = StructuredExtractionTextInput | StructuredExtractionImageInput;
type StructuredExtractionRequest = {
  /** Image-first extraction input; callers must include at least one image. */input: StructuredExtractionInput[];
  instructions: string;
  schemaName?: string;
  jsonSchema?: unknown;
  jsonMode?: boolean;
  timeoutMs: number;
  profile?: string;
  preferredProfile?: string;
  authStore?: AuthProfileStore;
  agentDir: string;
  cfg: OpenClawConfig;
  model: string;
  provider: string;
};
type StructuredExtractionResult = {
  text: string;
  parsed?: unknown;
  model?: string;
  provider?: string;
  contentType?: "json" | "text";
};
type MediaUnderstandingProvider = {
  id: string;
  capabilities?: MediaUnderstandingCapability[];
  defaultModels?: Partial<Record<MediaUnderstandingCapability, string>>;
  autoPriority?: Partial<Record<MediaUnderstandingCapability, number>>;
  nativeDocumentInputs?: Array<"pdf">;
  transcribeAudio?: (req: AudioTranscriptionRequest) => Promise<AudioTranscriptionResult>;
  describeVideo?: (req: VideoDescriptionRequest) => Promise<VideoDescriptionResult>;
  describeImage?: (req: ImageDescriptionRequest) => Promise<ImageDescriptionResult>;
  describeImages?: (req: ImagesDescriptionRequest) => Promise<ImagesDescriptionResult>;
  extractStructured?: (req: StructuredExtractionRequest) => Promise<StructuredExtractionResult>;
};
//#endregion
export { StructuredExtractionTextInput as _, ImagesDescriptionInput as a, MediaAttachment as c, MediaUnderstandingOutput as d, MediaUnderstandingProvider as f, StructuredExtractionResult as g, StructuredExtractionRequest as h, ImageDescriptionResult as i, MediaUnderstandingCapability as l, StructuredExtractionInput as m, AudioTranscriptionResult as n, ImagesDescriptionRequest as o, StructuredExtractionImageInput as p, ImageDescriptionRequest as r, ImagesDescriptionResult as s, AudioTranscriptionRequest as t, MediaUnderstandingDecision as u, VideoDescriptionRequest as v, VideoDescriptionResult as y };