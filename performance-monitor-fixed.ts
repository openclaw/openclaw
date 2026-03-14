/**
 * OpenClaw Performance Monitor
 * 
 * Production-ready performance monitoring tool
 * 
 * @version 1.0.4
 * @license MIT
 */

interface CpuUsage {
  user: number;
  system: number;
}

interface MemoryUsage {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface PerformanceMetrics {
  timestamp: number;
  cpuUsage: number;
  memoryUsage: MemoryUsage;
  agentMetrics: AgentMetrics[];
  websocketMetrics: WebSocketMetrics;
  modelMetrics: ModelMetrics[];
}

export interface AgentMetrics {
  agentId: string;
  agentName: string;
  executionCount: number;
  totalExecutionTime: number;
  averageExecutionTime: number;
  maxExecutionTime: number;
  minExecutionTime: number;
  successRate: number;
  errorCount: number;
}

export interface WebSocketMetrics {
  connectionCount: number;
  activeConnections: number;
  messagesSent: number;
  messagesReceived: number;
  averageLatency: number;
  reconnectionCount: number;
}

export interface ModelMetrics {
  modelId: string;
  requestCount: number;
  totalResponseTime: number;
  averageResponseTime: number;
  averageTokensPerSecond: number;
  errorRate: number;
  totalTokens: number;
  averageTokensPerRequest: number;
}

export interface PerformanceAlert {
  id: string;
  type: 'cpu' | 'memory' | 'latency' | 'error_rate';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  value: number;
  threshold: number;
  timestamp: number;
  resolved?: boolean;
  resolvedAt?: number;
}

export interface PerformanceMonitorOptions {
  interval?: number;
  cpuThreshold?: number;
  memoryThreshold?: number;
  latencyThreshold?: number;
  errorRateThreshold?: number;
  debug?: boolean;
  maxAlertsHistory?: number;
}

interface AgentExecution {
  startTime: number;
  success: boolean;
  agentId: string;
  agentName: string;
}

interface ModelRequest {
  startTime: number;
  tokens?: number;
  success: boolean;
  modelId: string;
}

type EventListener = (...args: any[]) => void;

class SimpleEventEmitter {
  private listeners: Map<string, Set<EventListener>> = new Map();

  on(event: string, listener: EventListener): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return this;
  }

  emit(event: string, ...args: any[]): boolean {
    const eventListeners = this.listeners.get(event);
    if (!eventListeners || eventListeners.size === 0) {
      return false;
    }
    eventListeners.forEach(listener => {
      try {
        listener(...args);
      } catch (error) {
        console.error(`Error in event listener for "${event}":`, error);
      }
    });
    return true;
  }

  off(event: string, listener: EventListener): this {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(listener);
    }
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
    return this;
  }
}

export class PerformanceMonitor extends SimpleEventEmitter {
  private options: Required<PerformanceMonitorOptions>;
  private monitoringInterval: ReturnType<typeof setInterval> | null = null;
  private metrics: PerformanceMetrics;
  private alerts: Map<string, PerformanceAlert> = new Map();
  private agentExecutions: Map<string, AgentExecution> = new Map();
  private modelRequests: Map<string, ModelRequest> = new Map();
  private websocketLatencies: number[] = [];
  private lastCpuUsage: CpuUsage | null = null;
  private isRunning: boolean = false;
  private isNodeEnv: boolean;

