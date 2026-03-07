import { submitPrompt, type PromptBarConfig } from "../api";

export function createPromptBar(config: PromptBarConfig): HTMLElement {
  const container = document.createElement("div");
  container.className = "prompt-bar-container";

  container.innerHTML = `
    <div class="prompt-bar">
      <input
        type="text"
        class="prompt-input"
        placeholder="${config.placeholder}"
        aria-label="Ask OpenClaw anything"
      />
      <button class="prompt-submit" aria-label="Submit prompt">&#8594;</button>
    </div>
    <div class="prompt-suggestions" style="display:none"></div>
    <div class="prompt-result" style="display:none"></div>
  `;

  const input = container.querySelector<HTMLInputElement>(".prompt-input")!;
  const submitBtn = container.querySelector<HTMLButtonElement>(".prompt-submit")!;
  const suggestionsEl = container.querySelector<HTMLElement>(".prompt-suggestions")!;
  const resultEl = container.querySelector<HTMLElement>(".prompt-result")!;

  // Build suggestions dropdown
  const suggestionsHtml = config.suggestions
    .map((s) => `<button class="suggestion-item" type="button">${s}</button>`)
    .join("");
  suggestionsEl.innerHTML = suggestionsHtml;

  // Show suggestions on focus
  input.addEventListener("focus", () => {
    if (input.value.trim() === "") {
      suggestionsEl.style.display = "block";
    }
  });

  // Hide suggestions on blur (with delay for click handling)
  input.addEventListener("blur", () => {
    setTimeout(() => {
      suggestionsEl.style.display = "none";
    }, 200);
  });

  // Hide suggestions on typing
  input.addEventListener("input", () => {
    if (input.value.trim() !== "") {
      suggestionsEl.style.display = "none";
    }
  });

  // Click suggestion → fill input
  suggestionsEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains("suggestion-item")) {
      input.value = target.textContent ?? "";
      suggestionsEl.style.display = "none";
      input.focus();
    }
  });

  // Submit prompt
  async function handleSubmit() {
    const text = input.value.trim();
    if (!text) {
      return;
    }

    input.disabled = true;
    submitBtn.disabled = true;
    resultEl.style.display = "block";
    resultEl.innerHTML = `<div class="prompt-loading">Thinking...</div>`;

    try {
      const response = await submitPrompt(text);
      resultEl.innerHTML = `
        <div class="prompt-reply">
          <div class="reply-text">${escapeHtml(response.reply)}</div>
          ${response.intent ? `<div class="reply-meta">${response.intent.type} &middot; ${response.intent.brand ?? ""}</div>` : ""}
        </div>
      `;
    } catch (err) {
      resultEl.innerHTML = `<div class="prompt-error">Error: ${err instanceof Error ? err.message : "Unknown error"}</div>`;
    } finally {
      input.disabled = false;
      submitBtn.disabled = false;
    }
  }

  submitBtn.addEventListener("click", handleSubmit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      void handleSubmit();
    }
  });

  return container;
}

/** Fill the prompt bar with text (used by hover cards). */
export function fillPromptBar(text: string): void {
  const input = document.querySelector<HTMLInputElement>(".prompt-input");
  if (input) {
    input.value = text;
    input.focus();
  }
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
