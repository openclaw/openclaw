import type { WalkthroughStep } from "../api";
import { logEvent } from "../logger";

const WALKTHROUGH_DONE_KEY = "openclaw_walkthrough_done";

export function hasCompletedWalkthrough(): boolean {
  return localStorage.getItem(WALKTHROUGH_DONE_KEY) === "1";
}

export function startWalkthrough(steps: WalkthroughStep[]): void {
  if (steps.length === 0) {
    return;
  }

  let current = 0;
  const overlay = document.createElement("div");
  overlay.className = "walkthrough-overlay";
  document.body.appendChild(overlay);

  function render() {
    const step = steps[current];
    const isFirst = current === 0;
    const isLast = current === steps.length - 1;

    // Progress dots
    const dots = steps
      .map((_, i) => `<span class="walkthrough-dot ${i === current ? "active" : ""}"></span>`)
      .join("");

    overlay.innerHTML = `
      <div class="walkthrough-card">
        <h2 class="walkthrough-title">${step.title}</h2>
        <p class="walkthrough-body">${step.body}</p>
        ${step.tip ? `<p class="walkthrough-tip">${step.tip}</p>` : ""}

        <div class="walkthrough-nav">
          ${!isFirst ? `<button class="walkthrough-btn" id="wt-back">&larr; Back</button>` : ""}
          <button class="walkthrough-btn walkthrough-skip" id="wt-skip">Skip Tour</button>
          <button class="walkthrough-btn walkthrough-primary" id="wt-next">
            ${isLast ? step.cta || "Finish" : step.cta || "Next &rarr;"}
          </button>
        </div>

        <div class="walkthrough-dots">${dots}</div>
      </div>
    `;

    // Wire buttons
    overlay.querySelector("#wt-back")?.addEventListener("click", () => {
      if (current > 0) {
        current--;
        render();
      }
    });

    overlay.querySelector("#wt-next")?.addEventListener("click", () => {
      if (isLast) {
        finish();
      } else {
        current++;
        render();
      }
    });

    overlay.querySelector("#wt-skip")?.addEventListener("click", finish);
  }

  function finish() {
    overlay.remove();
    localStorage.setItem(WALKTHROUGH_DONE_KEY, "1");
    logEvent("walkthrough", `Completed (viewed ${current + 1}/${steps.length} steps)`);
    // Focus prompt bar after tour
    const input = document.querySelector<HTMLInputElement>(".prompt-input");
    input?.focus();
  }

  render();
}
