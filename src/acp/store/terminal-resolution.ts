export type AcpGatewayRunTerminalStatus = "completed" | "failed" | "canceled";

export type AcpGatewayTerminalResult = {
  status: AcpGatewayRunTerminalStatus;
  stopReason?: string;
  errorCode?: string;
  errorMessage?: string;
};

export type AcpGatewayCanonicalTerminal = {
  terminalEventId: string;
  finalSeq: number;
  status: AcpGatewayRunTerminalStatus;
  recordedAt: number;
  stopReason?: string;
  errorCode?: string;
  errorMessage?: string;
};

export type ResolveCanonicalTerminalParams = {
  current?: AcpGatewayCanonicalTerminal;
  incoming: {
    terminalEventId: string;
    finalSeq: number;
    recordedAt: number;
    result: AcpGatewayTerminalResult;
  };
};

export type ResolveCanonicalTerminalResult =
  | {
      kind: "accepted";
      terminal: AcpGatewayCanonicalTerminal;
    }
  | {
      kind: "idempotent";
      terminal: AcpGatewayCanonicalTerminal;
    }
  | {
      kind: "rejected";
      code: "ACP_TERMINAL_CONFLICT";
      message: string;
      terminal: AcpGatewayCanonicalTerminal;
    };

export function resolveCanonicalTerminal(
  params: ResolveCanonicalTerminalParams,
): ResolveCanonicalTerminalResult {
  const next: AcpGatewayCanonicalTerminal = {
    terminalEventId: params.incoming.terminalEventId,
    finalSeq: params.incoming.finalSeq,
    status: params.incoming.result.status,
    recordedAt: params.incoming.recordedAt,
    stopReason: params.incoming.result.stopReason,
    errorCode: params.incoming.result.errorCode,
    errorMessage: params.incoming.result.errorMessage,
  };
  if (!params.current) {
    return {
      kind: "accepted",
      terminal: next,
    };
  }
  if (params.current.terminalEventId === params.incoming.terminalEventId) {
    return {
      kind: "idempotent",
      terminal: params.current,
    };
  }
  return {
    kind: "rejected",
    code: "ACP_TERMINAL_CONFLICT",
    message:
      `ACP run already has canonical terminal ${params.current.terminalEventId}; ` +
      `received conflicting terminal ${params.incoming.terminalEventId}.`,
    terminal: params.current,
  };
}
