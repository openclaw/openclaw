import { writeFile } from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { BedrockClient } from "@aws-sdk/client-bedrock";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { useAutoCleanupTempDirTracker, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { bedrockModel, streamEvents, userContext } from "./bedrock.test-support.js";
import { loadBedrockControlPlaneSdk } from "./control-plane.js";
import { createBedrockEmbeddingProvider } from "./embedding-provider.js";
import { streamSimpleBedrock } from "./stream.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const model = bedrockModel({ reasoning: false });

function captureCredentials(embedding = true) {
  const resolved: string[] = [];
  const capture = async (client: BedrockClient | BedrockRuntimeClient) => {
    const { accessKeyId, sessionToken } = await client.config.credentials();
    resolved.push(embedding ? accessKeyId : `${accessKeyId}/${sessionToken}`);
  };
  vi.spyOn(BedrockRuntimeClient.prototype, "send").mockImplementation(async function (
    this: BedrockRuntimeClient,
  ) {
    await capture(this);
    return embedding
      ? { $metadata: {}, body: new TextEncoder().encode('{"embedding":[1,0]}') }
      : { $metadata: {}, stream: streamEvents([{ messageStop: { stopReason: "end_turn" } }]) };
  });
  if (!embedding) {
    vi.spyOn(BedrockClient.prototype, "send").mockImplementation(async function (
      this: BedrockClient,
    ) {
      await capture(this);
      return { $metadata: {}, modelSummaries: [] };
    });
  }
  return resolved;
}

async function awsFiles(credentials = "", profile?: string, clearAll = true) {
  const dir = tempDirs.make("bedrock-credentials-");
  const credentialsFile = path.join(dir, "credentials"),
    configFile = path.join(dir, "config");
  const names = clearAll
    ? Object.keys(process.env).filter((key) => key.startsWith("AWS_"))
    : [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_BEDROCK_SKIP_AUTH",
      ];
  for (const name of names) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("AWS_CONFIG_FILE", configFile);
  vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", credentialsFile);
  vi.stubEnv("AWS_REGION", "us-east-1");
  if (profile) {
    vi.stubEnv("AWS_PROFILE", profile);
    vi.stubEnv("AWS_EC2_METADATA_DISABLED", "true");
  }
  await Promise.all([writeFile(credentialsFile, credentials), writeFile(configFile, "")]);
  return { credentialsFile, configFile };
}

it("shares role credentials across embedding batches and refreshes after expiry", async () => {
  await awsFiles();
  const now = Date.now();
  let generation = "A";
  let credentialRequests = 0;
  await withServer(
    (req, res) => {
      if (req.url === "/latest/api/token") {
        res.end("synthetic-token");
      } else if (req.url === "/latest/meta-data/iam/security-credentials/") {
        res.end("synthetic-role");
      } else {
        credentialRequests++;
        res.end(
          JSON.stringify({
            Code: "Success",
            AccessKeyId: `TEST_${generation}`,
            SecretAccessKey: "synthetic-secret",
            Token: "synthetic-session",
            Expiration: new Date(now + (generation === "A" ? 3600000 : 14400000)).toISOString(),
          }),
        );
      }
    },
    async (endpoint) => {
      vi.stubEnv("AWS_EC2_METADATA_SERVICE_ENDPOINT", endpoint);
      const resolved = captureCredentials();
      const { provider } = await createBedrockEmbeddingProvider({ config: {}, model: "" });
      const inputs = Array.from({ length: 20 }, (_, i) => `memory ${i}`);
      expect(await provider.embedBatch(inputs)).toEqual(inputs.map(() => [1, 0]));
      expect(credentialRequests).toBe(1);
      expect(resolved).toEqual(inputs.map(() => "TEST_A"));
      generation = "B";
      vi.spyOn(Date, "now").mockReturnValue(now + 7200000);
      resolved.length = 0;
      expect(await provider.embedBatch(inputs)).toEqual(inputs.map(() => [1, 0]));
      expect(resolved).toEqual(inputs.map(() => "TEST_B"));
      expect(credentialRequests).toBe(2);
    },
  );
});

it("refreshes an unexpired profile role while preserving the Bedrock region", async () => {
  const { configFile } = await awsFiles(
    "[source]\naws_access_key_id = TEST_SOURCE\naws_secret_access_key = synthetic-secret\n",
    "role",
  );
  const rotate = (role: string) =>
    writeFile(
      configFile,
      `[profile role]\nrole_arn = arn:aws-us-gov:iam::123456789012:role/${role}\nsource_profile = source\n`,
    );
  await rotate("A");
  const signatures: string[] = [];
  await withServer(
    async (req, res) => {
      signatures.push(req.headers.authorization ?? "");
      const role = new URLSearchParams(await text(req)).get("RoleArn")?.split("/").at(-1);
      res.setHeader("content-type", "text/xml");
      res.end(
        `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>TEST_${role}</AccessKeyId><SecretAccessKey>synthetic-secret</SecretAccessKey><SessionToken>synthetic-session</SessionToken><Expiration>${new Date(Date.now() + 3600000).toISOString()}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`,
      );
    },
    async (endpoint) => {
      vi.stubEnv("AWS_ENDPOINT_URL_STS", endpoint);
      const resolved = captureCredentials();
      const { provider } = await createBedrockEmbeddingProvider({
        config: {},
        model: "",
        remote: { baseUrl: "https://bedrock-runtime.us-gov-west-1.amazonaws.com" },
      });
      expect(await provider.embed("memory")).toEqual([1, 0]);
      await rotate("B");
      expect(await provider.embed("next memory")).toEqual([1, 0]);
      expect(resolved).toEqual(["TEST_A", "TEST_B"]);
      expect(signatures).toEqual(
        Array(2).fill(expect.stringContaining("/us-gov-west-1/sts/aws4_request")),
      );
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["stream", "discovery"] as const)(
  "%s resolves rotated credentials through its own SDK chain",
  async (route) => {
    const { credentialsFile } = await awsFiles("", "rotation", false);
    const rotate = (generation: string) =>
      writeFile(
        credentialsFile,
        `[rotation]\naws_access_key_id = TEST_${generation}\naws_secret_access_key = synthetic-secret-${generation}\naws_session_token = synthetic-token-${generation}\n`,
      );
    await rotate("A");
    // Prime the actual SDK's file cache, independently of OpenClaw's refresh helper.
    expect((await defaultProvider()()).accessKeyId).toBe("TEST_A");
    const resolved = captureCredentials(false);
    const invoke = async () => {
      if (route === "stream") {
        const result = await streamSimpleBedrock(model, userContext()).result();
        expect(result.stopReason).toBe("stop");
      } else {
        const sdk = await loadBedrockControlPlaneSdk();
        const client = sdk.createClient("us-east-1");
        try {
          await client.send(sdk.createListFoundationModelsCommand());
        } finally {
          client.destroy();
        }
      }
    };
    await invoke();
    await rotate("B");
    await invoke();
    expect(resolved).toEqual(["TEST_A/synthetic-token-A", "TEST_B/synthetic-token-B"]);
  },
);

it.each(["before", "during"] as const)(
  "does not send or resolve credentials when cancelled %s the payload callback",
  async (when) => {
    const controller = new AbortController();
    const reason = new Error("cancelled before credential resolution");
    if (when === "before") {
      controller.abort(reason);
    }
    const onPayload = vi.fn(() => controller.abort(reason));
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send");
    const result = await streamSimpleBedrock(model, userContext(), {
      signal: controller.signal,
      onPayload,
    }).result();
    expect(result.stopReason).toBe("aborted");
    expect(send).not.toHaveBeenCalled();
    expect(onPayload).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
  },
);
