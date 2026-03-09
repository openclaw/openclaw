import * as fs from 'node:fs';
import * as path from 'node:path';

const LOG_DIR = path.join(process.env.HOME || '/home/ada', 'voice-call-logs');

export interface ConversationEntry {
  timestamp: string;
  role: 'user' | 'assistant';
  text: string;
}

export class SessionLogger {
  private sessionId: string;
  private roomName: string;
  private startedAt: Date;
  readonly entries: ConversationEntry[] = [];
  private logPath: string;

  constructor(roomName: string) {
    this.roomName = roomName;
    this.startedAt = new Date();
    this.sessionId = `${this.startedAt.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}_${roomName}`;

    fs.mkdirSync(LOG_DIR, { recursive: true });
    this.logPath = path.join(LOG_DIR, `${this.sessionId}.txt`);

    // Write header
    const header = [
      '═══════════════════════════════════════════════════',
      '  Ada Voice Call — Session Log',
      '═══════════════════════════════════════════════════',
      `  Session ID : ${this.sessionId}`,
      `  Room       : ${roomName}`,
      `  Started    : ${this.startedAt.toISOString()}`,
      '═══════════════════════════════════════════════════',
      '',
    ].join('\n');

    fs.writeFileSync(this.logPath, header, 'utf8');
    console.log(`[SessionLogger] Logging to: ${this.logPath}`);
  }

  log(role: 'user' | 'assistant', text: string) {
    if (!text?.trim()) return;

    const entry: ConversationEntry = {
      timestamp: new Date().toISOString(),
      role,
      text: text.trim(),
    };
    this.entries.push(entry);

    const label = role === 'user' ? '👤 CALLER' : '🤖 ADA   ';
    const timeStr = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
    const line = `[${timeStr}] ${label}: ${entry.text}\n`;

    fs.appendFileSync(this.logPath, line, 'utf8');
  }

  close() {
    const endedAt = new Date();
    const durationSec = Math.round((endedAt.getTime() - this.startedAt.getTime()) / 1000);
    const mins = Math.floor(durationSec / 60);
    const secs = durationSec % 60;

    const footer = [
      '',
      '═══════════════════════════════════════════════════',
      `  Ended      : ${endedAt.toISOString()}`,
      `  Duration   : ${mins}m ${secs}s`,
      `  Turns      : ${this.entries.length}`,
      '═══════════════════════════════════════════════════',
      '',
    ].join('\n');

    fs.appendFileSync(this.logPath, footer, 'utf8');
    console.log(`[SessionLogger] Session closed. ${this.entries.length} turns, ${mins}m ${secs}s. Log: ${this.logPath}`);
  }
}
