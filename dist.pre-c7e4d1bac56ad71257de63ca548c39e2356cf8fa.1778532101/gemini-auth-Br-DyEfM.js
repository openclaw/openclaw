//#region src/infra/gemini-auth.ts
/**
* Shared Gemini authentication utilities.
*
* Supports both traditional API keys and OAuth JSON format.
*/
/**
* Parse Gemini API key and return appropriate auth headers.
*
* OAuth format: `{"token": "...", "projectId": "..."}`
*
* @param apiKey - Either a traditional API key string or OAuth JSON
* @returns Headers object with appropriate authentication
*/
function parseGeminiAuth(apiKey) {
	if (apiKey.startsWith("{")) try {
		const parsed = JSON.parse(apiKey);
		if (typeof parsed.token === "string" && parsed.token) return { headers: {
			Authorization: `Bearer ${parsed.token}`,
			"Content-Type": "application/json"
		} };
	} catch {}
	return { headers: {
		"x-goog-api-key": apiKey,
		"Content-Type": "application/json"
	} };
}
//#endregion
export { parseGeminiAuth as t };
