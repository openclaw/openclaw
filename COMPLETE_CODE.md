/**
 * OpenClaw Performance Monitor
 * 
 * A comprehensive performance monitoring and profiling tool for OpenClaw
 * Features:
 * - CPU and memory usage tracking
 * - Agent execution time measurement
 * - WebSocket connection metrics
 * - Model response time tracking
 * - Bottleneck detection
 * - Performance alerts
 * 
 * @module PerformanceMonitor
 * @version 1.0.0
 * @license MIT
 */

import { EventEmitter } from 'events';

export interface PerformanceMetrics {
  timestamp: number;
  cpuUsage: number;
  memoryUsage: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
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
  /** Monitoring interval in milliseconds (default: 5000) */
  interval?: number;
  /** CPU usage alert threshold (percentage, default: 80) */
  cpuThreshold?: number;
  /** Memory usage alert threshold (percentage, default: 80) */
  memoryThreshold?: number;
  /** Latency alert threshold in milliseconds (default: 5000) */
  latencyThreshold?: number;
  /** Error rate alert threshold (percentage, default: 10) */
  errorRateThreshold?: number;
  /** Enable debug logging */
  debug?: boolean;
  /** Maximum number of alerts to keep in history (default: 100) */
  maxAlertsHistory?: number;
}

export class PerformanceMonitor extends EventEmitter {
  private options: Required<PerformanceMonitorOptions>;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private metrics: PerformanceMetrics;
  private alerts: Map<string, PerformanceAlert> = new Map();
  private agentExecutions: Map<string, { startTime: number; success: boolean }> = new Map();
  private modelRequests: Map<string, { startTime: number; tokens?: number; success: boolean }> = new Map();
  private websocketLatencies: number[] = [];
  private initialCpuUsage: NodeJS.CpuUsage;
  private isRunning: boolean = false;

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

    this.initialCpuUsage = process.cpuUsage();
    this.metrics = this.initializeMetrics();
    
