/**
 * Moonshot (Kimi) smoke test - verifies provider connectivity and basic functionality.
 *
 * This is a minimal smoke test to prove:
 * 1. Auth works (MOONSHOT_API_KEY resolution)
 * 2. Model invocation works
 * 3. Response is received
 *
 * SCOPE: Phase 1 - read-only validation, no side effects.
 */

export type SmokeTestResult = {
  name: string;
  passed: boolean;
  message: string;
  durationMs: number;
  details?: unknown;
};

export type SmokeTestConfig = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeout?: number;
};

const DEFAULT_BASE_URL = "https://api.moonshot.ai/v1";
// Must match MOONSHOT_DEFAULT_MODEL_ID in src/commands/onboard-auth.models.ts
const DEFAULT_MODEL = "kimi-k2-0905-preview";
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Ping test: verify Moonshot API is reachable and auth works.
 * Makes a simple completion request with minimal tokens.
 */
export async function runPingTest(config: SmokeTestConfig): Promise<SmokeTestResult> {
  const startTime = Date.now();
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const model = config.model ?? DEFAULT_MODEL;
  const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;

  try {
    // Resolve API key from config or env
    const apiKey = config.apiKey ?? process.env.MOONSHOT_API_KEY?.trim();
    if (!apiKey) {
      return {
        name: "moonshot:ping",
        passed: false,
        message: "Missing MOONSHOT_API_KEY",
        durationMs: Date.now() - startTime,
        details: { error: "MOONSHOT_API_KEY environment variable not set" },
      };
    }

    // Make minimal API call
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 10,
      }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "no body");
      return {
        name: "moonshot:ping",
        passed: false,
        message: `Moonshot API returned ${response.status}`,
        durationMs: Date.now() - startTime,
        details: { status: response.status, body: errorText, baseUrl, model },
      };
    }

    const data = (await response.json()) as {
      id?: string;
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };

    // Verify response structure
    if (!data.id || !data.choices || data.choices.length === 0) {
      return {
        name: "moonshot:ping",
        passed: false,
        message: "Invalid response structure from Moonshot",
        durationMs: Date.now() - startTime,
        details: { response: data },
      };
    }

    return {
      name: "moonshot:ping",
      passed: true,
      message: `Moonshot provider reachable (model: ${data.model ?? model})`,
      durationMs: Date.now() - startTime,
      details: { model: data.model, responseId: data.id },
    };
  } catch (err) {
    return {
      name: "moonshot:ping",
      passed: false,
      message: `Moonshot ping failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - startTime,
      details: { error: String(err) },
    };
  }
}

/**
 * Run all smoke tests in sequence.
 */
export async function runAllSmokeTests(config: SmokeTestConfig): Promise<SmokeTestResult[]> {
  return [await runPingTest(config)];
}
