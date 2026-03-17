import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/voice-call";
async function guardedJsonApiRequest(params) {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    init: {
      method: params.method,
      headers: params.headers,
      body: params.body ? JSON.stringify(params.body) : void 0
    },
    policy: { allowedHostnames: params.allowedHostnames },
    auditContext: params.auditContext
  });
  try {
    if (!response.ok) {
      if (params.allowNotFound && response.status === 404) {
        return void 0;
      }
      const errorText = await response.text();
      throw new Error(`${params.errorPrefix}: ${response.status} ${errorText}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : void 0;
  } finally {
    await release();
  }
}
export {
  guardedJsonApiRequest
};
