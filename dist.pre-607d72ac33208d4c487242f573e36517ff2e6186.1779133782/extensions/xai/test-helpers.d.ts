import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/xai/test-helpers.d.ts
type XaiTestPayload = Record<string, unknown> & {
  tools?: Array<{
    type?: string;
    function?: Record<string, unknown>;
  }>;
  input?: unknown[];
};
declare function createXaiPayloadCaptureStream(): {
  streamFn: StreamFn;
  getCapturedModelId: () => string;
  getCapturedPayload: () => XaiTestPayload | undefined;
};
declare function runXaiGrok4ResponseStream(streamFn: StreamFn | null | undefined): void;
declare function expectXaiFastToolStreamShaping(capture: ReturnType<typeof createXaiPayloadCaptureStream>): void;
//#endregion
export { createXaiPayloadCaptureStream, expectXaiFastToolStreamShaping, runXaiGrok4ResponseStream };