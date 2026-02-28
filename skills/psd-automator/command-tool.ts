export type PsdAutomatorTask = {
  taskId: string;
  requester?: string;
  target?: {
    agentId?: string;
    os?: "mac" | "win";
  };
  input: {
    exactPath?: string;
    fileHint?: string;
    layerName?: string;
    newText?: string;
    edits?: Array<{
      layerName: string;
      newText: string;
    }>;
  };
  workflow?: {
    sourceMode?: "inplace" | "copy_then_edit";
    copyToDir?: string;
  };
  output?: {
    mode?: "overwrite" | "copy";
    path?: string;
    psd?: {
      mode?: "overwrite" | "copy";
      path?: string;
    };
    exports?: Array<{
      format: "png";
      dir?: string;
      fileName?: string;
    }>;
  };
  options?: {
    dryRun?: boolean;
    createBackup?: boolean;
    styleLock?: boolean;
    retryOnLockedFile?: boolean;
    maxRetries?: number;
    pathBridgeMode?: "auto" | "always" | "off";
  };
};

export type PsdAutomatorResult = {
  taskId: string;
  status: "success" | "error" | "dry-run";
  code: string;
  message?: string;
  resolvedPath?: string;
  psdOutputPath?: string;
  pngOutputPath?: string;
  pngOutputPaths?: string[];
  editsApplied?: string[];
  availableLayers?: string[];
  suggestedLayers?: string[];
  suggestion?: string;
  backupPath?: string;
  via?: "exactPath" | "index";
  candidates?: string[];
  durationMs?: number;
  auditLogPath?: string;
};