    this.log('PerformanceMonitor initialized');
  }

  /**
   * Start performance monitoring
   */
  public start(): void {
    if (this.isRunning) {
      this.log('Performance monitoring already running');
      return;
    }

    this.isRunning = true;
    this.log('Starting performance monitoring');

    this.monitoringInterval = setInterval(() => {
      this.collectMetrics();
    }, this.options.interval);
  }

  /**
   * Stop performance monitoring
   */
  public stop(): void {
    if (!this.isRunning) {
      this.log('Performance monitoring not running');
      return;
    }

    this.isRunning = false;
    this.log('Stopping performance monitoring');

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }

  /**
   * Get current metrics
   */
  public getMetrics(): PerformanceMetrics {
    return { ...this.metrics };
  }

  /**
   * Get active alerts
   */
  public getAlerts(): PerformanceAlert[] {
    return Array.from(this.alerts.values()).sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Start tracking agent execution
   */
  public startAgentExecution(agentId: string, agentName: string): string {
    const executionId = `${agentId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.agentExecutions.set(executionId, {
      startTime: Date.now(),
      success: false,
    });
    this.log(`Started agent execution tracking: ${agentName} (${agentId})`);
    return executionId;
  }

  /**
   * End tracking agent execution
   */
  public endAgentExecution(executionId: string, success: boolean = true): void {
    const execution = this.agentExecutions.get(executionId);
    if (!execution) {
      this.log(`Execution ID not found: ${executionId}`);
      return;
    }

    const executionTime = Date.now() - execution.startTime;
    execution.success = success;

    // Extract agent ID from execution ID
    const agentId = executionId.split('-')[0];
    this.updateAgentMetrics(agentId, executionTime, success);

    this.agentExecutions.delete(executionId);
    this.log(`Ended agent execution: ${executionId}, time: ${executionTime}ms, success: ${success}`);
  }

  /**
   * Start tracking model request
   */
  public startModelRequest(modelId: string): string {
    const requestId = `${modelId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.modelRequests.set(requestId, {
      startTime: Date.now(),
      success: false,
    });
    this.log(`Started model request tracking: ${modelId}`);
    return requestId;
  }

  /**
   * End tracking model request
   */
  public endModelRequest(requestId: string, success: boolean = true, tokens?: number): void {
    const request = this.modelRequests.get(requestId);
    if (!request) {
      this.log(`Request ID not found: ${requestId}`);
      return;
    }

    const responseTime = Date.now() - request.startTime;
    request.success = success;
    request.tokens = tokens;

    // Extract model ID from request ID
    const modelId = requestId.split('-')[0];
    this.updateModelMetrics(modelId, responseTime, success, tokens);

    this.modelRequests.delete(requestId);
    this.log(`Ended model request: ${requestId}, time: ${responseTime}ms, success: ${success}, tokens: ${tokens}`);
  }

  /**
   * Track WebSocket message latency
   */
  public trackWebSocketLatency(latency: number): void {
    this.websocketLatencies.push(latency);
    
    // Keep only last 100 latencies
    if (this.websocketLatencies.length > 100) {
      this.websocketLatencies.shift();
    }

    this.log(`Tracked WebSocket latency: ${latency}ms`);
  }

  /**
   * Resolve an alert
   */
  public resolveAlert(alertId: string): void {
    const alert = this.alerts.get(alertId);
    if (alert && !alert.resolved) {
      alert.resolved = true;
      alert.resolvedAt = Date.now();
      this.emit('alertResolved', alert);
      this.log(`Alert resolved: ${alertId}`);
    }
  }

  /**
   * Generate performance report
   */
  public generateReport(): string {
    const metrics = this.getMetrics();
    const alerts = this.getAlerts();
    const activeAlerts = alerts.filter(a => !a.resolved);

    let report = '=== OpenClaw Performance Report ===\n';
    report += `Generated at: ${new Date(metrics.timestamp).toISOString()}\n\n`;

    // CPU & Memory
    report += '--- System Resources ---\n';
    report += `CPU Usage: ${metrics.cpuUsage.toFixed(2)}%\n`;
    report += `Memory Usage: ${((metrics.memoryUsage.heapUsed / metrics.memoryUsage.heapTotal) * 100).toFixed(2)}%\n`;
    report += `RSS: ${(metrics.memoryUsage.rss / 1024 / 1024).toFixed(2)} MB\n`;
    report += `Heap: ${(metrics.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB / ${(metrics.memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB\n\n`;

    // Agents
    report += '--- Agent Performance ---\n';
    metrics.agentMetrics.forEach(agent => {
      report += `Agent: ${agent.agentName} (${agent.agentId})\n`;
      report += `  Executions: ${agent.executionCount}\n`;
      report += `  Avg Time: ${agent.averageExecutionTime.toFixed(2)}ms\n`;
      report += `  Success Rate: ${(agent.successRate * 100).toFixed(2)}%\n`;
      report += `  Errors: ${agent.errorCount}\n`;
    });

    // WebSocket
    report += '\n--- WebSocket Performance ---\n';
    report += `Active Connections: ${metrics.websocketMetrics.activeConnections}\n`;
    report += `Messages Sent: ${metrics.websocketMetrics.messagesSent}\n`;
    report += `Messages Received: ${metrics.websocketMetrics.messagesReceived}\n`;
    report += `Avg Latency: ${metrics.websocketMetrics.averageLatency.toFixed(2)}ms\n`;
    report += `Reconnections: ${metrics.websocketMetrics.reconnectionCount}\n`;

    // Models
    report += '\n--- Model Performance ---\n';
    metrics.modelMetrics.forEach(model => {
      report += `Model: ${model.modelId}\n`;
      report += `  Requests: ${model.requestCount}\n`;
      report += `  Avg Response Time: ${model.averageResponseTime.toFixed(2)}ms\n`;
      report += `  Avg Tokens/Second: ${model.averageTokensPerSecond.toFixed(2)}\n`;
      report += `  Error Rate: ${(model.errorRate * 100).toFixed(2)}%\n`;
    });

    // Alerts
    report += '\n--- Alerts ---\n';
    report += `Active Alerts: ${activeAlerts.length}\n`;
    report += `Total Alerts: ${alerts.length}\n`;
    activeAlerts.forEach(alert => {
      report += `[${alert.severity.toUpperCase()}] ${alert.message} (Value: ${alert.value}, Threshold: ${alert.threshold})\n`;
    });

    return report;
  }

  private collectMetrics(): void {
    const cpuUsage = this.calculateCpuUsage();
    const memoryUsage = process.memoryUsage();
    const memoryPercentage = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;

    this.metrics = {
      timestamp: Date.now(),
      cpuUsage,
      memoryUsage,
      agentMetrics: this.getAgentMetricsArray(),
      websocketMetrics: this.getWebSocketMetrics(),
      modelMetrics: this.getModelMetricsArray(),
    };

    this.checkThresholds(cpuUsage, memoryPercentage);
    this.emit('metrics', this.metrics);
    this.log('Metrics collected');
  }

  private initializeMetrics(): PerformanceMetrics {
    return {
      timestamp: Date.now(),
      cpuUsage: 0,
      memoryUsage: process.memoryUsage(),
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

  private calculateCpuUsage(): number {
    const cpuUsage = process.cpuUsage(this.initialCpuUsage);
    const totalTime = cpuUsage.user + cpuUsage.system;
    // Rough estimate: convert to percentage
    return Math.min((totalTime / (this.options.interval * 1000)) * 100, 100);
  }

  private updateAgentMetrics(agentId: string, executionTime: number, success: boolean): void {
    let agentMetric = this.metrics.agentMetrics.find(m => m.agentId === agentId);
    
    if (!agentMetric) {
      agentMetric = {
        agentId,
        agentName: agentId,
        executionCount: 0,
        totalExecutionTime: 0,
        averageExecutionTime: 0,
        maxExecutionTime: 0,
        minExecutionTime: Infinity,
        successRate: 0,
        errorCount: 0,
      };
      this.metrics.agentMetrics.push(agentMetric);
    }

    agentMetric.executionCount++;
    agentMetric.totalExecutionTime += executionTime;
    agentMetric.averageExecutionTime = agentMetric.totalExecutionTime / agentMetric.executionCount;
    agentMetric.maxExecutionTime = Math.max(agentMetric.maxExecutionTime, executionTime);
    agentMetric.minExecutionTime = Math.min(agentMetric.minExecutionTime, executionTime);
    
    if (success) {
      agentMetric.successRate = ((agentMetric.executionCount - agentMetric.errorCount) / agentMetric.executionCount) * 100;
    } else {
      agentMetric.errorCount++;
      agentMetric.successRate = ((agentMetric.executionCount - agentMetric.errorCount) / agentMetric.executionCount) * 100;
    }
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
        averageTokensPerRequest: 0,
      };
      this.metrics.modelMetrics.push(modelMetric);
    }

    modelMetric.requestCount++;
    modelMetric.totalResponseTime += responseTime;
    modelMetric.averageResponseTime = modelMetric.totalResponseTime / modelMetric.requestCount;

    if (tokens) {
      modelMetric.averageTokensPerRequest += tokens;
      modelMetric.averageTokensPerSecond = modelMetric.averageTokensPerRequest / (modelMetric.totalResponseTime / 1000);
      modelMetric.averageTokensPerRequest = modelMetric.averageTokensPerRequest / modelMetric.requestCount;
    }

    if (!success) {
      modelMetric.errorRate = (modelMetric.errorRate * (modelMetric.requestCount - 1) + 100) / modelMetric.requestCount;
    } else {
      modelMetric.errorRate = modelMetric.errorRate * (modelMetric.requestCount - 1) / modelMetric.requestCount;
    }
  }

  private getAgentMetricsArray(): AgentMetrics[] {
    return [...this.metrics.agentMetrics];
  }

  private getWebSocketMetrics(): WebSocketMetrics {
    const avgLatency = this.websocketLatencies.length > 0
      ? this.websocketLatencies.reduce((a, b) => a + b, 0) / this.websocketLatencies.length
      : 0;

    return {
      ...this.metrics.websocketMetrics,
      averageLatency: avgLatency,
    };
  }

  private getModelMetricsArray(): ModelMetrics[] {
    return [...this.metrics.modelMetrics];
  }

  private checkThresholds(cpuUsage: number, memoryUsage: number): void {
    // CPU Threshold
    if (cpuUsage > this.options.cpuThreshold) {
      this.createAlert('cpu', 'high', `CPU usage exceeds threshold`, cpuUsage, this.options.cpuThreshold);
    } else {
      this.resolveAlertsByType('cpu');
    }

    // Memory Threshold
    if (memoryUsage > this.options.memoryThreshold) {
      this.createAlert('memory', 'high', `Memory usage exceeds threshold`, memoryUsage, this.options.memoryThreshold);
    } else {
      this.resolveAlertsByType('memory');
    }

    // Latency Threshold
    if (this.metrics.websocketMetrics.averageLatency > this.options.latencyThreshold) {
      this.createAlert('latency', 'medium', `WebSocket latency exceeds threshold`, this.metrics.websocketMetrics.averageLatency, this.options.latencyThreshold);
    } else {
      this.resolveAlertsByType('latency');
    }

    // Error Rate Threshold
    for (const model of this.metrics.modelMetrics) {
      if (model.errorRate > this.options.errorRateThreshold) {
        this.createAlert('error_rate', 'high', `Model error rate exceeds threshold: ${model.modelId}`, model.errorRate, this.options.errorRateThreshold);
      }
    }
  }

  private createAlert(type: string, severity: 'low' | 'medium' | 'high' | 'critical', message: string, value: number, threshold: number): void {
    const alertId = `${type}-${Date.now()}`;
    const alert: PerformanceAlert = {
      id: alertId,
      type: type as any,
      severity,
      message,
      value,
      threshold,
      timestamp: Date.now(),
    };

    this.alerts.set(alertId, alert);
    this.emit('alert', alert);
    this.log(`Alert created: ${message}`);
  }

  private resolveAlertsByType(type: string): void {
    this.alerts.forEach((alert, id) => {
      if (alert.type === type && !alert.resolved) {
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

// Export factory function for easy usage
export function createPerformanceMonitor(options?: PerformanceMonitorOptions): PerformanceMonitor {
  return new PerformanceMonitor(options);
}

// Example usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const monitor = createPerformanceMonitor({
    debug: true,
    cpuThreshold: 80,
    memoryThreshold: 80,
    latencyThreshold: 3000,
  });

  // Listen for metrics
  monitor.on('metrics', (metrics) => {
    console.log('Metrics updated:', metrics.cpuUsage.toFixed(2) + '% CPU');
  });

  // Listen for alerts
  monitor.on('alert', (alert) => {
    console.warn(`[ALERT] ${alert.message}: ${alert.value.toFixed(2)}% (threshold: ${alert.threshold}%)`);
  });

  // Start monitoring
  monitor.start();

  // Simulate agent execution
  const executionId = monitor.startAgentExecution('test-agent', 'Test Agent');
  setTimeout(() => {
    monitor.endAgentExecution(executionId, true);
  }, 100);

  // Generate report after 10 seconds
  setTimeout(() => {
    console.log(monitor.generateReport());
    monitor.stop();
  }, 10000);
}
