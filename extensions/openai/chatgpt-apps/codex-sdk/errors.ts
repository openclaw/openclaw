import type { RequestId } from "./protocol.js";

export class CodexAppServerSdkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class JsonRpcProtocolError extends CodexAppServerSdkError {}

export class TimeoutError extends CodexAppServerSdkError {}

export class TransportClosedError extends CodexAppServerSdkError {
  constructor(message = "App server transport closed", options?: ErrorOptions) {
    super(message, options);
  }
}

export class JsonRpcRemoteError extends CodexAppServerSdkError {
  readonly requestId: RequestId;
  readonly rpcCode: number;
  readonly rpcData?: unknown;

  constructor(requestId: RequestId, rpcCode: number, message: string, rpcData?: unknown) {
    super(message);
    this.requestId = requestId;
    this.rpcCode = rpcCode;
    this.rpcData = rpcData;
  }
}
