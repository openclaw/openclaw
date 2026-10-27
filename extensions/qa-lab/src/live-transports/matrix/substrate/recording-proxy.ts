import {
  startMatrixQaFaultProxy,
  type MatrixQaFaultProxyObserver,
  type MatrixQaFaultProxyRule,
  type MatrixQaFaultProxyRuleHandle,
} from "./fault-proxy.js";
import { normalizeMatrixQaRoute } from "./recording-proxy-internals.js";

type MatrixQaRecordedExchange = {
  request: {
    method: string;
    route: string;
  };
  response: {
    status: number;
  };
};

export type MatrixQaRecordingProxy = MatrixQaFaultProxyObserver & {
  baseUrl: string;
  installFaultRule(rule: MatrixQaFaultProxyRule): MatrixQaFaultProxyRuleHandle;
  records(): readonly MatrixQaRecordedExchange[];
  setTargetBaseUrl(targetBaseUrl: string): void;
  stop(): Promise<void>;
};

export async function startMatrixQaRecordingProxy(params: {
  targetBaseUrl: string;
}): Promise<MatrixQaRecordingProxy> {
  const records: MatrixQaRecordedExchange[] = [];
  // Scenarios count completed native media uploads; never retain bodies, headers or query tokens.
  const observer: MatrixQaFaultProxyObserver = {
    onExchange: ({ request, response }) => {
      records.push({
        request: {
          method: request.method,
          route: normalizeMatrixQaRoute(request.path),
        },
        response: { status: response.status },
      });
    },
  };
  const proxy = await startMatrixQaFaultProxy({
    targetBaseUrl: params.targetBaseUrl,
    rules: [],
    ...observer,
  });

  return {
    baseUrl: proxy.baseUrl,
    ...observer,
    installFaultRule: proxy.installRule.bind(proxy),
    records: () => records,
    setTargetBaseUrl: proxy.setTargetBaseUrl.bind(proxy),
    stop: proxy.stop.bind(proxy),
  };
}
