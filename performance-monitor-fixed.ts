/**
 * OpenClaw Performance Monitor
 * 
 * A comprehensive performance monitoring and profiling tool
 * 
 * Features:
 * - CPU and memory usage tracking (Node.js only)
 * - Agent execution time measurement
 * - WebSocket connection metrics
 * - Model response time tracking
 * - Bottleneck detection
 * - Performance alerts
 * 
 * @module PerformanceMonitor
 * @version 1.0.3
 * @license MIT
 */

// ===== Type Declarations =====

/**
 * CPU usage information (microseconds)
 */
interface CpuUsage {
  user: number;
  system: number;
}

/**
 * Memory usage information (bytes)
 */
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

// ===== Internal Types =====

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

// ===== Simple EventEmitter Implementation =====

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

// ===== Performance Monitor Implementation =====

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

    // Detect environment
    this.isNodeEnv = typeof process !== 'undefined' && 
                     typeof process.version === 'string' &&
                     typeof process.cpuUsage === 'function';

    this.metrics = this.initializeMetrics();
    
    // Initialize CPU usage tracking in Node.js environment
    if (this.isNodeEnv) {
      try {
        this.lastCpuUsage = process.cpuUsage();
      } catch (error) {
        this.log('Failed to initialize CPU tracking:', error);
      }
    }
    
    this.log('PerformanceMonitor initialized (Node.js:', this.isNodeEnv, ')');
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
   * @param agentId - Unique agent identifier (e.g., 'agent-1', 'my-agent-v2')
   * @param agentName - Human-readable agent name
   * @returns Execution ID for tracking
   */
  public startAgentExecution(agentId: string, agentName: string): string {
    const executionId = `${agentId}::${Date.now()}::${this.generateId()}`;
    this.agentExecutions.set(executionId, {
      startTime: Date.now(),
      success: false,
      agentId,
      agentName,
    });
    this.log(`Started agent execution tracking: ${agentName} (${agentId})`);
    return executionId;
  }

  /**
   * End tracking agent execution
   * @param executionId - Execution ID from startAgentExecution
   * @param success - Whether execution succeeded
   */
  public endAgentExecution(executionId: string, success: boolean = true): void {
    const execution = this.agentExecutions.get(executionId);
    if (!execution) {
      this.log(`Execution ID not found: ${executionId}`);
      return;
    }

    const executionTime = Date.now() - execution.startTime;
    execution.success = success;

    this.updateAgentMetrics(
      execution.agentId, 
      execution.agentName, 
      executionTime, 
      success
    );

    this.agentExecutions.delete(executionId);
    this.log(`Ended agent execution: ${executionId}, time: ${executionTime}ms, success: ${success}`);
  }

  /**
   * Start tracking model request
   * @param modelId - Model identifier (e.g., 'gpt-4o-mini', 'claude-3-5-sonnet')
   * @returns Request ID for tracking
   */
  public startModelRequest(modelId: string): string {
    const requestId = `${modelId}::${Date.now()}::${this.generateId()}`;
    this.modelRequests.set(requestId, {
      startTime: Date.now(),
      success: false,
      modelId,
    });
    this.log(`Started model request tracking: ${modelId}`);
    return requestId;
  }

  /**
   * End tracking model request
   * @param requestId - Request ID from startModelRequest
   * @param success - Whether request succeeded
   * @param tokens - Number of tokens processed (optional)
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

    this.updateModelMetrics(request.modelId, responseTime, success, tokens);

    this.modelRequests.delete(requestId);
    this.log(`Ended model request: ${requestId}, time: ${responseTime}ms, success: ${success}, tokens: ${tokens}`);
  }

  /**
   * Track WebSocket message latency
   * @param latency - Latency in milliseconds
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
   * Update WebSocket metrics
   */
  public updateWebSocketMetrics(metrics: Partial<WebSocketMetrics>): void {
    this.metrics.websocketMetrics = {
      ...this.metrics.websocketMetrics,
      ...metrics,
    };
  }

  /**
   * Resolve an alert
   * @param alertId - Alert ID to resolve
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
   * @returns Formatted report string
   */
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

    lines.push('');
    lines.push('--- Agent Performance ---');
    
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

    lines.push('');
    lines.push('--- WebSocket Performance ---');
    lines.push(`Active Connections: ${metrics.websocketMetrics.activeConnections}`);
    lines.push(`Messages Sent: ${metrics.websocketMetrics.messagesSent}`);
    lines.push(`Messages Received: ${metrics.websocketMetrics.messagesReceived}`);
    lines.push(`Avg Latency: ${metrics.websocketMetrics.averageLatency.toFixed(2)}ms`);
    lines.push(`Reconnections: ${metrics.websocketMetrics.reconnectionCount}`);

    lines.push('');
    lines.push('--- Model Performance ---');
    
    if (metrics.modelMetrics.length === 0) {
      lines.push('No model requests recorded');
    } else {
      metrics.modelMetrics.forEach(model => {
        lines.push(`Model: ${model.modelId}`);
        lines.push(`  Requests: ${model.requestCount}`);
        lines.push(`  Avg Response Time: ${model.averageResponseTime.toFixed(2)}ms`);
        lines.push(`  Avg Tokens/Second: ${model.averageTokensPerSecond.toFixed(2)}`);
        lines.push(`  Error Rate: ${model.errorRate.toFixed(2)}%`);
      });
    }

    lines.push('');
    lines.push('--- Alerts ---');
    lines.push(`Active Alerts: ${activeAlerts.length}`);
    lines.push(`Total Alerts: ${alerts.length}`);
    
    if (activeAlerts.length > 0) {
      activeAlerts.forEach(alert => {
        lines.push(`[${alert.severity.toUpperCase()}] ${alert.message} (Value: ${alert.value.toFixed(2)}, Threshold: ${alert.threshold})`);
      });
    }

    return lines.join('\n');
  }

  /**
   * Export metrics as JSON
   */
  public exportMetrics(): string {
    return JSON.stringify({
      metrics: this.getMetrics(),
      alerts: this.getAlerts(),
      exportedAt: new Date().toISOString(),
    }, null, 2);
  }

  // ===== Private Methods =====

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
        this.log('Failed to get memory usage:', error);
      }
    }
    
    // Fallback for non-Node.js environments
    return {
      rss: 0,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    };
  }

  private calculateCpuUsage(): number {
    if (!this.isNodeEnv || !this.lastCpuUsage || !process.cpuUsage) {
      return 0;
    }

    try {
      const cpuUsage = process.cpuUsage(this.lastCpuUsage);
      const totalTime = cpuUsage.user + cpuUsage.system;
      const percentage = Math.min(
        (totalTime / (this.options.interval * 1000)) * 100, 
        100
      );
      
      // Update baseline for next interval
      this.lastCpuUsage = process.cpuUsage();
      
      return percentage;
    } catch (error) {
      this.log('Failed to calculate CPU usage:', error);
      return 0;
    }
  }

  private updateAgentMetrics(
    agentId: string, 
    agentName: string, 
    executionTime: number, 
    success: boolean
  ): void {
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
    
    if (!success) {
      agentMetric.errorCount++;
    }
    
    // Calculate success rate as percentage (0-100)
    agentMetric.successRate = 
      ((agentMetric.executionCount - agentMetric.errorCount) / agentMetric.executionCount) * 100;
  }

  private updateModelMetrics(
    modelId: string, 
    responseTime: number, 
    success: boolean, 
    tokens?: number
  ): void {
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
        modelMetric.averageTokensPerSecond = 
          modelMetric.totalTokens / (modelMetric.totalResponseTime / 1000);
      }
    }

    // Calculate error rate as percentage (0-100)
    if (!success) {
      modelMetric.errorRate = 
        ((modelMetric.errorRate * (modelMetric.requestCount - 1) / 100) + 1) / modelMetric.requestCount * 100;
    } else {
      modelMetric.errorRate = 
        (modelMetric.errorRate * (modelMetric.requestCount - 1)) / modelMetric.requestCount;
    }
  }

  private getAgentMetricsArray(): AgentMetrics[] {
    return this.metrics.agentMetrics.map(m => ({ ...m }));
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
    return this.metrics.modelMetrics.map(m => ({ ...m }));
  }

  private checkThresholds(cpuUsage: number, memoryUsage: number): void {
    // CPU Threshold
    if (cpuUsage > this.options.cpuThreshold) {
      this.createAlert(
        'cpu', 
        'high', 
        `CPU usage exceeds threshold`, 
        cpuUsage, 
        this.options.cpuThreshold
      );
    } else {
      this.resolveAlertsByType('cpu');
    }

    // Memory Threshold
    if (memoryUsage > this.options.memoryThreshold) {
      this.createAlert(
        'memory', 
        'high', 
        `Memory usage exceeds threshold`, 
        memoryUsage, 
        this.options.memoryThreshold
      );
    } else {
      this.resolveAlertsByType('memory');
    }

    // Latency Threshold
    if (this.metrics.websocketMetrics.averageLatency > this.options.latencyThreshold) {
      this.createAlert(
        'latency', 
        'medium', 
        `WebSocket latency exceeds threshold`, 
        this.metrics.websocketMetrics.averageLatency, 
        this.options.latencyThreshold
      );
    } else {
      this.resolveAlertsByType('latency');
    }

    // Error Rate Threshold
    for (const model of this.metrics.modelMetrics) {
      if (model.errorRate > this.options.errorRateThreshold) {
        this.createAlert(
          'error_rate', 
          'high', 
          `Model error rate exceeds threshold: ${model.modelId}`, 
          model.errorRate, 
          this.options.errorRateThreshold
        );
      } else {
        this.resolveAlertsByTypeAndContext('error_rate', model.modelId);
      }
    }
  }

  private createAlert(
    type: 'cpu' | 'memory' | 'latency' | 'error_rate',
    severity: 'low' | 'medium' | 'high' | 'critical',
    message: string,
    value: number,
    threshold: number
  ): void {
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

// ===== Factory Function =====

export function createPerformanceMonitor(options?: PerformanceMonitorOptions): PerformanceMonitor {
  return new PerformanceMonitor(options);
}

// ===== Default Export =====

export default PerformanceMonitor;
