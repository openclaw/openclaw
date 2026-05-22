import type { DiagnosticContinuationQueueMetrics } from "../infra/diagnostic-events.js";
export type DiagnosticContinuationQueueMetricsProvider = (now: number) => DiagnosticContinuationQueueMetrics | null | undefined;
export declare function registerDiagnosticContinuationQueueMetricsProvider(provider: DiagnosticContinuationQueueMetricsProvider): () => void;
export declare function getDiagnosticContinuationQueueMetrics(now?: number): DiagnosticContinuationQueueMetrics | undefined;
