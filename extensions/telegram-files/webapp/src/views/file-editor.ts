import type { FilesApiClient } from "../services/files-api.js";
import type { TelegramWebApp } from "../services/telegram.js";
import { errorMessage } from "../utils.js";

/** Render the file editor view. */
export function renderFileEditor(params: {
  container: HTMLElement;
  client: FilesApiClient;
  filePath: string;
  webapp: TelegramWebApp;
  onBack: () => void;
}): void {
  const { container, client, filePath, webapp, onBack } = params;
  container.replaceChildren();

  const editorContainer = document.createElement("div");
  editorContainer.className = "editor-container";

  const header = document.createElement("div");
  header.className = "editor-header";

  const fileNameEl = document.createElement("span");
  fileNameEl.className = "editor-filename";
  // Show just the filename, full path in subtitle
  const parts = filePath.split("/");
  fileNameEl.textContent = parts[parts.length - 1] || filePath;

  const statusEl = document.createElement("span");
  statusEl.className = "editor-status";
  statusEl.textContent = "Loading...";

  header.appendChild(fileNameEl);
  header.appendChild(statusEl);

  const pathEl = document.createElement("div");
  pathEl.className = "file-meta";
  pathEl.style.padding = "0 0 8px";
  pathEl.textContent = filePath;

  const textarea = document.createElement("textarea");
  textarea.className = "editor-textarea";
  textarea.placeholder = "Loading...";
  textarea.disabled = true;
  textarea.spellcheck = false;

  editorContainer.appendChild(header);
  editorContainer.appendChild(pathEl);
  editorContainer.appendChild(textarea);
  container.appendChild(editorContainer);

  let originalContent = "";
  let dirty = false;
  let isBinary = false;
  let isNewFile = false;
  let saving = false;

  textarea.addEventListener("input", () => {
    if (isBinary) return;
    const isDirty = textarea.value !== originalContent;
    if (isDirty !== dirty) {
      dirty = isDirty;
      statusEl.textContent = dirty ? "Modified" : isNewFile ? "New file" : "Saved";
      if (dirty) {
        webapp.MainButton.setText("Save");
        webapp.MainButton.show();
      } else {
        webapp.MainButton.hide();
      }
    }
  });

  // Back button
  webapp.BackButton.show();
  const handleBack = () => {
    if (dirty && !confirm("You have unsaved changes. Discard?")) return;
    cleanup();
    onBack();
  };
  webapp.BackButton.onClick(handleBack);

  // Save
  const handleSave = async () => {
    if (isBinary || saving) return;
    saving = true;
    webapp.MainButton.showProgress(true);
    webapp.MainButton.disable();
    statusEl.textContent = "Saving...";

    try {
      await client.write(filePath, textarea.value);
      originalContent = textarea.value;
      dirty = false;
      isNewFile = false;
      statusEl.textContent = "Saved";
      webapp.MainButton.hide();
    } catch (err) {
      statusEl.textContent = `Error: ${errorMessage(err)}`;
    } finally {
      saving = false;
      webapp.MainButton.hideProgress();
      webapp.MainButton.enable();
    }
  };
  webapp.MainButton.onClick(handleSave);

  function cleanup() {
    webapp.BackButton.hide();
    webapp.BackButton.offClick(handleBack);
    webapp.MainButton.hide();
    webapp.MainButton.offClick(handleSave);
  }

  loadContent();

  async function loadContent() {
    try {
      const result = await client.read(filePath);
      originalContent = result.content;
      textarea.value = result.content;
      textarea.disabled = false;
      statusEl.textContent = "Ready";
    } catch (err) {
      const msg = errorMessage(err);

      // Binary file detection
      if (msg.includes("binary file")) {
        isBinary = true;
        textarea.style.display = "none";
        statusEl.textContent = "";

        const notice = document.createElement("div");
        notice.className = "binary-notice";

        const iconEl = document.createElement("div");
        iconEl.className = "binary-icon";
        iconEl.textContent = "\u{1F512}";

        const titleEl = document.createElement("div");
        titleEl.className = "binary-title";
        titleEl.textContent = "Binary File";

        const descEl = document.createElement("div");
        descEl.className = "binary-desc";
        descEl.textContent = "This file cannot be edited as text.";

        notice.appendChild(iconEl);
        notice.appendChild(titleEl);
        notice.appendChild(descEl);
        editorContainer.appendChild(notice);
        return;
      }

      // New file (doesn't exist yet) — allow editing empty content
      if (msg.includes("ENOENT") || msg.includes("no such file")) {
        isNewFile = true;
        originalContent = "";
        textarea.value = "";
        textarea.disabled = false;
        textarea.placeholder = "Start typing...";
        statusEl.textContent = "New file";
        // Show save button immediately for new files
        webapp.MainButton.setText("Save");
        webapp.MainButton.show();
        dirty = true;
        return;
      }

      statusEl.textContent = `Error: ${msg}`;
      textarea.placeholder = "Failed to load file.";
    }
  }
}
