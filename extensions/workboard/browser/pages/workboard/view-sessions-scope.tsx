/** @jsxImportSource @solidjs/web */
import type { ProjectsListResult, SessionsGroupsListResult } from "@openclaw/gateway-protocol";
import type { WorkboardSessionsBoardSpec } from "@openclaw/workboard-contract";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
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

/** The editor owns these fields; other saved scope fields pass through unchanged. */
export function sessionsScopeFiltersKey(scope: SessionsBoardScope | undefined): string {
  return JSON.stringify([
    scope?.group ?? null,
    scope?.projectId ?? null,
    scope?.titleContains?.trim() || null,
    scope?.includeSessionKeys ?? null,
  ]);
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

function sessionsScopeSummary(scope: SessionsBoardScope): string {
  const picked = scope.includeSessionKeys;
  return [
    scope.group === undefined ? "" : scope.group || t("workboard.sessionsBoard.scope.noGroup"),
    scope.projectId ?? "",
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
  canEdit: boolean;
  onEdit: () => void;
}) {
  const summary = () =>
    props.scope && hasSessionsScopeFilters(props.scope) ? sessionsScopeSummary(props.scope) : "";
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
  const [groups, setGroups] = createSignal<readonly string[]>([]);
  const [projects, setProjects] = createSignal<ProjectsListResult["projects"]>([]);
  const [choicesFailed, setChoicesFailed] = createSignal(false);
  const loadChoices = async (client: GatewayBrowserClient, live: () => boolean) => {
    const [groupResult, projectResult] = await Promise.allSettled([
      client.request<SessionsGroupsListResult>("sessions.groups.list", {}),
      client.request<ProjectsListResult>("projects.list", {}),
    ]);
    if (!live()) {
      return;
    }
    if (groupResult.status === "fulfilled") {
      setGroups(groupResult.value.groups.map((group) => group.name));
    }
    if (projectResult.status === "fulfilled") {
      setProjects(projectResult.value.projects);
    }
    setChoicesFailed(groupResult.status === "rejected" || projectResult.status === "rejected");
  };
  onSettled(() => {
    let live = true;
    if (props.client) {
      void loadChoices(props.client, () => live);
    }
    return () => {
      live = false;
    };
  });
  // Picks survive switching to "Any session" and back while this editor is open.
  let parkedKeys: string[] = [];
  const picked = () => scope().includeSessionKeys;
  const titleValue = liveInputValue(() => scope().titleContains ?? "");
  const groupOptions = createMemo(() => {
    const current = scope().group;
    const names = groups().includes(current ?? "") || !current ? groups() : [...groups(), current];
    return [
      { value: ANY_GROUP, label: t("workboard.sessionsBoard.scope.anyGroup") },
      { value: NO_GROUP, label: t("workboard.sessionsBoard.scope.noGroup") },
      ...names.map((name) => ({ value: groupValue(name), label: name })),
    ];
  });
  const projectOptions = createMemo(() => {
    const current = scope().projectId;
    const options = projects().map((project) => ({
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
        <Show when={choicesFailed()}>
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
                            class="btn btn--icon"
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
