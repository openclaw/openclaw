import {
  createAgentBookVerifier,
  parseAgentkitHeader,
  validateAgentkitMessage,
  verifyAgentkitSignature,
  type AgentBookVerifier,
  type AgentkitPayload,
} from "./agentkit.runtime.js";
import { resolveOptionalTextInputValue } from "./text-input.js";

export type AgentkitVerificationOutcome =
  | "verified"
  | "invalid-header"
  | "invalid-message"
  | "invalid-signature"
  | "not-human-backed"
  | "agent-book-error";

export type AgentkitVerificationReport = {
  resourceUrl: string;
  outcome: AgentkitVerificationOutcome;
  payload: AgentkitPayload | null;
  messageValidation: {
    valid: boolean;
    error: string | null;
  };
  signatureValidation: {
    valid: boolean;
    address: string | null;
    error: string | null;
  };
  humanLookup: {
    mode: string;
    checked: boolean;
    registered: boolean;
    humanId: string | null;
    error: string | null;
  };
};

type AgentBookVerifierLike = Pick<AgentBookVerifier, "lookupHuman">;

export async function resolveAgentkitHeaderValue(params: {
  header?: string;
  headerFile?: string;
}): Promise<string> {
  const header = await resolveOptionalTextInputValue({
    value: params.header,
    file: params.headerFile,
    valueOptionLabel: "--header <value>",
    fileOptionLabel: "--header-file <path>",
    valueLabel: "AgentKit header",
  });
  if (!header) {
    throw new Error(
      "Provide an AgentKit header with `--header <value>` or `--header-file <path>`.",
    );
  }
  return header;
}

export async function verifyAgentkitHeader(params: {
  header: string;
  resourceUrl: string;
  agentBook?: AgentBookVerifierLike;
  humanLookupMode?: string;
}): Promise<AgentkitVerificationReport> {
  const resourceUrl = new URL(params.resourceUrl).toString();
  const humanLookupMode = params.humanLookupMode ?? "agentbook";
  let payload: AgentkitPayload;

  try {
    payload = parseAgentkitHeader(params.header);
  } catch (error) {
    return {
      resourceUrl,
      outcome: "invalid-header",
      payload: null,
      messageValidation: {
        valid: false,
        error: error instanceof Error ? error.message : "Invalid AgentKit header.",
      },
      signatureValidation: {
        valid: false,
        address: null,
        error: null,
      },
      humanLookup: {
        mode: humanLookupMode,
        checked: false,
        registered: false,
        humanId: null,
        error: null,
      },
    };
  }

  const messageValidation = await validateAgentkitMessage(payload, resourceUrl);
  if (!messageValidation.valid) {
    return {
      resourceUrl,
      outcome: "invalid-message",
      payload,
      messageValidation: {
        valid: false,
        error: messageValidation.error ?? "AgentKit message validation failed.",
      },
      signatureValidation: {
        valid: false,
        address: null,
        error: null,
      },
      humanLookup: {
        mode: humanLookupMode,
        checked: false,
        registered: false,
        humanId: null,
        error: null,
      },
    };
  }

  const signatureValidation = await verifyAgentkitSignature(payload);
  if (!signatureValidation.valid || !signatureValidation.address) {
    return {
      resourceUrl,
      outcome: "invalid-signature",
      payload,
      messageValidation: {
        valid: true,
        error: null,
      },
      signatureValidation: {
        valid: false,
        address: signatureValidation.address ?? null,
        error: signatureValidation.error ?? "AgentKit signature verification failed.",
      },
      humanLookup: {
        mode: humanLookupMode,
        checked: false,
        registered: false,
        humanId: null,
        error: null,
      },
    };
  }

  const agentBook = params.agentBook ?? createAgentBookVerifier();
  try {
    const humanId = await agentBook.lookupHuman(signatureValidation.address);
    if (!humanId) {
      return {
        resourceUrl,
        outcome: "not-human-backed",
        payload,
        messageValidation: {
          valid: true,
          error: null,
        },
        signatureValidation: {
          valid: true,
          address: signatureValidation.address,
          error: null,
        },
        humanLookup: {
          mode: humanLookupMode,
          checked: true,
          registered: false,
          humanId: null,
          error: null,
        },
      };
    }

    return {
      resourceUrl,
      outcome: "verified",
      payload,
      messageValidation: {
        valid: true,
        error: null,
      },
      signatureValidation: {
        valid: true,
        address: signatureValidation.address,
        error: null,
      },
      humanLookup: {
        mode: humanLookupMode,
        checked: true,
        registered: true,
        humanId,
        error: null,
      },
    };
  } catch (error) {
    return {
      resourceUrl,
      outcome: "agent-book-error",
      payload,
      messageValidation: {
        valid: true,
        error: null,
      },
      signatureValidation: {
        valid: true,
        address: signatureValidation.address,
        error: null,
      },
      humanLookup: {
        mode: humanLookupMode,
        checked: true,
        registered: false,
        humanId: null,
        error: error instanceof Error ? error.message : "AgentBook lookup failed.",
      },
    };
  }
}

function formatBoolean(value: boolean): string {
  return value ? "yes" : "no";
}

export function formatAgentkitVerificationReport(report: AgentkitVerificationReport): string {
  return [
    "AgentKit verification report:",
    `- outcome: ${report.outcome}`,
    `- resource URL: ${report.resourceUrl}`,
    `- payload parsed: ${formatBoolean(report.payload != null)}`,
    `- message validation: ${report.messageValidation.valid ? "valid" : (report.messageValidation.error ?? "invalid")}`,
    `- signature validation: ${report.signatureValidation.valid ? "valid" : (report.signatureValidation.error ?? "invalid")}`,
    `- signer address: ${report.signatureValidation.address ?? "not verified"}`,
    `- human lookup mode: ${report.humanLookup.mode}`,
    `- human-backed registration: ${report.humanLookup.checked ? formatBoolean(report.humanLookup.registered) : "not checked"}`,
    `- human id: ${report.humanLookup.humanId ?? "not available"}`,
    report.humanLookup.error ? `- human lookup error: ${report.humanLookup.error}` : null,
    report.payload ? `- payload chain: ${report.payload.chainId} (${report.payload.type})` : null,
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}
