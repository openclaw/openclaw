export async function createEmbeddedAgentSessionWithResourceLoader(params) {
    return await params.createAgentSession(params.options);
}
