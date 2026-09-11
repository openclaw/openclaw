import type { WorkboardRunAttempt, WorkboardProof } from "@openclaw/workboard-contract";
import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import type { WorkboardCard, WorkboardDependencyState } from "../../lib/workboard/index.ts";
import { formatStatusLabel, formatUpdatedTime } from "./view-helpers.ts";

export function renderDependencyDetailList(dependencies: WorkboardDependencyState) {
  if (dependencies.parents.length === 0) {
    return nothing;
  }
  return html`
    <section class="workboard-detail__section">
      <h3>${t("workboard.dependencies")}</h3>
      <ul class="workboard-detail__list workboard-detail__dependencies">
        ${dependencies.parents.map(
          (parent) => html`
            <li class=${parent.done ? "is-done" : "is-blocked"}>
              ${
                parent.done
                  ? html`<span class="workboard-detail__dependency-spacer"></span>`
                  : icons.alertTriangle
              }
              <span>${parent.title}</span>
              <span>
                ${
                  parent.missing
                    ? t("workboard.dependencyStatusMissing")
                    : parent.status
                      ? formatStatusLabel(parent.status)
                      : t("workboard.unknownStatus")
                }
              </span>
            </li>
          `,
        )}
      </ul>
    </section>
  `;
}

export function renderDetailRow(label: string, value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") {
    return nothing;
  }
  const text = String(value).trim();
  if (!text) {
    return nothing;
  }
  return html`
    <div class="workboard-detail__row">
      <span>${label}</span>
      <strong>${text}</strong>
    </div>
  `;
}

export function renderDetailList(title: string, values: readonly string[]) {
  const entries = values.map((value) => value.trim()).filter(Boolean);
  if (entries.length === 0) {
    return nothing;
  }
  return html`
    <section class="workboard-detail__section">
      <h3>${title}</h3>
      <ol class="workboard-detail__list">
        ${entries.map((entry) => html`<li>${entry}</li>`)}
      </ol>
    </section>
  `;
}

function renderDetailTime(value: number | undefined) {
  const label = formatUpdatedTime(value);
  if (value === undefined || !label) {
    return nothing;
  }
  return html`<time class="workboard-detail__record-date" datetime=${new Date(value).toISOString()}
    >${label}</time
  >`;
}

export function renderAttemptDetails(attempts: readonly WorkboardRunAttempt[]) {
  if (!attempts.length) {
    return nothing;
  }
  const statusKeys: Record<WorkboardRunAttempt["status"], string> = {
    running: "workboard.lifecycleRunning",
    succeeded: "workboard.lifecycleDone",
    failed: "workboard.lifecycleFailed",
    blocked: "workboard.status.blocked",
    stopped: "workboard.lifecycleStopped",
  };
  return html`<section class="workboard-detail__section">
    <h3>${t("workboard.badgeAttempts", { count: String(attempts.length) })}</h3>
    <ol class="workboard-detail__records">
      ${attempts.map((entry, index) => {
        const started = renderDetailTime(entry.startedAt);
        const ended = renderDetailTime(entry.endedAt);
        return html`<li>
          <div class="workboard-detail__record-heading">
            <strong>${t("workboard.detailAttemptTitle", { number: String(index + 1) })}</strong>
            <span>${t(statusKeys[entry.status])}</span>
          </div>
          ${entry.model ? html`<p>${entry.model}</p>` : nothing}
          ${
            entry.sessionKey
              ? html`<p class="workboard-detail__record-reference">${entry.sessionKey}</p>`
              : nothing
          }
          ${entry.error ? html`<p>${formatUiExternalText(entry.error)}</p>` : nothing}
          <div class="workboard-detail__record-date">
            ${started}${started !== nothing && ended !== nothing ? " → " : nothing}${ended}
          </div>
        </li>`;
      })}
    </ol>
  </section>`;
}

export function renderProofDetails(proof: readonly WorkboardProof[]) {
  if (!proof.length) {
    return nothing;
  }
  const statusKeys: Record<WorkboardProof["status"], string> = {
    passed: "workboard.proofPassed",
    failed: "workboard.lifecycleFailed",
    skipped: "workboard.proofSkipped",
    unknown: "workboard.proofUnknown",
  };
  return html`<section class="workboard-detail__section">
    <h3>${t("workboard.detailProof")}</h3>
    <ol class="workboard-detail__records">
      ${proof.map(
        (entry) => html`<li>
          <div class="workboard-detail__record-heading">
            <strong>${entry.label || t("workboard.detailProof")}</strong>
            <span>${t(statusKeys[entry.status])}</span>
          </div>
          ${entry.command ? html`<code>${entry.command}</code>` : nothing}
          ${
            entry.url
              ? html`<p class="workboard-detail__record-reference">${entry.url}</p>`
              : nothing
          }
          ${entry.note ? html`<p>${entry.note}</p>` : nothing} ${renderDetailTime(entry.createdAt)}
        </li>`,
      )}
    </ol>
  </section>`;
}

function joinDetailParts(...values: unknown[]): string {
  return values.filter(Boolean).join(" - ");
}

function detailValues<T>(entries: readonly T[], ...fields: Array<keyof T>): string[] {
  return entries.map((entry) => joinDetailParts(...fields.map((field) => entry[field])));
}

export function getDetailSections(card: WorkboardCard) {
  const links = card.metadata?.links ?? [];
  const artifacts = card.metadata?.artifacts ?? [];
  const attachments = card.metadata?.attachments ?? [];
  const diagnostics = card.metadata?.diagnostics ?? [];
  const workerLogs = card.metadata?.workerLogs ?? [];
  const workerProtocol = card.metadata?.workerProtocol;
  const detailSections: Array<readonly [string, readonly string[]]> = [
    [
      t("workboard.badgeLinks", { count: String(links.length) }),
      detailValues(links, "type", "title", "targetCardId", "url"),
    ],
    [
      t("workboard.badgeArtifacts", { count: String(artifacts.length) }),
      detailValues(artifacts, "label", "url", "path", "mimeType"),
    ],
    [
      t("workboard.badgeAttachments", { count: String(attachments.length) }),
      detailValues(attachments, "fileName", "mimeType", "note"),
    ],
    [
      t("workboard.detailDiagnostics"),
      diagnostics.map((entry) =>
        joinDetailParts(
          `${entry.severity}: ${formatUiExternalText(entry.title)}`,
          formatUiExternalText(entry.detail),
          t("workboard.detailOccurrences", { count: String(entry.count) }),
          t("workboard.detailFirstSeen", { time: formatUpdatedTime(entry.firstSeenAt) }),
          t("workboard.detailLastSeen", { time: formatUpdatedTime(entry.lastSeenAt) }),
        ),
      ),
    ],
    [
      t("workboard.detailWorkerLogs"),
      workerLogs.map((entry) => `${entry.level}: ${formatUiExternalText(entry.message)}`),
    ],
    [
      t("workboard.detailWorkerProtocol"),
      workerProtocol
        ? [
            workerProtocol.state,
            formatUiExternalText(workerProtocol.detail),
            workerProtocol.updatedAt
              ? t("workboard.detailUpdatedValue", {
                  time: formatUpdatedTime(workerProtocol.updatedAt),
                })
              : "",
          ]
        : [],
    ],
  ];
  return detailSections;
}
