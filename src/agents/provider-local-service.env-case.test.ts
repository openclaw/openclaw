import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureProviderLocalService } from "./provider-local-service.js";
import { createProviderLocalServiceTestFixture } from "./provider-local-service.test-support.js";

async function readSpawnedLocalServiceEnv(
  env: Record<string, string>,
  port: number,
): Promise<Record<string, string | undefined>> {
  const healthUrl = `http://127.0.0.1:${port}/v1/models`;
  const lease = await ensureProviderLocalService({
    providerId: `local-env-${port}`,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    service: {
      command: process.execPath,
      args: [
        "-e",
        `const http=require("node:http");const payload=JSON.stringify({pathUpper:process.env.PATH,pathLower:process.env.path,caseUpper:process.env.OPENCLAW_LOCAL_SERVICE_CASE_TEST,caseLower:process.env.openclaw_local_service_case_test,exact:process.env.OPENCLAW_LOCAL_SERVICE_EXACT_TEST});const server=http.createServer((req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end(payload);});server.listen(${port},"127.0.0.1");process.on("SIGTERM",()=>server.close(()=>process.exit(0)));`,
      ],
      env,
      healthUrl,
      readyTimeoutMs: 5_000,
    },
  });
  if (!lease) {
    throw new Error("Expected provider local service lease");
  }
  try {
    return (await (await fetch(healthUrl)).json()) as Record<string, string | undefined>;
  } finally {
    lease.release();
  }
}

describe("provider local service environment", () => {
  const fixture = createProviderLocalServiceTestFixture();
  afterEach(fixture.cleanup);

  it.runIf(process.platform === "win32")(
    "lets configured env override inherited keys case-insensitively on Windows",
    async () => {
      vi.stubEnv("OPENCLAW_LOCAL_SERVICE_CASE_TEST", "inherited");
      try {
        const observed = await readSpawnedLocalServiceEnv(
          {
            path: "C:\\operator-bin",
            openclaw_local_service_case_test: "configured",
            OPENCLAW_LOCAL_SERVICE_EXACT_TEST: "exact",
          },
          await fixture.claimPort(),
        );

        expect(observed).toEqual({
          pathUpper: "C:\\operator-bin",
          pathLower: "C:\\operator-bin",
          caseUpper: "configured",
          caseLower: "configured",
          exact: "exact",
        });
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps configured env keys byte-exact on POSIX",
    async () => {
      vi.stubEnv("OPENCLAW_LOCAL_SERVICE_CASE_TEST", "inherited");
      try {
        const observed = await readSpawnedLocalServiceEnv(
          {
            path: "/operator-bin",
            openclaw_local_service_case_test: "configured",
            OPENCLAW_LOCAL_SERVICE_EXACT_TEST: "exact",
          },
          await fixture.claimPort(),
        );

        expect(observed).toEqual({
          pathUpper: process.env.PATH,
          pathLower: "/operator-bin",
          caseUpper: "inherited",
          caseLower: "configured",
          exact: "exact",
        });
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});
