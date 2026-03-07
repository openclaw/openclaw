export interface ParsedTimestamp {
  startTime: string;
  endTime: string;
  duration: number;
  valid: boolean;
  error?: string;
}

export interface ParseResult {
  timestamps: ParsedTimestamp[];
  errors: string[];
  warnings: string[];
}

export function parseTimestampText(text: string, videoDuration?: string): ParseResult {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line);
  const timestamps: ParsedTimestamp[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  
  const videoDurationSeconds = videoDuration ? timestampToSeconds(videoDuration) : null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    
    try {
      const parsed = parseTimestampLine(line);
      
      if (!parsed) {
        errors.push(`Line ${lineNumber}: Invalid format "${line}"`);
        continue;
      }
      
      const startSeconds = timestampToSeconds(parsed.startTime);
      const endSeconds = timestampToSeconds(parsed.endTime);
      
      // Validate start < end
      if (startSeconds >= endSeconds) {
        errors.push(`Line ${lineNumber}: Start time must be before end time`);
        continue;
      }
      
      // Validate against video duration
      if (videoDurationSeconds && endSeconds > videoDurationSeconds) {
        errors.push(`Line ${lineNumber}: End time exceeds video duration`);
        continue;
      }
      
      const duration = endSeconds - startSeconds;
      
      // Check for overlaps with previous valid timestamps
      for (let j = 0; j < timestamps.length; j++) {
        const prevTimestamp = timestamps[j];
        const prevStartSeconds = timestampToSeconds(prevTimestamp.startTime);
        const prevEndSeconds = timestampToSeconds(prevTimestamp.endTime);
        
        if (startSeconds < prevEndSeconds && endSeconds > prevStartSeconds) {
          warnings.push(`Line ${lineNumber} overlaps with line ${j + 1}`);
        }
      }
      
      timestamps.push({
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        duration,
        valid: true,
      });
      
    } catch (error) {
      errors.push(`Line ${lineNumber}: ${(error as Error).message}`);
    }
  }
  
  return { timestamps, errors, warnings };
}

function parseTimestampLine(line: string): { startTime: string; endTime: string } | null {
  // Support various separators: dash, en-dash, comma, space
  const rangeSeparators = /[-–,\s]+/;
  const parts = line.split(rangeSeparators).filter(part => part.trim());
  
  if (parts.length < 2) {
    return null;
  }
  
  const startTime = normalizeTimestamp(parts[0].trim());
  const endTime = normalizeTimestamp(parts[1].trim());
  
  if (!startTime || !endTime) {
    return null;
  }
  
  return { startTime, endTime };
}

function normalizeTimestamp(timestamp: string): string | null {
  // Remove any extra whitespace
  timestamp = timestamp.trim();
  
  // Support various time separators: colon, semicolon, period
  const timeSeparators = /[;.]/g;
  timestamp = timestamp.replace(timeSeparators, ':');
  
  // Validate format and normalize
  const timePattern = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
  const match = timestamp.match(timePattern);
  
  if (match) {
    const [, minutes, seconds, hours] = match;
    
    // Validate minutes and seconds
    const mins = parseInt(minutes);
    const secs = parseInt(seconds);
    const hrs = hours ? parseInt(hours) : 0;
    
    if (secs >= 60 || mins >= 60) {
      return null;
    }
    
    if (hours) {
      // Format: H:MM:SS or HH:MM:SS
      return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      // Format: M:SS or MM:SS - assume no hours
      return `00:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
  }
  
  return null;
}

export function timestampToSeconds(timestamp: string): number {
  const parts = timestamp.split(':').map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}

export function secondsToTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}
