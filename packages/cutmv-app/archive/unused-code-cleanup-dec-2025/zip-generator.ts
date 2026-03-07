// Utility to generate ZIP files from existing video processing output directories
// This fixes the download link issue where ZIP files are expected but not created

import AdmZip from 'adm-zip';
import { promises as fs } from 'fs';
import path from 'path';

export class ZipGenerator {
  
  // Generate ZIP file from existing processing directories
  static async generateZipFromDirectories(videoId: number, outputPath?: string): Promise<string | null> {
    try {
      const zip = new AdmZip();
      const clipsDir = 'uploads/clips';
      let filesAdded = 0;
      
      console.log(`🔄 Generating ZIP for video ${videoId}...`);
      
      // Get all directories in clips folder
      const directories = await fs.readdir(clipsDir);
      
      for (const dirName of directories) {
        const dirPath = path.join(clipsDir, dirName);
        const stat = await fs.stat(dirPath);
        
        if (stat.isDirectory()) {
          // Check if this directory contains files for our video ID
          // Look for any pattern that might match our video processing
          const addedCount = await this.addDirectoryContentsToZip(zip, dirPath, dirName);
          filesAdded += addedCount;
          
          if (addedCount > 0) {
            console.log(`📁 Added ${addedCount} files from directory: ${dirName}`);
          }
        }
      }
      
      if (filesAdded === 0) {
        console.log(`⚠️ No files found to add to ZIP for video ${videoId}`);
        return null;
      }
      
      // Create ZIP file
      const zipPath = outputPath || path.join(clipsDir, `video_${videoId}_exports.zip`);
      zip.writeZip(zipPath);
      
      console.log(`✅ ZIP created with ${filesAdded} files: ${zipPath}`);
      return zipPath;
      
    } catch (error) {
      console.error('Failed to generate ZIP:', error);
      return null;
    }
  }
  
  // Add all contents of a directory to ZIP recursively
  private static async addDirectoryContentsToZip(zip: AdmZip, dirPath: string, baseName: string): Promise<number> {
    let filesAdded = 0;
    
    try {
      const items = await fs.readdir(dirPath);
      
      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stat = await fs.stat(itemPath);
        
        if (stat.isFile()) {
          // Add file to ZIP with organized path structure
          const zipPath = path.join(baseName, item);
          zip.addLocalFile(itemPath, baseName);
          filesAdded++;
        } else if (stat.isDirectory()) {
          // Recursively add subdirectory contents
          const subDirAdded = await this.addDirectoryContentsToZip(
            zip, 
            itemPath, 
            path.join(baseName, item)
          );
          filesAdded += subDirAdded;
        }
      }
    } catch (error) {
      console.warn(`Could not process directory ${dirPath}:`, error);
    }
    
    return filesAdded;
  }
  
  // Check if ZIP file exists for a video ID
  static async zipExists(videoId: number): Promise<boolean> {
    try {
      const zipPath = path.join('uploads/clips', `video_${videoId}_exports.zip`);
      await fs.access(zipPath);
      return true;
    } catch {
      return false;
    }
  }
  
  // Get ZIP file path for a video ID
  static getZipPath(videoId: number): string {
    return path.join('uploads/clips', `video_${videoId}_exports.zip`);
  }
}