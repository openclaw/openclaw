/**
 * Docker File Handler for OpenClaw Feishu Extension
 * 
 * This module provides automatic file handling for Docker environments,
 * detecting inaccessible files and copying them to accessible workspace
 * directories before sending.
 */

import fs from "fs";
import path from "path";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Docker environment detection result
 */
export interface DockerEnvInfo {
  /** Whether running in Docker container */
  isDocker: boolean;
  /** Detected workspace root directories */
  workspaceRoots: string[];
  /** All accessible paths for file operations */
  accessiblePaths: string[];
  /** Environment configuration values */
  envConfig: {
    openclawDocker?: string;
    workspaceRoot?: string;
    extraPaths?: string[];
  };
}

/**
 * File accessibility check result
 */
export interface FileAccessibilityResult {
  /** Whether the file is accessible */
  isAccessible: boolean;
  /** Reason for accessibility status */
  reason?: 'accessible' | 'outside-workspace' | 'not-found' | 'permission-denied';
  /** The accessible root directory if accessible */
  accessibleRoot?: string;
  /** Suggested action to handle the file */
  suggestedAction: 'direct-read' | 'copy-to-temp' | 'error';
}

/**
 * Temporary file information
 */
export interface TempFileInfo {
  /** Original file path */
  originalPath: string;
  /** Temporary file path */
  tempPath: string;
  /** Whether the temp file should be cleaned up */
  shouldCleanup: boolean;
  /** When the temp file was created */
  createdAt: Date;
}

/**
 * Docker file handling configuration
 */
export interface DockerFileConfig {
  /** Auto-detect Docker environment (default: true) */
  autoDetect?: boolean;
  /** Auto-copy inaccessible files (default: true) */
  autoCopy?: boolean;
  /** Cleanup temp files after send (default: true) */
  cleanupTempFiles?: boolean;
  /** Custom accessible root directories */
  customRoots?: string[];
}

// ============================================================================
// Docker Environment Detection
// ============================================================================

/**
 * Detect Docker environment and accessible paths
 * @returns Docker environment information
 */
export function detectDockerEnvironment(): DockerEnvInfo {
  const info: DockerEnvInfo = {
    isDocker: false,
    workspaceRoots: [],
    accessiblePaths: [],
    envConfig: {},
  };

  // Check if running in Docker
  info.isDocker = fs.existsSync('/.dockerenv') || 
    process.env.OPENCLAW_DOCKER === 'true' ||
    process.env.DOCKER_CONTAINER === 'true';

  if (!info.isDocker) {
    return info;
  }

  // Parse environment configuration
  info.envConfig.openclawDocker = process.env.OPENCLAW_DOCKER;
  info.envConfig.workspaceRoot = process.env.OPENCLAW_WORKSPACE_ROOT;
  
  if (process.env.OPENCLAW_EXTRA_PATHS) {
    info.envConfig.extraPaths = process.env.OPENCLAW_EXTRA_PATHS.split(':').filter(Boolean);
  }

  // Detect workspace roots
  info.workspaceRoots = detectWorkspaceRoots(info.envConfig);
  
  // Build accessible paths list
  info.accessiblePaths = [
    ...info.workspaceRoots,
    ...(info.envConfig.extraPaths || []),
    '/tmp', // Common temp directory
  ];

  return info;
}

/**
 * Detect all accessible workspace roots
 * @param envConfig Environment configuration
 * @returns Array of workspace root paths
 */
function detectWorkspaceRoots(
  envConfig: DockerEnvInfo['envConfig']
): string[] {
  const roots: string[] = [];

  // Priority 1: Environment variable override
  if (envConfig.workspaceRoot) {
    const root = path.resolve(envConfig.workspaceRoot);
    if (fs.existsSync(root)) {
      roots.push(root);
    }
  }

  // Priority 2: Detect from process.cwd()
  const cwd = process.cwd();
  if (cwd.includes('workspace')) {
    const match = cwd.match(/(.+?workspace[^\/]*)/);
    if (match) {
      const root = match[1];
      if (fs.existsSync(root) && !roots.includes(root)) {
        roots.push(root);
      }
    }
  }

  // Priority 3: Scan common locations
  const homeDir = process.env.HOME || '/home/node';
  const commonPaths = [
    path.join(homeDir, '.openclaw', 'workspace'),
    '/workspace',
    '/app/workspace',
    '/home/node/.openclaw/workspace',
  ];

  for (const testPath of commonPaths) {
    if (fs.existsSync(testPath) && !roots.includes(testPath)) {
      roots.push(testPath);
    }
  }

  // Priority 4: Pattern match for workspace-* directories
  try {
    const openclawDir = path.join(homeDir, '.openclaw');
    if (fs.existsSync(openclawDir)) {
      const entries = fs.readdirSync(openclawDir);
      for (const entry of entries) {
        if (entry.startsWith('workspace')) {
          const fullPath = path.join(openclawDir, entry);
          if (fs.statSync(fullPath).isDirectory() && !roots.includes(fullPath)) {
            roots.push(fullPath);
          }
        }
      }
    }
  } catch {
    // Ignore errors during scanning
  }

  return roots;
}

// ============================================================================
// File Accessibility Functions
// ============================================================================

/**
 * Check if a file is accessible from Docker environment
 * @param filePath Path to the file to check
 * @param accessiblePaths List of accessible paths
 * @returns File accessibility result
 */
