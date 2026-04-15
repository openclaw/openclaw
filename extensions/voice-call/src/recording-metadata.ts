/**
 * Voice Call Recording Metadata Manager
 * 
 * Tracks call recording status, storage locations, and provides
 * recording analytics and management capabilities.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface CallRecordingMetadata {
  recordingId: string;
  callId: string;
  providerCallId: string;
  provider: string;
  startedAt: number;
  stoppedAt?: number;
  durationMs?: number;
  status: "recording" | "completed" | "failed" | "paused";
  format: "wav" | "mp3" | "ogg" | "m4a";
  channels: 1 | 2;
  sampleRate: number;
  fileSizeBytes?: number;
  storagePath?: string;
  publicUrl?: string;
  encryptionEnabled: boolean;
  encryptionKeyId?: string;
  checksum?: string;
  transcriptionStatus?: "pending" | "in_progress" | "completed" | "failed";
  transcriptionText?: string;
  tags: string[];
  quality: "low" | "medium" | "high" | "ultra";
  errorMessage?: string;
  metadata: Record<string, unknown>;
}

export interface RecordingAnalytics {
  totalRecordings: number;
  totalDurationMs: number;
  totalStorageBytes: number;
  recordingsByStatus: Record<string, number>;
  recordingsByProvider: Record<string, number>;
  recordingsByQuality: Record<string, number>;
  averageDurationMs: number;
  averageFileSizeBytes: number;
  transcriptionRate: number;
  dailyRecordingCounts: Record<string, number>;
  hourlyDistribution: number[];
  storageTrend: Array<{ date: string; bytes: number }>;
}

export interface RecordingSearchFilters {
  callId?: string;
  provider?: string;
  status?: CallRecordingMetadata["status"];
  startDate?: Date;
  endDate?: Date;
  tags?: string[];
  hasTranscription?: boolean;
  quality?: CallRecordingMetadata["quality"];
}

const RECORDING_METADATA_FILE = "recording-metadata.jsonl";
const RECORDING_INDEX_FILE = "recording-index.json";
const MAX_METADATA_RETENTION_DAYS = 90;

export class RecordingMetadataManager {
  private stateDir: string;
  private metadataPath: string;
  private indexPath: string;
  private inMemoryCache: Map<string, CallRecordingMetadata> = new Map();
  private initialized: boolean = false;

  constructor(stateDir: string) {
    this.stateDir = path.join(stateDir, "voice-call", "recordings");
    this.metadataPath = path.join(this.stateDir, RECORDING_METADATA_FILE);
    this.indexPath = path.join(this.stateDir, RECORDING_INDEX_FILE);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await this.loadIndex();
    this.initialized = true;
  }

  private async loadIndex(): Promise<void> {
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      const index = JSON.parse(raw) as Record<string, string>;
      // Index maps callId -> recordingId for quick lookup
      for (const [callId, recordingId] of Object.entries(index)) {
        // We'll lazy-load full metadata
      }
    } catch {
      // Index doesn't exist yet, will be created
    }
  }

  private async saveIndex(index: Record<string, string>): Promise<void> {
    await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2));
  }

  async createRecordingMetadata(params: {
    callId: string;
    providerCallId: string;
    provider: string;
    format?: CallRecordingMetadata["format"];
    channels?: 1 | 2;
    sampleRate?: number;
    quality?: CallRecordingMetadata["quality"];
    encryptionEnabled?: boolean;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<CallRecordingMetadata> {
    await this.initialize();

    const recordingId = `rec_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = Date.now();

    const recording: CallRecordingMetadata = {
      recordingId,
      callId: params.callId,
      providerCallId: params.providerCallId,
      provider: params.provider,
      startedAt: now,
      status: "recording",
      format: params.format ?? "wav",
      channels: params.channels ?? 2,
      sampleRate: params.sampleRate ?? 16000,
      encryptionEnabled: params.encryptionEnabled ?? false,
      tags: params.tags ?? [],
      quality: params.quality ?? "high",
      metadata: params.metadata ?? {},
    };

    // Store metadata
    await this.appendMetadata(recording);
    this.inMemoryCache.set(recordingId, recording);

    // Update index
    const index = await this.loadIndexRaw();
    index[params.callId] = recordingId;
    await this.saveIndex(index);

    return recording;
  }

  private async loadIndexRaw(): Promise<Record<string, string>> {
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private async appendMetadata(recording: CallRecordingMetadata): Promise<void> {
    const line = JSON.stringify(recording) + "\n";
    await fs.appendFile(this.metadataPath, line, "utf8");
  }

  async updateRecording(
    recordingId: string,
    updates: Partial<Omit<CallRecordingMetadata, "recordingId" | "callId" | "startedAt">>
  ): Promise<CallRecordingMetadata | undefined> {
    await this.initialize();

    const recording = await this.getRecording(recordingId);
    if (!recording) return undefined;

    const updated = { ...recording, ...updates };
    
    // If stopping, calculate duration
    if (updates.status === "completed" && !updates.durationMs) {
      updated.durationMs = Date.now() - recording.startedAt;
      updated.stoppedAt = Date.now();
    }

    // Update cache
    this.inMemoryCache.set(recordingId, updated);

    // Append updated metadata (append-only log)
    await this.appendMetadata(updated);

    return updated;
  }

  async getRecording(recordingId: string): Promise<CallRecordingMetadata | undefined> {
    await this.initialize();

    // Check cache first
    const cached = this.inMemoryCache.get(recordingId);
    if (cached) return cached;

    // Load from file
    try {
      const raw = await fs.readFile(this.metadataPath, "utf8");
      const lines = raw.trim().split("\n");
      
      // Find the last entry for this recordingId (most recent)
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        
        try {
          const record = JSON.parse(line) as CallRecordingMetadata;
          if (record.recordingId === recordingId) {
            this.inMemoryCache.set(recordingId, record);
            return record;
          }
        } catch {
          // Skip invalid lines
          continue;
        }
      }
    } catch {
      // File doesn't exist
    }

    return undefined;
  }

  async getRecordingByCallId(callId: string): Promise<CallRecordingMetadata | undefined> {
    const index = await this.loadIndexRaw();
    const recordingId = index[callId];
    if (!recordingId) return undefined;
    return this.getRecording(recordingId);
  }

  async searchRecordings(
    filters: RecordingSearchFilters,
    options?: { limit?: number; offset?: number }
  ): Promise<{ recordings: CallRecordingMetadata[]; total: number }> {
    await this.initialize();

    const allRecordings = await this.loadAllRecordings();
    
    let filtered = allRecordings.filter((rec) => {
      if (filters.callId && rec.callId !== filters.callId) return false;
      if (filters.provider && rec.provider !== filters.provider) return false;
      if (filters.status && rec.status !== filters.status) return false;
      if (filters.quality && rec.quality !== filters.quality) return false;
      if (filters.startDate && rec.startedAt < filters.startDate.getTime()) return false;
      if (filters.endDate && rec.startedAt > filters.endDate.getTime()) return false;
      if (filters.tags && !filters.tags.every((tag) => rec.tags.includes(tag))) return false;
      if (filters.hasTranscription !== undefined) {
        const hasTranscription = rec.transcriptionStatus === "completed" && !!rec.transcriptionText;
        if (hasTranscription !== filters.hasTranscription) return false;
      }
      return true;
    });

    // Sort by startedAt desc
    filtered.sort((a, b) => b.startedAt - a.startedAt);

    const total = filtered.length;
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    filtered = filtered.slice(offset, offset + limit);

    return { recordings: filtered, total };
  }

  private async loadAllRecordings(): Promise<CallRecordingMetadata[]> {
    const recordings: CallRecordingMetadata[] = [];
    const seenIds = new Set<string>();

    try {
      const raw = await fs.readFile(this.metadataPath, "utf8");
      const lines = raw.trim().split("\n");

      for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
          const record = JSON.parse(line) as CallRecordingMetadata;
          // Only keep the latest version of each recording
          if (!seenIds.has(record.recordingId)) {
            seenIds.add(record.recordingId);
            recordings.push(record);
          }
        } catch {
          // Skip invalid lines
          continue;
        }
      }
    } catch {
      // File doesn't exist
    }

    return recordings;
  }

  async getAnalytics(): Promise<RecordingAnalytics> {
    await this.initialize();

    const recordings = await this.loadAllRecordings();
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    const analytics: RecordingAnalytics = {
      totalRecordings: recordings.length,
      totalDurationMs: 0,
      totalStorageBytes: 0,
      recordingsByStatus: {},
      recordingsByProvider: {},
      recordingsByQuality: {},
      averageDurationMs: 0,
      averageFileSizeBytes: 0,
      transcriptionRate: 0,
      dailyRecordingCounts: {},
      hourlyDistribution: new Array(24).fill(0),
      storageTrend: [],
    };

    let completedWithTranscription = 0;
    let totalFileSize = 0;
    let recordingsWithSize = 0;
    let totalDuration = 0;
    let recordingsWithDuration = 0;

    const dailyCounts: Record<string, number> = {};
    const storageByDate: Record<string, number> = {};

    for (const rec of recordings) {
      // Status counts
      analytics.recordingsByStatus[rec.status] =
        (analytics.recordingsByStatus[rec.status] ?? 0) + 1;

      // Provider counts
      analytics.recordingsByProvider[rec.provider] =
        (analytics.recordingsByProvider[rec.provider] ?? 0) + 1;

      // Quality counts
      analytics.recordingsByQuality[rec.quality] =
        (analytics.recordingsByQuality[rec.quality] ?? 0) + 1;

      // Duration
      if (rec.durationMs) {
        totalDuration += rec.durationMs;
        recordingsWithDuration++;
      }

      // File size
      if (rec.fileSizeBytes) {
        totalFileSize += rec.fileSizeBytes;
        recordingsWithSize++;
        analytics.totalStorageBytes += rec.fileSizeBytes;

        // Track storage trend
        if (rec.startedAt >= thirtyDaysAgo) {
          const date = new Date(rec.startedAt).toISOString().split("T")[0];
          storageByDate[date] = (storageByDate[date] ?? 0) + rec.fileSizeBytes;
        }
      }

      // Transcription tracking
      if (rec.transcriptionStatus === "completed") {
        completedWithTranscription++;
      }

      // Daily counts
      const date = new Date(rec.startedAt).toISOString().split("T")[0];
      dailyCounts[date] = (dailyCounts[date] ?? 0) + 1;

      // Hourly distribution
      const hour = new Date(rec.startedAt).getHours();
      analytics.hourlyDistribution[hour]++;
    }

    analytics.totalDurationMs = totalDuration;
    analytics.averageDurationMs =
      recordingsWithDuration > 0 ? totalDuration / recordingsWithDuration : 0;
    analytics.averageFileSizeBytes =
      recordingsWithSize > 0 ? totalFileSize / recordingsWithSize : 0;
    analytics.transcriptionRate =
      recordings.length > 0 ? completedWithTranscription / recordings.length : 0;
    analytics.dailyRecordingCounts = dailyCounts;

    // Build storage trend (last 30 days)
    const dates = Object.keys(storageByDate).sort();
    analytics.storageTrend = dates.map((date) => ({
      date,
      bytes: storageByDate[date],
    }));

    return analytics;
  }

  async deleteRecording(recordingId: string): Promise<boolean> {
    await this.initialize();

    const recording = await this.getRecording(recordingId);
    if (!recording) return false;

    // Mark as deleted in metadata (soft delete)
    await this.appendMetadata({
      ...recording,
      status: "failed",
      errorMessage: "Deleted by user",
      metadata: { ...recording.metadata, deletedAt: Date.now() },
    });

    // Remove from cache
    this.inMemoryCache.delete(recordingId);

    // Update index
    const index = await this.loadIndexRaw();
    if (index[recording.callId] === recordingId) {
      delete index[recording.callId];
      await this.saveIndex(index);
    }

    // Try to delete actual file if exists
    if (recording.storagePath) {
      try {
        await fs.unlink(recording.storagePath);
      } catch {
        // File may not exist
      }
    }

    return true;
  }

  async exportMetadata(): Promise<string> {
    await this.initialize();

    const recordings = await this.loadAllRecordings();
    return JSON.stringify(recordings, null, 2);
  }

  async cleanupOldMetadata(maxAgeDays: number = MAX_METADATA_RETENTION_DAYS): Promise<number> {
    await this.initialize();

    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const recordings = await this.loadAllRecordings();
    let cleaned = 0;

    for (const rec of recordings) {
      if (rec.startedAt < cutoff && rec.status !== "recording") {
        await this.deleteRecording(rec.recordingId);
        cleaned++;
      }
    }

    return cleaned;
  }
}

export function formatRecordingAnalytics(analytics: RecordingAnalytics): string {
  const lines = [
    "📹 Voice Call Recording Analytics",
    "",
    `🎵 Total Recordings: ${analytics.totalRecordings}`,
    `⏱️ Total Duration: ${formatDuration(analytics.totalDurationMs)}`,
    `💾 Total Storage: ${formatBytes(analytics.totalStorageBytes)}`,
    `📊 Avg Duration: ${formatDuration(analytics.averageDurationMs)}`,
    `📁 Avg File Size: ${formatBytes(analytics.averageFileSizeBytes)}`,
    `📝 Transcription Rate: ${(analytics.transcriptionRate * 100).toFixed(1)}%`,
    "",
    "📈 By Status:",
  ];

  for (const [status, count] of Object.entries(analytics.recordingsByStatus)) {
    const emoji = status === "completed" ? "✅" : status === "recording" ? "🔴" : status === "failed" ? "❌" : "⏸️";
    lines.push(`  ${emoji} ${status}: ${count}`);
  }

  lines.push("", "📈 By Provider:");
  for (const [provider, count] of Object.entries(analytics.recordingsByProvider)) {
    lines.push(`  • ${provider}: ${count}`);
  }

  lines.push("", "📈 By Quality:");
  for (const [quality, count] of Object.entries(analytics.recordingsByQuality)) {
    const emoji = quality === "ultra" ? "🔥" : quality === "high" ? "⭐" : quality === "medium" ? "✓" : "📉";
    lines.push(`  ${emoji} ${quality}: ${count}`);
  }

  lines.push("", "⏰ Hourly Distribution:");
  const maxHourly = Math.max(...analytics.hourlyDistribution, 1);
  for (let i = 0; i < 24; i += 4) {
    const block = analytics.hourlyDistribution.slice(i, i + 4);
    const blockTotal = block.reduce((a, b) => a + b, 0);
    const barLength = Math.round((blockTotal / maxHourly) * 10);
    const bar = "█".repeat(barLength) + "░".repeat(10 - barLength);
    lines.push(`  ${i.toString().padStart(2, "0")}:00-${(i + 4).toString().padStart(2, "0")}:00 ${bar} ${blockTotal}`);
  }

  return lines.join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
