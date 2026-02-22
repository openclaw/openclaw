import { FilesApiClient } from "./services/files-api.js";
import { getTelegramWebApp } from "./services/telegram.js";
import { renderFileEditor } from "./views/file-editor.js";
import { loadAndRenderFileList } from "./views/file-list.js";

export function mountApp(container: HTMLElement, client: FilesApiClient): void {
  const webapp = getTelegramWebApp();
  let currentPath = "/";
  let homeDir = "/";
  let currentBackHandler: (() => void) | null = null;

  // Check URL for a start path (from /files /some/path)
  const urlParams = new URLSearchParams(window.location.search);
  const startPath = urlParams.get("path");

  // Ask the server for the default start directory
  client
    .home()
    .then((result) => {
      homeDir = result.path;
      showDir(startPath || result.path);
    })
    .catch(() => showDir(startPath || "/"));

  function showDir(dirPath: string) {
    currentPath = dirPath;

    // Clean up previous back handler to prevent handler accumulation
    if (currentBackHandler) {
      webapp.BackButton.offClick(currentBackHandler);
      currentBackHandler = null;
    }
    webapp.BackButton.hide();
    webapp.MainButton.hide();

    // Show back button only if we're deeper than the home directory
    if (dirPath !== "/" && dirPath !== homeDir) {
      webapp.BackButton.show();
      const handleBack = () => {
        webapp.BackButton.offClick(handleBack);
        currentBackHandler = null;
        // Normalize trailing slashes before computing parent
        const normalized = dirPath.replace(/\/+$/, "");
        const parent = normalized.substring(0, normalized.lastIndexOf("/")) || "/";
        showDir(parent);
      };
      currentBackHandler = handleBack;
      webapp.BackButton.onClick(handleBack);
    }

    loadAndRenderFileList({
      container,
      client,
      dirPath,
      homeDir,
      onNavigate: (path) => showDir(path),
      onFileOpen: (path) => showEditor(path),
    });
  }

  function showEditor(filePath: string) {
    // Clean up back handler before entering editor
    if (currentBackHandler) {
      webapp.BackButton.offClick(currentBackHandler);
      currentBackHandler = null;
    }
    renderFileEditor({
      container,
      client,
      filePath,
      webapp,
      onBack: () => showDir(currentPath),
    });
  }
}
