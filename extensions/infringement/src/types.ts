/** MySQL connection config (read or write). */
export interface MySqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** RabbitMQ broker config for dispatching 研判 tasks. */
export interface RabbitMqConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Queue the Java 研判 worker consumes. Defaults to "TaskWorker". */
  taskQueue: string;
}

/** Resolved plugin configuration. */
export interface InfringementConfig {
  /** Read-only pool used by infringement_query. */
  read: MySqlConfig;
  /** Write-capable pool used by infringement_create_task. */
  write: MySqlConfig;
  /** Broker used to dispatch caseIds to the Java TaskWorker queue. */
  rabbitmq: RabbitMqConfig;
}
