import type { PanelHelpInfo } from "../api";
import { fillPromptBar } from "./prompt-bar";

let activeCard: HTMLElement | null = null;

export function showHoverCard(anchor: HTMLElement, info: PanelHelpInfo): void {
  // Close any existing card
  closeHoverCard();

  const card = document.createElement("div");
  card.className = "hover-card";

  const actionsHtml = info.actions.map((a) => `<li>${a}</li>`).join("");

  const promptsHtml = info.prompts
    .map((p) => `<button class="hover-prompt" type="button">&ldquo;${p}&rdquo;</button>`)
    .join("");

  card.innerHTML = `
    <div class="hover-card-title">${info.title}</div>
    <div class="hover-card-desc">${info.description}</div>
    <hr class="hover-card-divider" />
    <div class="hover-card-section-label">What you can do here</div>
    <ul class="hover-card-actions">${actionsHtml}</ul>
    <hr class="hover-card-divider" />
    <div class="hover-card-section-label">Try asking</div>
    <div class="hover-card-prompts">${promptsHtml}</div>
    ${info.approval_note ? `<hr class="hover-card-divider" /><div class="hover-card-approval">${info.approval_note}</div>` : ""}
  `;

  // Click prompt → fill prompt bar
  card.querySelectorAll<HTMLButtonElement>(".hover-prompt").forEach((btn) => {
    btn.addEventListener("click", () => {
      const text = btn.textContent?.replace(/["\u201C\u201D]/g, "").trim() ?? "";
      fillPromptBar(text);
      closeHoverCard();
    });
  });

  // Position relative to anchor
  const rect = anchor.getBoundingClientRect();
  card.style.top = `${rect.bottom + 8}px`;
  card.style.right = `${window.innerWidth - rect.right}px`;

  document.body.appendChild(card);
  activeCard = card;

  // Close on click outside
  setTimeout(() => {
    document.addEventListener("click", handleOutsideClick);
    document.addEventListener("keydown", handleEscape);
  }, 0);
}

export function closeHoverCard(): void {
  if (activeCard) {
    activeCard.remove();
    activeCard = null;
    document.removeEventListener("click", handleOutsideClick);
    document.removeEventListener("keydown", handleEscape);
  }
}

function handleOutsideClick(e: Event): void {
  if (activeCard && !activeCard.contains(e.target as Node)) {
    closeHoverCard();
  }
}

function handleEscape(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    closeHoverCard();
  }
}
