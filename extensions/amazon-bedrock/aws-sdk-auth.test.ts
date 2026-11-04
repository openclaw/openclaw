// Amazon Bedrock tests cover the AWS SDK auth choice at the setup boundary.
import {
  applyProviderAuthConfigPatch,
  resolveAuthProfileOrder,
} from "openclaw/plugin-sdk/provider-auth";
import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth-markers";
import { afterEach, expect, it, vi } from "vitest";

const saveProfile = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/provider-auth-api-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-api-key")>()),
  upsertAuthProfileWithLockOrThrow: saveProfile,
}));

const { awsSdkAuthMethod, buildBedrockAwsSdkAuthResult } = await import("./aws-sdk-auth.js");

const AGENT_DIR = "/tmp/openclaw-bedrock-test-agent";
const PLATFORM = { provider: "openai", mode: "api_key" as const };

afterEach(() => vi.unstubAllEnvs());

it("saves an account the host selects for Bedrock, storing no AWS credentials", async () => {
  vi.stubEnv("AWS_REGION", "eu-central-1");
  const saved = await awsSdkAuthMethod.runNonInteractive!({
    authChoice: "amazon-bedrock-aws-sdk",
    config: { auth: { profiles: { "openai:platform": PLATFORM } } },
    baseConfig: {},
    opts: {},
    agentDir: AGENT_DIR,
    runtime: { log: () => {}, error: () => {}, exit: () => undefined as never },
    resolveApiKey: async () => null,
    toApiKeyCredential: () => null,
  });
  // The choice is accepted, so it patches the config and saves one account.
  const config = saved ?? expect.unreachable("the aws-sdk choice returned no config");
  const record = saveProfile.mock.calls[0]?.[0];
  expect(record?.agentDir).toBe(AGENT_DIR);
  // What the setup owes a scheduled run: an account the host resolves for Bedrock.
  expect(
    resolveAuthProfileOrder({
      cfg: config,
      store: { version: 1, profiles: { [record.profileId]: record.credential } },
      provider: "amazon-bedrock",
    }),
  ).toEqual([record.profileId]);
  // The account holds a marker, and no AWS material reaches config either.
  expect(isNonSecretApiKeyMarker(record.credential.key)).toBe(true);
  expect(JSON.stringify(config)).not.toMatch(/AKIA|ASIA|SecretAccessKey|SessionToken/u);
  // An account configured before this choice keeps its own credential.
  expect(config.auth?.profiles?.["openai:platform"]).toEqual(PLATFORM);
  expect(config.plugins?.entries?.["amazon-bedrock"]?.config).toEqual({
    discovery: { enabled: true, region: "eu-central-1" },
  });
});

it("routes the provider through the chain and opts discovery in only for a usable region", () => {
  const applied = (region?: string) =>
    applyProviderAuthConfigPatch({}, buildBedrockAwsSdkAuthResult({ region }).configPatch);

  expect(applied(" US-West-2 ").plugins?.entries?.["amazon-bedrock"]?.config).toEqual({
    discovery: { enabled: true, region: "us-west-2" },
  });
  for (const region of [undefined, "not a region"]) {
    const config = applied(region);
    // An unusable answer still routes requests through the chain; it must not
    // enable discovery against a guessed region.
    expect(config.models?.providers?.["amazon-bedrock"]?.auth).toBe("aws-sdk");
    expect(config.plugins?.entries?.["amazon-bedrock"]).toBeUndefined();
  }
});
