export const stagedReportUpload = {
  body: { paths: ["/tmp/openclaw/uploads/.proxy-upload-1/0/report.txt"] },
  directory: "/tmp/openclaw/uploads/.proxy-upload-1",
};

type BrowserDispatchRequest = {
  path?: string;
  query?: unknown;
  body?: unknown;
};

export function firstBrowserDispatchRequest(calls: unknown[][]): BrowserDispatchRequest {
  const [call] = calls;
  if (!call) {
    throw new Error("expected browser dispatch call");
  }
  const [request] = call as [BrowserDispatchRequest, ...unknown[]];
  return request;
}