  constructor(options: PerformanceMonitorOptions = {}) {
    super();
    
    this.options = {
      interval: 5000,
      cpuThreshold: 80,
      memoryThreshold: 80,
      latencyThreshold: 5000,
      errorRateThreshold: 10,
      debug: false,
      maxAlertsHistory: 100,
      ...options,
    };

    this.isNodeEnv = typeof process !== 'undefined' && 
                     typeof process.version === 'string' &&
                     typeof process.cpuUsage === 'function';

    this.metrics = this.initializeMetrics();
    
    if (this.isNodeEnv) {
      try {
        this.lastCpuUsage = process.cpuUsage();
      } catch (error) {
        this.log('Failed to initialize CPU tracking:', error);
      }
    }
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.monitoringInterval = setInterval(() => {
      this.collectMetrics();
    }, this.options.interval);
  }

  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }

  public getMetrics(): PerformanceMetrics {
    return { ...this.metrics };
  }

  public getAlerts(): PerformanceAlert[] {
    return Array.from(this.alerts.values()).sort((a, b) => b.timestamp - a.timestamp);
  }

  public startAgentExecution(agentId: string, agentName: string): string {
    const executionId = `${agentId}::${Date.now()}::${this.generateId()}`;
    this.agentExecutions.set(executionId, {
      startTime: Date.now(),
      success: false,
      agentId,
      agentName,
    });
    return executionId;
  }

  public endAgentExecution(executionId: string, success: boolean = true): void {
    const execution = this.agentExecutions.get(executionId);
    if (!execution) return;

    const executionTime = Date.now() - execution.startTime;
    this.updateAgentMetrics(execution.agentId, execution.agentName, executionTime, success);
    this.agentExecutions.delete(executionId);
  }

  public startModelRequest(modelId: string): string {
    const requestId = `${modelId}::${Date.now()}::${this.generateId()}`;
    this.modelRequests.set(requestId, {
      startTime: Date.now(),
      success: false,
      modelId,
    });
    return requestId;
  }

  public endModelRequest(requestId: string, success: boolean = true, tokens?: number): void {
    const request = this.modelRequests.get(requestId);
    if (!request) return;

    const responseTime = Date.now() - request.startTime;
    this.updateModelMetrics(request.modelId, responseTime, success, tokens);
    this.modelRequests.delete(requestId);
  }

  public trackWebSocketLatency(latency: number): void {
    this.websocketLatencies.push(latency);
    if (this.websocketLatencies.length > 100) {
      this.websocketLatencies.shift();
    }
  }

  public updateWebSocketMetrics(metrics: Partial<WebSocketMetrics>): void {
    this.metrics.websocketMetrics = {
      ...this.metrics.websocketMetrics,
      ...metrics,
    };
  }

  public resolveAlert(alertId: string): void {
    const alert = this.alerts.get(alertId);
    if (alert && !alert.resolved) {
      alert.resolved = true;
      alert.resolvedAt = Date.now();
      this.emit('alertResolved', alert);
    }
  }

  public generateReport(): string {
    const metrics = this.getMetrics();
    const alerts = this.getAlerts();
    const activeAlerts = alerts.filter(a => !a.resolved);

    const lines: string[] = [
      '=== OpenClaw Performance Report ===',
      `Generated at: ${new Date(metrics.timestamp).toISOString()}`,
      '',
      '--- System Resources ---',
      `CPU Usage: ${metrics.cpuUsage.toFixed(2)}%`,
    ];

    if (metrics.memoryUsage.heapTotal > 0) {
      const memPercent = ((metrics.memoryUsage.heapUsed / metrics.memoryUsage.heapTotal) * 100).toFixed(2);
      lines.push(`Memory Usage: ${memPercent}%`);
      lines.push(`RSS: ${(metrics.memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`);
      lines.push(`Heap: ${(metrics.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB / ${(metrics.memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`);
    }

    lines.push('', '--- Agent Performance ---');
    if (metrics.agentMetrics.length === 0) {
      lines.push('No agent executions recorded');
    } else {
      metrics.agentMetrics.forEach(agent => {
        lines.push(`Agent: ${agent.agentName} (${agent.agentId})`);
        lines.push(`  Executions: ${agent.executionCount}`);
        lines.push(`  Avg Time: ${agent.averageExecutionTime.toFixed(2)}ms`);
        lines.push(`  Success Rate: ${agent.successRate.toFixed(2)}%`);
        lines.push(`  Errors: ${agent.errorCount}`);
      });
    }

    lines.push('', '--- WebSocket Performance ---');
    lines.push(`Active Connections: ${metrics.websocketMetrics.activeConnections}`);
    lines.push(`Messages Sent: ${metrics.websocketMetrics.messagesSent}`);
    lines.push(`Messages Received: ${metrics.websocketMetrics.messagesReceived}`);
    lines.push(`Avg Latency: ${metrics.websocketMetrics.averageLatency.toFixed(2)}ms`);

    lines.push('', '--- Model Performance ---');
    if (metrics.modelMetrics.length === 0) {
      lines.push('No model requests recorded');
    } else {
      metrics.modelMetrics.forEach(model => {
        lines.push(`Model: ${model.modelId}`);
        lines.push(`  Requests: ${model.requestCount}`);
        lines.push(`  Avg Response Time: ${model.averageResponseTime.toFixed(2)}ms`);
        lines.push(`  Error Rate: ${model.errorRate.toFixed(2)}%`);
      });
    }

    lines.push('', '--- Alerts ---');
    lines.push(`Active: ${activeAlerts.length}, Total: ${alerts.length}`);
    activeAlerts.forEach(alert => {
      lines.push(`[${alert.severity.toUpperCase()}] ${alert.message}`);
    });

    return lines.join('\n');
  }

  public exportMetrics(): string {
    return JSON.stringify({
      metrics: this.getMetrics(),
      alerts: this.getAlerts(),
      exportedAt: new Date().toISOString(),
    }, null, 2);
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 11);
  }

  private collectMetrics(): void {
    const cpuUsage = this.calculateCpuUsage();
    const memoryUsage = this.getMemoryUsage();
    const memoryPercentage = memoryUsage.heapTotal > 0 
      ? (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100 
      : 0;

    this.metrics = {
      timestamp: Date.now(),
      cpuUsage,
      memoryUsage,
      agentMetrics: this.metrics.agentMetrics.map(m => ({ ...m })),
      websocketMetrics: this.getWebSocketMetrics(),
      modelMetrics: this.metrics.modelMetrics.map(m => ({ ...m })),
    };

    this.checkThresholds(cpuUsage, memoryPercentage);
    this.emit('metrics', this.metrics);
  }

  private initializeMetrics(): PerformanceMetrics {
    return {
      timestamp: Date.now(),
      cpuUsage: 0,
      memoryUsage: this.getMemoryUsage(),
      agentMetrics: [],
      websocketMetrics: {
        connectionCount: 0,
        activeConnections: 0,
        messagesSent: 0,
        messagesReceived: 0,
        averageLatency: 0,
        reconnectionCount: 0,
      },
      modelMetrics: [],
    };
  }

  private getMemoryUsage(): MemoryUsage {
    if (this.isNodeEnv && process.memoryUsage) {
      try {
        const usage = process.memoryUsage();
        return {
          rss: usage.rss,
          heapTotal: usage.heapTotal,
          heapUsed: usage.heapUsed,
          external: usage.external,
          arrayBuffers: usage.arrayBuffers || 0,
        };
      } catch (error) {
        // ignore
      }
    }
    return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
  }

  private calculateCpuUsage(): number {
    if (!this.isNodeEnv || !this.lastCpuUsage || !process.cpuUsage) return 0;

    try {
      const cpuUsage = process.cpuUsage(this.lastCpuUsage);
      const totalTime = cpuUsage.user + cpuUsage.system;
      const percentage = Math.min((totalTime / (this.options.interval * 1000)) * 100, 100);
      this.lastCpuUsage = process.cpuUsage();
      return percentage;
    } catch (error) {
      return 0;
    }
  }

  private updateAgentMetrics(agentId: string, agentName: string, executionTime: number, success: boolean): void {
    let agentMetric = this.metrics.agentMetrics.find(m => m.agentId === agentId);
    
    if (!agentMetric) {
      agentMetric = {
        agentId,
        agentName,
        executionCount: 0,
        totalExecutionTime: 0,
        averageExecutionTime: 0,
        maxExecutionTime: 0,
        minExecutionTime: Infinity,
        successRate: 100,
        errorCount: 0,
      };
      this.metrics.agentMetrics.push(agentMetric);
    }

    agentMetric.executionCount++;
    agentMetric.totalExecutionTime += executionTime;
    agentMetric.averageExecutionTime = agentMetric.totalExecutionTime / agentMetric.executionCount;
    agentMetric.maxExecutionTime = Math.max(agentMetric.maxExecutionTime, executionTime);
    agentMetric.minExecutionTime = Math.min(agentMetric.minExecutionTime, executionTime);
    
    if (!success) agentMetric.errorCount++;
    agentMetric.successRate = ((agentMetric.executionCount - agentMetric.errorCount) / agentMetric.executionCount) * 100;
  }

  private updateModelMetrics(modelId: string, responseTime: number, success: boolean, tokens?: number): void {
    let modelMetric = this.metrics.modelMetrics.find(m => m.modelId === modelId);
    
    if (!modelMetric) {
      modelMetric = {
        modelId,
        requestCount: 0,
        totalResponseTime: 0,
        averageResponseTime: 0,
        averageTokensPerSecond: 0,
        errorRate: 0,
        totalTokens: 0,
        averageTokensPerRequest: 0,
      };
      this.metrics.modelMetrics.push(modelMetric);
    }

    modelMetric.requestCount++;
    modelMetric.totalResponseTime += responseTime;
    modelMetric.averageResponseTime = modelMetric.totalResponseTime / modelMetric.requestCount;

    if (tokens !== undefined && tokens > 0) {
      modelMetric.totalTokens += tokens;
      modelMetric.averageTokensPerRequest = modelMetric.totalTokens / modelMetric.requestCount;
      if (modelMetric.totalResponseTime > 0) {
        modelMetric.averageTokensPerSecond = modelMetric.totalTokens / (modelMetric.totalResponseTime / 1000);
      }
    }

    if (!success) {
      modelMetric.errorRate = ((modelMetric.errorRate * (modelMetric.requestCount - 1) / 100) + 1) / modelMetric.requestCount * 100;
    } else {
      modelMetric.errorRate = (modelMetric.errorRate * (modelMetric.requestCount - 1)) / modelMetric.requestCount;
    }
  }

  private getWebSocketMetrics(): WebSocketMetrics {
    const avgLatency = this.websocketLatencies.length > 0
      ? this.websocketLatencies.reduce((a, b) => a + b, 0) / this.websocketLatencies.length
      : 0;
    return { ...this.metrics.websocketMetrics, averageLatency: avgLatency };
  }

  private checkThresholds(cpuUsage: number, memoryUsage: number): void {
    if (cpuUsage > this.options.cpuThreshold) {
      this.createAlert('cpu', 'high', `CPU usage exceeds threshold`, cpuUsage, this.options.cpuThreshold);
    } else {
      this.resolveAlertsByType('cpu');
    }

    if (memoryUsage > this.options.memoryThreshold) {
      this.createAlert('memory', 'high', `Memory usage exceeds threshold`, memoryUsage, this.options.memoryThreshold);
    } else {
      this.resolveAlertsByType('memory');
    }

    if (this.metrics.websocketMetrics.averageLatency > this.options.latencyThreshold) {
      this.createAlert('latency', 'medium', `WebSocket latency exceeds threshold`, this.metrics.websocketMetrics.averageLatency, this.options.latencyThreshold);
    } else {
      this.resolveAlertsByType('latency');
    }

    for (const model of this.metrics.modelMetrics) {
      if (model.errorRate > this.options.errorRateThreshold) {
        this.createAlert('error_rate', 'high', `Model error rate exceeds threshold: ${model.modelId}`, model.errorRate, this.options.errorRateThreshold);
      } else {
        this.resolveAlertsByTypeAndContext('error_rate', model.modelId);
      }
    }
  }

  private createAlert(type: 'cpu' | 'memory' | 'latency' | 'error_rate', severity: 'low' | 'medium' | 'high' | 'critical', message: string, value: number, threshold: number): void {
    const alertId = `${type}-${Date.now()}`;
    const alert: PerformanceAlert = {
      id: alertId,
      type,
      severity,
      message,
      value,
      threshold,
      timestamp: Date.now(),
    };

    this.alerts.set(alertId, alert);
    this.enforceAlertsLimit();
    this.emit('alert', alert);
  }

  private enforceAlertsLimit(): void {
    const maxAlerts = this.options.maxAlertsHistory;
    if (this.alerts.size <= maxAlerts) return;

    const alertsArray = Array.from(this.alerts.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);

    const toRemove: string[] = [];
    let removed = 0;
    const excess = this.alerts.size - maxAlerts;

    for (const [id, alert] of alertsArray) {
      if (removed >= excess) break;
      if (alert.resolved) {
        toRemove.push(id);
        removed++;
      }
    }

    if (removed < excess) {
      for (const [id, alert] of alertsArray) {
        if (removed >= excess) break;
        if (!alert.resolved && !toRemove.includes(id)) {
          toRemove.push(id);
          removed++;
        }
      }
    }

    for (const id of toRemove) {
      this.alerts.delete(id);
    }
  }

  private resolveAlertsByType(type: string): void {
    this.alerts.forEach((alert, id) => {
      if (alert.type === type && !alert.resolved) {
        this.resolveAlert(id);
      }
    });
  }

  private resolveAlertsByTypeAndContext(type: string, context: string): void {
    this.alerts.forEach((alert, id) => {
      if (alert.type === type && !alert.resolved && alert.message.includes(context)) {
        this.resolveAlert(id);
      }
    });
  }

  private log(...args: any[]): void {
    if (this.options.debug) {
      console.log('[PerformanceMonitor]', ...args);
    }
  }
}

export function createPerformanceMonitor(options?: PerformanceMonitorOptions): PerformanceMonitor {
  return new PerformanceMonitor(options);
}

export default PerformanceMonitor;
