// Leaf contract for the model-aware image compression resolver. Kept free of the
// embedded-agent-runner model runtime so media-understanding can name a candidate
// without importing the model hub, which would close an agents<->media import cycle.
export type ImageCompressionModelCandidate = {
  provider: string;
  model: string;
};
