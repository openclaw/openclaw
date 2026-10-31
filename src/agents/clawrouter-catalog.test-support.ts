export function catalogProvider(id: string, upstreams: string[], capabilities: string | string[]) {
  return {
    id,
    displayName: id,
    openaiCompatible: id === "openai",
    nativeBaseUrl: `/v1/native/${id}`,
    routes:
      id === "anthropic"
        ? [{ path: "/v1/messages", requestFormat: "anthropic.messages", methods: ["POST"] }]
        : [],
    models: upstreams.map((upstream) => ({
      id: `${id}/${upstream}`,
      upstream,
      capabilities: typeof capabilities === "string" ? [capabilities] : capabilities,
    })),
  };
}
