export interface HistoryDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface MercureConfig {
  hubUrl: string;
  jwtSecret: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

/** RabbitMQ listener config for instant task notifications. */
export interface RabbitMqListenerConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  queue: string;
}

export interface ReportGeneratorConfig {
  historyDb: HistoryDbConfig;
  mercure: MercureConfig;
  smtp?: SmtpConfig;
  /** Optional: when present, tasks are processed the moment they are queued. */
  rabbitmq?: RabbitMqListenerConfig;
  pollIntervalMs: number;
}

export type ReportPeriod = "Daily" | "Weekly" | "Monthly";

export interface ReportTask {
  id: number;
  uid: number;
  topicId: number;
  slaveTopicId: number;
  category: string;
  period: ReportPeriod;
  status: "Pending" | "Running" | "Done" | "Fail";
  params: string; // JSON string
  requirement: string;
  title: string;
  content: string;
  dateScope?: { start: string; end: string };
  userEmail?: string; // User's email for sending reports
}

export interface FeedRecord {
  id: number;
  topicId: number;
  slaveTopicId: number;
  platform: string;
  emotion: string;
  level: string;
  link: string;
  date: Date;
  fansNumber: number;
  comments: number;
  contentType: string;
  mediaLevel: string;
  city: string;
  title: string;
  author: string;
  content: string;
  label: string;
  keywords: string;
  summary: string;
}

export interface GeneratedReport {
  title: string;
  content: string;
  summary: string;
}
