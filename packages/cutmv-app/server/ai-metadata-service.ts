// AI-Powered Metadata Suggestion Service
// Uses OpenAI to analyze video file metadata and suggest meaningful titles and artist info

import OpenAI from "openai";
import path from 'path';

interface MetadataSuggestion {
  videoTitle: string;
  artistInfo: string;
  confidence: number;
}

interface VideoFileInfo {
  originalName: string;
  size: number;
  duration?: number;
  format?: string;
}

class AIMetadataService {
  private openai: OpenAI | null = null;

  constructor() {
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ 
        apiKey: process.env.OPENAI_API_KEY 
      });
      console.log('🤖 AI Metadata Service initialized with OpenAI');
    } else {
      console.log('⚠️ OpenAI API key not found - AI metadata suggestions disabled');
    }
  }

  // Check if filename contains hints of artist names or video/song titles
  private shouldTriggerAISuggestions(filename: string): boolean {
    const cleanFilename = filename.toLowerCase();
    
    // Common patterns that indicate artist/song content
    const artistPatterns = [
      /[-_\s]+(ft|feat|featuring)[-_\s]+/,  // featuring patterns
      /[-_\s]+(vs|x|and|&)[-_\s]+/,         // collaboration patterns  
      /[-_\s]+(remix|cover|acoustic|live)[-_\s]+/, // version patterns
      /[-_\s]+(official|music|video|mv)[-_\s]+/,   // official content patterns
      /\b(artist|singer|band|musician)\b/,         // artist-related terms
      /[-_\s]+(song|track|single|album)[-_\s]+/,   // music-related terms
    ];
    
    // Check for common music industry naming patterns
    const hasArtistPattern = artistPatterns.some(pattern => pattern.test(cleanFilename));
    
    // Check for separators that often indicate artist - song format
    const hasSeparators = /[-_]\s*[a-z]/i.test(cleanFilename) && cleanFilename.length > 10;
    
    // Check for multiple words (likely not just random file names)
    const wordCount = cleanFilename.split(/[-_\s]+/).filter(word => word.length > 2).length;
    const hasMultipleWords = wordCount >= 2;
    
    // Avoid generic filenames
    const isGeneric = /^(video|clip|movie|file|document|untitled|new|recording)[\d\s]*$/i.test(cleanFilename);
    
    const shouldTrigger = (hasArtistPattern || (hasSeparators && hasMultipleWords)) && !isGeneric;
    
    console.log(`🔍 Filename analysis for "${filename}":`, {
      hasArtistPattern,
      hasSeparators,
      hasMultipleWords,
      isGeneric,
      shouldTrigger,
      wordCount
    });
    
    return shouldTrigger;
  }

  async suggestMetadata(fileInfo: VideoFileInfo): Promise<MetadataSuggestion | null> {
    if (!this.openai) {
      console.log('⚠️ AI metadata service not available - no OpenAI API key');
      return null;
    }

    try {
      // Extract filename without extension for analysis
      const filename = path.parse(fileInfo.originalName).name;
      
      console.log(`🔍 Analyzing filename for AI suggestions: "${filename}"`);
      
      // Only trigger AI suggestions if filename contains hints of artist/song content
      if (!this.shouldTriggerAISuggestions(filename)) {
        console.log(`📝 Skipping AI suggestions for generic filename: ${filename}`);
        return null;
      }
      
      console.log(`🤖 Triggering AI suggestions for: ${filename}`);
      
      // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `You are an AI assistant that analyzes video filenames to suggest meaningful metadata for music videos. 
            
            Analyze the filename and suggest:
            1. A clean, professional video title (remove file extensions, underscores, timestamps, etc.)
            2. Artist/song information if detectable from the filename
            3. A confidence score (0-1) for how certain you are about the suggestions
            
            Return JSON in this exact format: { "videoTitle": "Clean Title", "artistInfo": "Artist - Song", "confidence": 0.8 }
            
            Guidelines:
            - If filename contains artist and song, separate them with " - "
            - Clean up common filename patterns (timestamps, file numbers, etc.)
            - If no clear artist/song is detectable, use generic descriptions
            - Be conservative with confidence scores
            - Make titles readable and professional`
          },
          {
            role: "user",
            content: `Analyze this video filename and suggest metadata:
            
            Filename: ${filename}
            File size: ${(fileInfo.size / 1024 / 1024).toFixed(1)} MB
            Duration: ${fileInfo.duration ? `${fileInfo.duration}s` : 'unknown'}
            Format: ${fileInfo.format || 'unknown'}
            
            Please suggest clean video title and artist information based on this filename.`
          }
        ],
        response_format: { type: "json_object" },
        max_tokens: 200,
        temperature: 0.3
      });

      const content = response.choices[0].message.content;
      if (!content) {
        throw new Error('No response content from OpenAI');
      }

      const suggestion = JSON.parse(content) as MetadataSuggestion;
      
      // Validate the response structure
      if (!suggestion.videoTitle || !suggestion.artistInfo || typeof suggestion.confidence !== 'number') {
        throw new Error('Invalid response structure from OpenAI');
      }

      // Ensure confidence is between 0 and 1
      suggestion.confidence = Math.max(0, Math.min(1, suggestion.confidence));

      console.log(`✅ AI metadata suggestion generated for "${filename}":`, {
        videoTitle: suggestion.videoTitle,
        artistInfo: suggestion.artistInfo,
        confidence: suggestion.confidence
      });

      return suggestion;

    } catch (error) {
      console.error('❌ Failed to generate AI metadata suggestions:', error);
      console.error('Error details:', {
        message: error instanceof Error ? error.message : 'Unknown error',
        filename: fileInfo.originalName,
        hasOpenAI: !!this.openai
      });
      return null;
    }
  }

  // Generate fallback suggestions when AI is not available
  generateFallbackSuggestion(fileInfo: VideoFileInfo): MetadataSuggestion {
    const filename = path.parse(fileInfo.originalName).name;
    
    // Basic cleanup of filename
    let cleanTitle = filename
      .replace(/[_-]/g, ' ')
      .replace(/\d{4}-\d{2}-\d{2}/g, '') // Remove dates
      .replace(/\d{2}:\d{2}:\d{2}/g, '') // Remove timestamps
      .replace(/\s+/g, ' ')
      .trim();

    // Capitalize first letter of each word
    cleanTitle = cleanTitle.replace(/\b\w/g, l => l.toUpperCase());

    return {
      videoTitle: cleanTitle || 'Music Video',
      artistInfo: 'Unknown Artist',
      confidence: 0.3
    };
  }

  isAvailable(): boolean {
    return this.openai !== null;
  }
}

export const aiMetadataService = new AIMetadataService();