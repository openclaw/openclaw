#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const iosRoot = path.join(repoRoot, "apps", "ios");
const outputPath = path.join(iosRoot, "SwiftSources.input.xcfilelist");

const iosSourceRoots = [
  "Sources",
  "ShareExtension",
  "ActivityWidget",
  path.join("WatchApp", "Sources"),
];

const sharedSwiftFiles = [
  "../shared/OpenClawKit/Sources/OpenClawChatUI/ChatComposer.swift",
  "../shared/OpenClawKit/Sources/OpenClawChatUI/ChatMarkdownPreprocessor.swift",
  "../shared/OpenClawKit/Sources/OpenClawChatUI/ChatMarkdownRenderer.swift",
  "../shared/OpenClawKit/Sources/OpenClawChatUI/ChatMessageViews.swift",
  "../shared/OpenClawKit/Sources/OpenClawChatUI/ChatModels.swift",
  "../shared/OpenClawKit/Sources/OpenClawChatUI/ChatPayloadDecoding.swift",
  "../shared/OpenClawKit/Sources/OpenClawChatUI/ChatSessions.swift",
  "../shared/OpenClawKit/Sources/OpenClawChatUI/ChatSheets.swift",
  "../shared/OpenClawKit/Sources/OpenClawChatUI/ChatTheme.swift",
  "../shared/OpenClawKit/Sources/OpenClawChatUI/ChatTransport.swift",
  "../shared/OpenClawKit/Sources/OpenClawChatUI/ChatView.swift",
  "../shared/OpenClawKit/Sources/OpenClawChatUI/ChatViewModel+Attachments.swift",
  "../shared/OpenClawKit/Sources/OpenClawChatUI/ChatViewModel+SessionKeys.swift",
  "../shared/OpenClawKit/Sources/OpenClawChatUI/ChatViewModel.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/AnyCodable.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/BonjourEscapes.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/BonjourTypes.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/BridgeFrames.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/CameraCommands.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/CanvasA2UIAction.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/CanvasA2UICommands.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/CanvasA2UIJSONL.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/CanvasCommandParams.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/CanvasCommands.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/Capabilities.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/DeepLinks.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/JPEGTranscoder.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/NodeError.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/OpenClawKitResources.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/ScreenCommands.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/StoragePaths.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/SystemCommands.swift",
  "../shared/OpenClawKit/Sources/OpenClawKit/TalkDirective.swift",
  "../swabble/Sources/SwabbleKit/WakeWordGate.swift",
];

function normalizeFileListPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function collectSwiftFiles(rootRelativePath) {
  const root = path.join(iosRoot, rootRelativePath);
  if (!existsSync(root)) {
    throw new Error(`Missing iOS Swift source root: ${rootRelativePath}`);
  }

  const entries = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".swift")) {
        entries.push(normalizeFileListPath(path.relative(iosRoot, fullPath)));
      }
    }
  };
  visit(root);
  return entries;
}

function assertSharedFilesExist(filePaths) {
  for (const filePath of filePaths) {
    const absolutePath = path.resolve(iosRoot, filePath);
    if (!existsSync(absolutePath)) {
      throw new Error(`Missing shared Swift file listed for iOS lint: ${filePath}`);
    }
  }
}

function writeGeneratedFile(filePath, contents) {
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symlinked file: ${filePath}`);
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
}

assertSharedFilesExist(sharedSwiftFiles);

const iosFiles = iosSourceRoots.flatMap(collectSwiftFiles);
const fileList = [...new Set([...iosFiles, ...sharedSwiftFiles])].toSorted((left, right) =>
  left.localeCompare(right),
);

writeGeneratedFile(outputPath, `${fileList.join("\n")}\n`);
process.stdout.write(`Prepared iOS Swift file list: ${path.relative(repoRoot, outputPath)}\n`);
