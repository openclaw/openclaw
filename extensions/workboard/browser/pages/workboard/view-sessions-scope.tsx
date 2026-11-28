/** @jsxImportSource @solidjs/web */
import type { ProjectsListResult, SessionsGroupsListResult } from "@openclaw/gateway-protocol";
import type { WorkboardSessionsBoardSpec } from "@openclaw/workboard-contract";
import { createMemo, For, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { SelectPicker } from "../../components/host-components.tsx";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import { liveInputValue } from "./view-input-value.ts";

export type SessionsBoardScope = NonNullable<WorkboardSessionsBoardSpec["scope"]>;
export type SessionsScopeChoice = { key: string; label: string };

const ANY_GROUP = "any";
const NO_GROUP = "none";
const groupValue = (group: string | undefined) =>
  group === undefined ? ANY_GROUP : group === "" ? NO_GROUP : `group:${group}`;

/** An omitted field is untouched; null removes a filter, and [] selects no sessions. */
export function editedScopeFields(
  original: SessionsBoardScope | undefined,
  draft: SessionsBoardScope,
) {
  const changes = Object.fromEntries(
    (["group", "projectId", "titleContains", "includeSessionKeys"] as const)
      .filter((field) => JSON.stringify(original?.[field]) !== JSON.stringify(draft[field]))
      .map((field) => [field, draft[field] ?? null]),
  );
  return Object.keys(changes).length ? changes : undefined;
}

export function hasSessionsScopeFilters(scope: SessionsBoardScope | undefined): boolean {
  return Boolean(
    scope &&
    (scope.group !== undefined ||
      scope.projectId ||
      scope.titleContains?.trim() ||
      scope.includeSessionKeys),
  );
}

/** Trim the edited title in a copy of the full scope, keeping fields this editor does not show. */
export function sessionsScopeForSave(scope: SessionsBoardScope): SessionsBoardScope {
  const { titleContains, ...rest } = scope;
  const title = titleContains?.trim();
  return title ? { ...rest, titleContains: title } : rest;
}

function sessionsScopeSummary(scope: SessionsBoardScope, projectName: string): string {
  const picked = scope.includeSessionKeys;
  return [
    scope.group === undefined ? "" : scope.group || t("workboard.sessionsBoard.scope.noGroup"),
    projectName,
    scope.titleContains ? `“${scope.titleContains}”` : "",
    !picked
      ? ""
      : picked.length
        ? t("workboard.sessionsBoard.scope.pickedCount", { count: String(picked.length) })
        : t("workboard.sessionsBoard.scope.nonePickedShort"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The open board's saved filters under its title; editors open the board settings. */
export function SessionsScopeHeading(props: {
  scope: SessionsBoardScope | undefined;
  client: GatewayBrowserClient | null;
  canEdit: boolean;
  onEdit: () => void;
}) {
  // Saved scopes hold project ids; show the project's name like the editor does.
  const projectClient = createMemo(() => (props.scope?.projectId ? props.client : null));
  const projectNames = createMemo(() => {
    const client = projectClient();
    return (async function* () {
      yield new Map<string, string>(); // Show the saved id immediately, even if the list is unavailable.
      if (client) {
        const result = await client
          .request<ProjectsListResult>("projects.list", {})
          .catch(() => null);
        if (result) {
          yield new Map(result.projects.map(({ id, displayName }) => [id, displayName]));
        }
      }
    })();
  });
  const summary = () => {
    const scope = props.scope;
    if (!scope || !hasSessionsScopeFilters(scope)) {
      return "";
    }
    const projectId = scope.projectId ?? "";
    return sessionsScopeSummary(scope, projectNames().get(projectId) ?? projectId);
  };
  return (
    <Show when={summary()}>
      <div class="workboard-heading__scope">
        <Show
          when={props.canEdit}
          fallback={
            <span
              class="workboard-heading__scope-name"
              aria-label={t("workboard.sessionsBoard.scope.summaryLabel", { filters: summary() })}
            >
              <span class="workboard-heading__scope-icon" aria-hidden="true">
                {icons.listFilter}
              </span>
              <span class="workboard-heading__scope-label">{summary()}</span>
            </span>
          }
        >
          <button
            class="workboard-heading__scope-name"
            type="button"
            aria-label={t("workboard.sessionsBoard.scope.summaryLabel", { filters: summary() })}
            title={t("workboard.sessionsBoard.scope.edit")}
            onClick={() => props.onEdit()}
          >
            <span class="workboard-heading__scope-icon" aria-hidden="true">
              {icons.listFilter}
            </span>
            <span class="workboard-heading__scope-label">{summary()}</span>
          </button>
        </Show>
      </div>
    </Show>
  );
}

export function SessionsScopeEditor(props: {
  scope: SessionsBoardScope;
  revision?: number;
  disabled: boolean;
  client: GatewayBrowserClient | null;
  sessions: readonly SessionsScopeChoice[];
  onChange: () => void;
}) {
  const scope = () => {
    void props.revision;
    return props.scope;
  };
  const activeClient = createMemo(() => props.client);
  const choices = createMemo(() => {
    const client = activeClient();
    return (async function* () {
      // Render the editable draft before either list arrives; reconnect starts a new read.
      yield {
        groups: [] as string[],
        projects: [] as ProjectsListResult["projects"],
        failed: false,
      };
      if (!client) {
        return;
      }
      const [groupResult, projectResult] = await Promise.allSettled([
        client.request<SessionsGroupsListResult>("sessions.groups.list", {}),
        client.request<ProjectsListResult>("projects.list", {}),
      ]);
      yield {
        groups:
          groupResult.status === "fulfilled"
            ? groupResult.value.groups.map(({ name }) => name)
            : [],
        projects: projectResult.status === "fulfilled" ? projectResult.value.projects : [],
        failed: groupResult.status === "rejected" || projectResult.status === "rejected",
      };
    })();
  });
  // Picks survive switching to "Any session" and back while this editor is open.
  let parkedKeys: string[] = [];
  const picked = () => scope().includeSessionKeys;
  const titleValue = liveInputValue(() => scope().titleContains ?? "");
  const groupOptions = createMemo(() => {
    const current = scope().group;
    const { groups } = choices();
    const names = groups.includes(current ?? "") || !current ? groups : [...groups, current];
    return [
      { value: ANY_GROUP, label: t("workboard.sessionsBoard.scope.anyGroup") },
      { value: NO_GROUP, label: t("workboard.sessionsBoard.scope.noGroup") },
      ...names.map((name) => ({ value: groupValue(name), label: name })),
    ];
  });
  const projectOptions = createMemo(() => {
    const current = scope().projectId;
    const options = choices().projects.map((project) => ({
      value: project.id,
      label: project.displayName,
      description: project.repositoryIdentity,
    }));
    if (current && !options.some((option) => option.value === current)) {
      options.push({ value: current, label: current, description: undefined });
    }
    return [{ value: "", label: t("workboard.sessionsBoard.scope.anyProject") }, ...options];
  });
  const labels = createMemo(
    () => new Map(props.sessions.map((session) => [session.key, session.label])),
  );
  const addOptions = createMemo(() => {
    const chosen = new Set(picked() ?? []);
    return [
      { value: "", label: t("workboard.sessionsBoard.scope.addSession") },
      ...props.sessions
        .filter((session) => !chosen.has(session.key))
        .map((session) => ({
          value: session.key,
          label: session.label,
          description: session.label === session.key ? undefined : session.key,
        })),
    ];
  });
  const removeButtons = new Map<string, HTMLButtonElement>();
  let pickedRadio: HTMLInputElement | undefined;
  const setPicked = (keys: string[] | undefined) => {
    if (keys) {
      scope().includeSessionKeys = keys;
    } else {
      delete scope().includeSessionKeys;
    }
    props.onChange();
  };
  const remove = (key: string) => {
    const keys = picked() ?? [];
    const index = keys.indexOf(key);
    const next = keys.filter((entry) => entry !== key);
    // Keep keyboard users in the list; the last removal returns focus to the choice.
    const neighbor = next[Math.min(index, next.length - 1)];
    (neighbor ? removeButtons.get(neighbor) : pickedRadio)?.focus();
    removeButtons.delete(key);
    setPicked(next);
  };
  return (
    <section class="workboard-sessions-scope">
      <fieldset class="workboard-sessions-scope__body" disabled={props.disabled}>
        <legend>{t("workboard.sessionsBoard.scope.title")}</legend>
        <div class="workboard-sessions-scope__filters">
          <div class="workboard-field">
            <span>{t("workboard.sessionsBoard.scope.group")}</span>
            <SelectPicker
              value={groupValue(scope().group)}
              options={groupOptions()}
              accessibleLabel={t("workboard.sessionsBoard.scope.group")}
              searchable={groupOptions().length > 8}
              disabled={props.disabled}
              onSelect={(value) => {
                if (value === ANY_GROUP) {
                  delete scope().group;
                } else {
                  scope().group = value === NO_GROUP ? "" : value.slice("group:".length);
                }
                props.onChange();
              }}
            />
          </div>
          <div class="workboard-field">
            <span>{t("workboard.sessionsBoard.scope.project")}</span>
            <SelectPicker
              value={scope().projectId ?? ""}
              options={projectOptions()}
              accessibleLabel={t("workboard.sessionsBoard.scope.project")}
              searchable
              disabled={props.disabled}
              onSelect={(value) => {
                if (value) {
                  scope().projectId = value;
                } else {
                  delete scope().projectId;
                }
                props.onChange();
              }}
            />
          </div>
          <label class="workboard-field">
            <span>{t("workboard.sessionsBoard.scope.titleContains")}</span>
            <input
              class="settings-input"
              type="text"
              ref={titleValue}
              onInput={(event) => {
                const value = event.currentTarget.value;
                if (value) {
                  scope().titleContains = value;
                } else {
                  delete scope().titleContains;
                }
                props.onChange();
              }}
            />
          </label>
        </div>
        <Show when={choices().failed}>
          <p class="workboard-sessions-scope__note">
            {t("workboard.sessionsBoard.scope.choicesUnavailable")}
          </p>
        </Show>
        <fieldset class="workboard-sessions-scope__which">
          <legend>{t("workboard.sessionsBoard.scope.which")}</legend>
          <div class="workboard-sessions-scope__modes">
            <label>
              <input
                type="radio"
                name="sessions-scope-mode"
                checked={!picked()}
                onChange={() => {
                  parkedKeys = picked() ?? [];
                  setPicked(undefined);
                }}
              />
              {t("workboard.sessionsBoard.scope.anySession")}
            </label>
            <label>
              <input
                type="radio"
                name="sessions-scope-mode"
                checked={Boolean(picked())}
                ref={(element) => {
                  pickedRadio = element;
                }}
                onChange={() => setPicked([...parkedKeys])}
              />
              {t("workboard.sessionsBoard.scope.pickedSessions")}
            </label>
          </div>
          <Show when={picked()}>
            <div class="workboard-sessions-scope__picked">
              <Show
                when={(picked()?.length ?? 0) > 0}
                fallback={
                  <p class="workboard-sessions-scope__note" role="status">
                    {t("workboard.sessionsBoard.scope.nonePicked")}
                  </p>
                }
              >
                <ul
                  class="workboard-sessions-scope__chips"
                  aria-label={t("workboard.sessionsBoard.scope.pickedList")}
                >
                  <For each={picked() ?? []}>
                    {(key) => {
                      const label = () => labels().get(key) ?? key;
                      return (
                        <li class="workboard-sessions-scope__chip" title={key}>
                          <span>{label()}</span>
                          <button
                            class="btn btn--icon btn--ghost"
                            type="button"
                            aria-label={t("workboard.sessionsBoard.scope.removeSession", {
                              name: label(),
                            })}
                            ref={(element) => {
                              removeButtons.set(key, element);
                            }}
                            onClick={() => remove(key)}
                          >
                            {icons.x}
                          </button>
                        </li>
                      );
                    }}
                  </For>
                </ul>
              </Show>
              <SelectPicker
                class="workboard-sessions-scope__add"
                value=""
                options={addOptions()}
                accessibleLabel={t("workboard.sessionsBoard.scope.addSession")}
                searchable
                disabled={props.disabled || addOptions().length <= 1}
                onSelect={(value) => {
                  if (value) {
                    setPicked([...(picked() ?? []), value]);
                  }
                }}
              />
            </div>
          </Show>
        </fieldset>
        <p class="workboard-sessions-editor__help">{t("workboard.sessionsBoard.scope.help")}</p>
      </fieldset>
    </section>
  );
}
