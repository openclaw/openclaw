/**
 * Recoder Plugin Types
 *
 * Shared type definitions for the OpenClaw Recoder integration.
 */

// ==================== Plugin Config ====================

export interface RecoderPluginConfig {
  webUrl?: string;
  dockerUrl?: string;
  apiUrl?: string;
  apiKey?: string;
  userId?: string;
  defaultTemplate?: SandboxTemplate;
  autoStartSandbox?: boolean;
  sandboxTimeoutSeconds?: number;
}

// ==================== API Key Types ====================

export interface OpenClawApiKey {
  id: string;
  keyPrefix: string;
  openclawUserId: string;
  openclawChannel: string;
  recoderUserId?: string;
  scopes: string[];
  tier: "free" | "developer" | "team" | "enterprise";
  isActive: boolean;
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

export interface CreateApiKeyRequest {
  openclawUserId: string;
  openclawChannel: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

export interface CreateApiKeyResponse {
  apiKey: string;
  keyInfo: OpenClawApiKey;
}

// ==================== Project Types ====================

export interface RecoderProject {
  id: string;
  name: string;
  template: SandboxTemplate;
  sandboxId?: string;
  previewUrl?: string;
  createdAt: number;
  lastActivityAt: number;
  metadata?: Record<string, unknown>;
}

export interface CreateProjectRequest {
  name: string;
  template?: SandboxTemplate;
  files?: Array<{ path: string; content: string }>;
  autoStart?: boolean;
}

export interface CreateProjectResponse {
  project: RecoderProject;
  sandbox?: SandboxResponse;
}

// ==================== Sandbox Types ====================

export type SandboxState = "creating" | "running" | "stopped" | "error" | "deleted";

export type SandboxTemplate =
  | "node"
  | "python"
  | "react"
  | "nextjs"
  | "vue"
  | "svelte"
  | "vanilla"
  | "custom";

export interface SandboxResourceLimits {
  memoryMB?: number;
  cpuShares?: number;
  diskMB?: number;
  networkKbps?: number;
}

export interface SandboxCreateRequest {
  name?: string;
  template?: SandboxTemplate;
  files?: Array<{ path: string; content: string }>;
  env?: Record<string, string>;
  resourceLimits?: SandboxResourceLimits;
  timeoutSeconds?: number;
  startDevServer?: boolean;
  metadata?: Record<string, unknown>;
}

export interface SandboxResponse {
  id: string;
  name: string;
  state: SandboxState;
  template: SandboxTemplate;
  previewUrl?: string;
  terminalUrl?: string;
  createdAt: number;
  lastActivityAt: number;
  expiresAt?: number;
  resourceLimits: SandboxResourceLimits;
  metadata?: Record<string, unknown>;
}

// ==================== File Types ====================

export interface FileInfo {
  path: string;
  name: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt: number;
  mimeType?: string;
}

export interface FileWriteRequest {
  path: string;
  content: string;
  isBase64?: boolean;
  createDirectories?: boolean;
}

export interface FileReadResponse {
  path: string;
  content: string;
  isBase64: boolean;
  size: number;
  mimeType: string;
  totalLines?: number;
}

// ==================== Command Types ====================

export interface CommandExecuteRequest {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stream?: boolean;
}

export interface CommandExecuteResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  timedOut: boolean;
  killed: boolean;
}

// ==================== Code Generation Types ====================

export interface CodeGenerationRequest {
  projectId?: string;
  prompt: string;
  context?: string;
  model?: string;
  provider?: string;
  maxTokens?: number;
}

export interface CodeGenerationResponse {
  success: boolean;
  files?: Array<{ path: string; content: string }>;
  actions?: Array<{ type: string; payload: unknown }>;
  message?: string;
  error?: string;
}

// ==================== Session State Types ====================

export interface RecoderSessionProject {
  id: string;
  name: string;
  sandboxId?: string;
  previewUrl?: string;
  createdFiles: string[];
  lastActivityAt: number;
}

export interface RecoderSessionState {
  activeProjectId: string | null;
  projects: Record<string, RecoderSessionProject>;
  lastUpdated: number;
}

// ==================== API Response Types ====================

export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
  requestId?: string;
  timestamp?: string;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  requestId?: string;
  timestamp?: string;
}

export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;

// ==================== Error Types ====================

export enum RecoderErrorCode {
  // Auth errors
  INVALID_API_KEY = "INVALID_API_KEY",
  API_KEY_EXPIRED = "API_KEY_EXPIRED",
  AUTH_REQUIRED = "AUTH_REQUIRED",

  // Rate limiting
  RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED",

  // Project errors
  PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND",
  PROJECT_CREATION_FAILED = "PROJECT_CREATION_FAILED",

  // Sandbox errors
  SANDBOX_NOT_FOUND = "SANDBOX_NOT_FOUND",
  SANDBOX_NOT_RUNNING = "SANDBOX_NOT_RUNNING",
  SANDBOX_CREATION_FAILED = "SANDBOX_CREATION_FAILED",

  // File errors
  FILE_NOT_FOUND = "FILE_NOT_FOUND",
  FILE_TOO_LARGE = "FILE_TOO_LARGE",
  FILE_OPERATION_FAILED = "FILE_OPERATION_FAILED",

  // Command errors
  COMMAND_TIMEOUT = "COMMAND_TIMEOUT",
  COMMAND_FAILED = "COMMAND_FAILED",

  // Code generation errors
  CODE_GENERATION_FAILED = "CODE_GENERATION_FAILED",

  // General errors
  INTERNAL_ERROR = "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE",
  NETWORK_ERROR = "NETWORK_ERROR",
}

export class RecoderError extends Error {
  constructor(
    public code: RecoderErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RecoderError";
  }
}