export function checkFileAccessibility(
  filePath: string,
  accessiblePaths: string[]
): FileAccessibilityResult {
  const normalizedPath = path.resolve(filePath);

  // Check if file exists
  if (!fs.existsSync(normalizedPath)) {
    return {
      isAccessible: false,
      reason: 'not-found',
      suggestedAction: 'error',
    };
  }

  // Check if file is within accessible paths
  for (const accessibleRoot of accessiblePaths) {
    const normalizedRoot = path.resolve(accessibleRoot);
    if (normalizedPath.startsWith(normalizedRoot + path.sep) ||
        normalizedPath === normalizedRoot) {
      return {
        isAccessible: true,
        reason: 'accessible',
        accessibleRoot: normalizedRoot,
        suggestedAction: 'direct-read',
      };
    }
  }

  // File exists but is outside accessible paths
  return {
    isAccessible: false,
    reason: 'outside-workspace',
    suggestedAction: 'copy-to-temp',
  };
}

// ============================================================================
// Temp File Management
// ============================================================================

/**
 * Copy file to accessible temp location
 * @param sourcePath Original file path
 * @param accessibleRoot Root directory for temp storage
 * @returns Temp file information
 */
export async function copyToAccessibleTemp(
  sourcePath: string,
  accessibleRoot: string
): Promise<TempFileInfo> {
  const fileName = path.basename(sourcePath);
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const tempFileName = `${timestamp}-${randomSuffix}-${fileName}`;
  const tempPath = path.join(accessibleRoot, '.temp', tempFileName);

  // Ensure .temp directory exists
  const tempDir = path.dirname(tempPath);
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Copy file
  await fs.promises.copyFile(sourcePath, tempPath);

  return {
    originalPath: sourcePath,
    tempPath,
    shouldCleanup: true,
    createdAt: new Date(),
  };
}

/**
 * Cleanup temp file
 * @param tempInfo Temp file information
 */
export async function cleanupTempFile(tempInfo: TempFileInfo): Promise<void> {
  if (!tempInfo.shouldCleanup) {
    return;
  }

  try {
    if (fs.existsSync(tempInfo.tempPath)) {
      await fs.promises.unlink(tempInfo.tempPath);
    }

    // Try to cleanup empty .temp directories
    const tempDir = path.dirname(tempInfo.tempPath);
    try {
      const entries = await fs.promises.readdir(tempDir);
      if (entries.length === 0) {
        await fs.promises.rmdir(tempDir);
      }
    } catch {
      // Ignore cleanup errors for directories
    }
  } catch (error) {
    // Log but don't throw - cleanup is best effort
    console.warn(`Failed to cleanup temp file ${tempInfo.tempPath}:`, error);
  }
}

// ============================================================================
// Convenience Function
// ============================================================================

/**
 * Handle file for Docker environment - main entry point
 * This function automatically handles file accessibility in Docker environments
 * @param filePath Path to the file to handle
 * @param config Docker file handling configuration
 * @returns Object with file data (ReadStream) and cleanup function
 */
export async function handleDockerFile(
  filePath: string,
  config: DockerFileConfig = {}
): Promise<{
  fileData: fs.ReadStream;
  cleanup: () => Promise<void>;
}> {
  const shouldAutoDetect = config.autoDetect !== false;
  
  if (!shouldAutoDetect) {
    // Auto-detection disabled, use file directly
    return {
      fileData: fs.createReadStream(filePath),
      cleanup: async () => {}, // No cleanup needed
    };
  }

  const dockerInfo = detectDockerEnvironment();
  
  if (!dockerInfo.isDocker || dockerInfo.accessiblePaths.length === 0) {
    // Not in Docker or no accessible paths, use file directly
    return {
      fileData: fs.createReadStream(filePath),
      cleanup: async () => {},
    };
  }

  // Check file accessibility
  const accessibility = checkFileAccessibility(filePath, dockerInfo.accessiblePaths);
  
  if (accessibility.isAccessible) {
    // File is accessible, use directly
    return {
      fileData: fs.createReadStream(filePath),
      cleanup: async () => {},
    };
  }

  // File is not accessible, need to copy
  if (accessibility.suggestedAction === 'copy-to-temp' && config.autoCopy !== false) {
    // Determine best accessible root
    const bestRoot = config.customRoots?.[0] || 
                    dockerInfo.workspaceRoots[0] || 
                    dockerInfo.accessiblePaths[0];
    
    if (bestRoot) {
      try {
        const tempInfo = await copyToAccessibleTemp(filePath, bestRoot);
        
        const shouldCleanup = config.cleanupTempFiles !== false;
        
        // Create a read stream from the temp file
        const fileData = fs.createReadStream(tempInfo.tempPath);
        
        // Bind cleanup to stream close event to avoid race condition
        if (shouldCleanup) {
          fileData.on('close', async () => {
            await cleanupTempFile(tempInfo);
          });
        }
        
        return {
          fileData,
          cleanup: async () => {
            // Cleanup is now handled by stream close event
            // This function is kept for backward compatibility
          },
        };
      } catch (copyError) {
        // Copy failed, fallback to original path
        console.warn(`Failed to copy file to accessible location: ${copyError}`);
        return {
          fileData: fs.createReadStream(filePath),
          cleanup: async () => {},
        };
      }
    }
  }

  // Fallback: use original file
  return {
    fileData: fs.createReadStream(filePath),
    cleanup: async () => {},
  };
}
