import type {
  MSTeamsEmployeeOpenAIAuthEnrollmentStore,
  MSTeamsEmployeeOpenAIAuthProvider,
} from "./employee-openai-auth-enrollment.js";
import {
  completeMSTeamsEmployeeOpenAIAuthEnrollment,
  startMSTeamsEmployeeOpenAIAuthEnrollment,
} from "./employee-openai-auth-enrollment.js";

export const MSTEAMS_OPENAI_AUTH_ENROLLMENT_START_ROUTE = "/auth/enroll/openai/:token";
export const MSTEAMS_OPENAI_AUTH_ENROLLMENT_CALLBACK_ROUTE = "/auth/enroll/openai/callback";

type GatewayRequest = {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
};

type GatewayResponse = {
  status: (code: number) => GatewayResponse;
  json: (body: unknown) => unknown;
  redirect: (statusOrUrl: number | string, url?: string) => unknown;
};

export type MSTeamsEmployeeOpenAIAuthEnrollmentRouteApp = {
  get: (
    path: string,
    handler: (req: GatewayRequest, res: GatewayResponse) => Promise<void>,
  ) => void;
};

export type MSTeamsEmployeeOpenAIAuthEnrollmentRouteLogger = {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
};

export type MSTeamsEmployeeOpenAIAuthEnrollmentRouteDeps = {
  store: MSTeamsEmployeeOpenAIAuthEnrollmentStore;
  provider: MSTeamsEmployeeOpenAIAuthProvider;
  agentId: string;
  employeeHash: string;
  log?: MSTeamsEmployeeOpenAIAuthEnrollmentRouteLogger;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function proofMeta(proof: {
  enrollmentIdHash?: string;
  requestIdHash?: string;
  agentId: string;
  employeeHash: string;
  status: string;
  failureCode?: string;
  valueExposure: false;
}): Record<string, unknown> {
  return {
    enrollmentIdHash: proof.enrollmentIdHash,
    requestIdHash: proof.requestIdHash,
    agentId: proof.agentId,
    employeeHash: proof.employeeHash,
    status: proof.status,
    failureCode: proof.failureCode,
    valueExposure: proof.valueExposure,
  };
}

function writeBlocked(res: GatewayResponse, proof: Parameters<typeof proofMeta>[0]): void {
  res.status(400).json({
    ok: false,
    status: "blocked",
    failureCode: proof.failureCode,
    valueExposure: false,
  });
}

function writeCompleted(res: GatewayResponse): void {
  res.status(200).json({
    ok: true,
    status: "completed",
    valueExposure: false,
  });
}

export function registerMSTeamsEmployeeOpenAIAuthEnrollmentRoutes(
  app: MSTeamsEmployeeOpenAIAuthEnrollmentRouteApp,
  deps: MSTeamsEmployeeOpenAIAuthEnrollmentRouteDeps,
): void {
  app.get(MSTEAMS_OPENAI_AUTH_ENROLLMENT_CALLBACK_ROUTE, async (req, res) => {
    const result = await completeMSTeamsEmployeeOpenAIAuthEnrollment({
      store: deps.store,
      provider: deps.provider,
      state: readString(req.query?.state),
      callbackCode: readString(req.query?.code),
      providerError: readString(req.query?.error),
      agentId: deps.agentId,
      employeeHash: deps.employeeHash,
    });
    deps.log?.info?.("msteams employee OpenAI enrollment callback", proofMeta(result.proof));
    if (result.status === "blocked") {
      writeBlocked(res, result.proof);
      return;
    }
    writeCompleted(res);
  });

  app.get(MSTEAMS_OPENAI_AUTH_ENROLLMENT_START_ROUTE, async (req, res) => {
    const token = readString(req.params?.token);
    if (!token) {
      const proof = {
        agentId: deps.agentId,
        employeeHash: deps.employeeHash,
        status: "blocked",
        failureCode: "missing-pending-request",
        valueExposure: false as const,
      };
      deps.log?.warn?.("msteams employee OpenAI enrollment start blocked", proofMeta(proof));
      writeBlocked(res, proof);
      return;
    }
    const result = await startMSTeamsEmployeeOpenAIAuthEnrollment({
      store: deps.store,
      provider: deps.provider,
      linkToken: token,
      agentId: deps.agentId,
      employeeHash: deps.employeeHash,
    });
    deps.log?.info?.("msteams employee OpenAI enrollment start", proofMeta(result.proof));
    if (result.status === "blocked") {
      writeBlocked(res, result.proof);
      return;
    }
    res.redirect(302, result.authorizationUrl);
  });
}
