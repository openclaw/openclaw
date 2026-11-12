/** @jsxImportSource @solidjs/web */
// The People sections of the Access page. Each takes plain data and callbacks, so the
// page owns all Gateway access and the sections can be restyled independently.
import type { MemberRole } from "@openclaw/openclaw-id-protocol";
import type { ControlUiComponentHandle, ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createEffect, createSignal, For, latest, onSettled, Show } from "solid-js";
import type { CreatedInvite } from "./invites.js";
import type { PeopleError, PeopleOperationError } from "./people-error.js";
import {
  countDevices,
  formatDay,
  roleName,
  memberName,
  memberPresence,
  memberRunning,
  personInitials,
} from "./people-format.js";
import type { PeopleMotion } from "./people-motion.js";
import type { Invite, Member } from "./types.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A single sanitized diagnostic disclosure, placed at the failed operation. */
export function OperationError(props: { error?: PeopleError | null; page?: boolean }) {
  return (
    <Show when={props.error} keyed>
      {(failure) => (
        <div class={["ocid-access__error", { "callout danger": props.page }]} role="alert">
          <p>{failure.message}</p>
          <Show when={failure.diagnostic}>
            {(diagnostic) => (
              <details class="ocid-access__details">
                <summary>Technical details</summary>
                <code>{diagnostic()}</code>
              </details>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}

function Avatar(props: { name?: string }) {
  return (
    <span
      class={["ocid-access__avatar", { "ocid-access__avatar--unknown": !props.name }]}
      aria-hidden="true"
    >
      <Show
        when={props.name}
        fallback={
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <circle cx="12" cy="7" r="4" />
            <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
          </svg>
        }
      >
        {personInitials(props.name ?? "")}
      </Show>
    </span>
  );
}

export type RemovedMemberNotice = { index: number; message: string };

type RolePickerProps = Parameters<ControlUiHost["components"]["mountSelectPicker"]>[1];
const ROLE_OPTIONS: RolePickerProps["options"] = [
  {
    value: "operator",
    label: "Operator",
    description: "Chat, run tools, and use connected services",
  },
  { value: "viewer", label: "Viewer", description: "Read conversations only" },
];

// The host picker owns listbox navigation, dismissal, and focus restoration.
function RolePicker(props: {
  components: ControlUiHost["components"];
  role: MemberRole;
  disabled: boolean;
  onSelect: (role: MemberRole) => void;
}) {
  let container!: HTMLDivElement;
  let handle: ControlUiComponentHandle<RolePickerProps> | undefined;
  createEffect(
    () => ({
      options: ROLE_OPTIONS,
      value: props.role,
      accessibleLabel: "Role",
      searchable: false,
      disabled: props.disabled,
      onSelect: (value: string) => props.onSelect(value === "viewer" ? "viewer" : "operator"),
    }),
    (value) => {
      if (handle) {
        handle.update(value);
      } else {
        handle = props.components.mountSelectPicker(container, value);
      }
    },
  );
  onSettled(() => () => handle?.dispose());
  return <div class="ocid-access__role-picker" ref={(element) => (container = element)} />;
}

/** Invite one person with a role ceiling (operator at most); shows the link once. */
export function InviteForm(props: {
  motion: PeopleMotion;
  components: ControlUiHost["components"];
  disabled: boolean;
  busy?: boolean;
  locale: string;
  error?: PeopleError | null;
  onCreate: (email: string, role: MemberRole) => Promise<CreatedInvite | undefined>;
}) {
  const [email, setEmail] = createSignal("");
  const [role, setRole] = createSignal<MemberRole>("operator");
  const [created, setCreated] = createSignal<(CreatedInvite & { role: MemberRole }) | null>(null);
  const [copied, setCopied] = createSignal(false);
  let emailInput!: HTMLInputElement;
  let inviteAgain!: HTMLButtonElement;
  const submit = async () => {
    const invitedRole = role();
    const made = await props.onCreate(email().trim().toLowerCase(), invitedRole);
    if (made) {
      props.motion.update(() => {
        setCreated({ ...made, role: invitedRole });
        setCopied(false);
        setEmail("");
      });
      onSettled(() => inviteAgain.focus());
    }
  };
  // Clipboard access can be refused (permissions, insecure context); the link stays selectable.
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section class="ocid-access__section" aria-labelledby="ocid-access-invite">
      <h3 id="ocid-access-invite">Invite someone</h3>
      <p class="ocid-access__hint">
        Choose their access, then send them the link. You approve their request here. The link
        expires in 7 days.
      </p>
      <div class="ocid-access__invite-card" ref={props.motion.group({ watchContent: true })}>
        <Show
          when={created()}
          keyed
          fallback={
            <form
              class="ocid-access__form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!props.disabled && EMAIL.test(email().trim())) {
                  void submit();
                }
              }}
            >
              <input
                ref={(element) => (emailInput = element)}
                class="settings-input"
                type="email"
                aria-label="Email address to invite"
                placeholder="name@example.com"
                autocomplete="off"
                spellcheck="false"
                value={email()}
                disabled={props.disabled}
                onInput={(event) => setEmail(event.currentTarget.value)}
              />
              <RolePicker
                components={props.components}
                role={role()}
                disabled={props.disabled}
                onSelect={setRole}
              />
              <button
                type="submit"
                class="btn primary"
                disabled={props.disabled || !EMAIL.test(email().trim())}
                aria-busy={props.busy ? "true" : undefined}
              >
                <span class="btn__label">Create invite link</span>
                <Show when={props.busy}>
                  <span class="btn__spinner" aria-hidden="true" />
                </Show>
              </button>
            </form>
          }
        >
          {(made) => (
            <div class="ocid-access__created">
              <Avatar name={made.email} />
              <div class="ocid-access__person" role="status">
                <div class="ocid-access__title">{made.email}</div>
                <p class="ocid-access__hint">
                  {roleName(made.role)} invite · expires {formatDay(made.expiresAt, props.locale)}
                </p>
              </div>
              <button
                ref={(element) => (inviteAgain = element)}
                type="button"
                class="ocid-access__invite-again"
                onClick={() => {
                  props.motion.update(() => {
                    setCreated(null);
                    setRole("operator");
                  });
                  onSettled(() => emailInput.focus());
                }}
              >
                Invite someone
              </button>
              <div class="ocid-access__link">
                <div class="ocid-access__link-copy">
                  <code class="ocid-access__url" title={made.url}>
                    {made.url}
                  </code>
                  <button
                    type="button"
                    class="btn primary btn--sm"
                    aria-label={latest(copied) ? "Copied" : "Copy link"}
                    onClick={() => void copy(made.url)}
                  >
                    <span role="status">{latest(copied) ? "Copied" : "Copy link"}</span>
                  </button>
                </div>
                <p class="ocid-access__hint">
                  Send this link privately. Anyone with it can request access, but only you can
                  approve them.
                </p>
              </div>
            </div>
          )}
        </Show>
        <OperationError error={props.error} />
      </div>
      <p class="ocid-access__hint" id="ocid-access-role-hint">
        Invites cannot grant owner access. Connected services keep their own permissions.
      </p>
    </section>
  );
}

/** Pending requests: who is asking, from which device, with which invite. */
export function PendingRequests(props: {
  motion: PeopleMotion;
  invites: Invite[];
  /** Display fingerprint by device key, for the device each request comes from. */
  fingerprints: ReadonlyMap<string, string>;
  disabled: boolean;
  locale: string;
  error?: PeopleOperationError | null;
  readOnly?: boolean;
  onDecide: (invite: Invite, approve: boolean) => void;
  onRefresh: () => void;
}) {
  const departedRequestError = () =>
    props.error?.target.startsWith("request:") &&
    !props.invites.some((invite) => props.error?.target === `request:${invite.inviteId}`)
      ? props.error
      : null;
  return (
    <section
      class={[
        "ocid-access__section",
        {
          "ocid-access__enter": props.invites.length > 0,
          "ocid-access__sr-only":
            props.invites.length === 0 && !props.error?.target.startsWith("request:"),
        },
      ]}
      ref={props.motion.group()}
      aria-labelledby="ocid-access-pending"
    >
      <h3 id="ocid-access-pending">
        {props.readOnly ? "Waiting for approval" : "Waiting for you"}
      </h3>
      <Show when={departedRequestError()}>
        {(failure) => (
          <div class="ocid-access__section">
            <OperationError error={failure()} />
            <Show when={!props.readOnly && failure().approvalUncertain}>
              <div class="ocid-access__actions">
                <button
                  type="button"
                  class="btn btn--sm"
                  disabled={props.disabled}
                  onClick={() => props.onRefresh()}
                >
                  Refresh
                </button>
              </div>
            </Show>
          </div>
        )}
      </Show>
      <Show
        when={props.invites.length > 0}
        fallback={<p class="ocid-access__empty">No one is waiting for approval.</p>}
      >
        <ul class="ocid-access__list" ref={props.motion.group()}>
          <For each={props.invites} keyed={(invite) => invite.inviteId}>
            {(invite) => {
              const pending = () => invite().pending!;
              const who = () => pending().reported.email || "OpenClaw ID account";
              return (
                <li
                  class="ocid-access__row ocid-access__row--request"
                  ref={[
                    props.motion.group({ requestKey: () => invite().inviteId }),
                    props.motion.enter(),
                  ]}
                >
                  <Avatar name={pending().reported.email || undefined} />
                  <div class="ocid-access__person">
                    <div class="ocid-access__title">{who()}</div>
                    <div class="ocid-access__hint">
                      {roleName(invite().role)} invite ·{" "}
                      {pending().reported.locationHint ?? "location unknown"} · decide by{" "}
                      {formatDay(pending().decideBy, props.locale)}
                    </div>
                  </div>
                  <Show when={!props.readOnly}>
                    <div class="ocid-access__actions">
                      <Show
                        when={
                          props.error?.target === `request:${invite().inviteId}` &&
                          props.error.approvalUncertain
                        }
                        fallback={
                          <>
                            <button
                              type="button"
                              class="btn primary btn--sm"
                              disabled={props.disabled}
                              onClick={() => props.onDecide(invite(), true)}
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              class="btn btn--sm"
                              disabled={props.disabled}
                              onClick={() => props.onDecide(invite(), false)}
                            >
                              Deny
                            </button>
                          </>
                        }
                      >
                        <button
                          type="button"
                          class="btn btn--sm"
                          disabled={props.disabled}
                          onClick={() => props.onRefresh()}
                        >
                          Refresh
                        </button>
                      </Show>
                    </div>
                  </Show>
                  <details class="ocid-access__details ocid-access__request-details">
                    <summary onClick={() => queueMicrotask(props.motion.prepare())}>
                      Request details
                    </summary>
                    <p class="ocid-access__hint">
                      Device ID:{" "}
                      <code>{props.fingerprints.get(pending().devicePub) ?? "unavailable"}</code>
                    </p>
                    <p class="ocid-access__hint">
                      OpenClaw ID provided this email and approximate location. Device details are
                      unavailable.
                    </p>
                  </details>
                  <div class="ocid-access__row-error">
                    <OperationError
                      error={
                        props.error?.target === `request:${invite().inviteId}` ? props.error : null
                      }
                    />
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </section>
  );
}

/** One member row; Remove asks for confirmation and says what removal does. */
function MemberRow(props: {
  motion: PeopleMotion;
  member: Member;
  disabled: boolean;
  nowMs: number;
  sessionTitle: (sessionKey: string) => string | undefined;
  onRemove: (member: Member) => void;
  error?: PeopleOperationError | null;
  readOnly?: boolean;
}) {
  const [confirming, setConfirming] = createSignal(false);
  const devices = () => props.member.devices ?? [];
  const running = () => memberRunning(devices(), props.sessionTitle);
  const details = () =>
    [
      props.member.email && props.member.email !== memberName(props.member)
        ? props.member.email
        : undefined,
      countDevices(props.member.peerKeys.length),
      memberPresence(devices(), props.nowMs),
      running(),
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <li
      ref={[props.motion.group(), props.motion.enter()]}
      class={[
        "ocid-access__row ocid-access__row--member",
        { "ocid-access__row--confirming": latest(confirming) },
      ]}
    >
      <Avatar name={memberName(props.member)} />
      <div class="ocid-access__person">
        <div class="ocid-access__title">{memberName(props.member)}</div>
        <div class="ocid-access__hint" title={details()}>
          {details()}
        </div>
      </div>
      <div class="ocid-access__actions ocid-access__member-actions">
        <Show when={!props.readOnly && !latest(confirming)}>
          <button
            type="button"
            class="btn btn--sm ocid-access__remove"
            disabled={props.disabled}
            onClick={() => props.motion.update(() => setConfirming(true))}
          >
            Remove
          </button>
        </Show>
        <span class="chip">{props.member.role}</span>
      </div>
      <Show when={latest(confirming) && !props.readOnly}>
        <div class="ocid-access__confirmation">
          <div role="note">
            <p>Their devices disconnect now, and their running tasks stop.</p>
            <p class="ocid-access__hint">
              Completed work and conversations stay here. They need a new invite to return.
            </p>
          </div>
          <div class="ocid-access__actions">
            <button
              type="button"
              class="btn btn--sm"
              disabled={props.disabled}
              onClick={() => props.motion.update(() => setConfirming(false))}
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn btn--sm danger"
              disabled={props.disabled}
              onClick={() => props.onRemove(props.member)}
            >
              Remove {memberName(props.member)}
            </button>
          </div>
        </div>
      </Show>
      <div class="ocid-access__row-error">
        <OperationError
          error={props.error?.target === `member:${props.member.accountId}` ? props.error : null}
        />
      </div>
    </li>
  );
}

/** Members: the owner, each member with devices and activity, and open invites. */
export function Members(props: {
  motion: PeopleMotion;
  members: Member[];
  invites: Invite[];
  ownerDevices: number;
  notice?: RemovedMemberNotice | null;
  disabled: boolean;
  locale: string;
  nowMs: number;
  sessionTitle: (sessionKey: string) => string | undefined;
  onRemove: (member: Member) => void;
  error?: PeopleOperationError | null;
  readOnly?: boolean;
}) {
  const open = () => props.invites.filter((invite) => invite.status === "open");
  return (
    <section class="ocid-access__section" aria-labelledby="ocid-access-members">
      <h3 id="ocid-access-members">Members</h3>
      <p class="ocid-access__hint">
        Who can open this claw. Only you can change this, from one of your own devices.
      </p>
      <OperationError
        error={
          props.error?.target.startsWith("member:") &&
          !props.members.some((member) => props.error?.target === `member:${member.accountId}`)
            ? props.error
            : null
        }
      />
      <ul class="ocid-access__list" ref={props.motion.group()}>
        <li class="ocid-access__row ocid-access__row--owner">
          <Avatar name="You" />
          <div class="ocid-access__person">
            <div class="ocid-access__title">You</div>
            <div class="ocid-access__hint">{countDevices(props.ownerDevices)}</div>
          </div>
          <span class="chip">owner</span>
        </li>
        <For each={open()} keyed={(invite) => invite.inviteId}>
          {(invite) => (
            <li class="ocid-access__row ocid-access__row--invited" ref={props.motion.enter()}>
              <Avatar name={invite().label} />
              <div class="ocid-access__person">
                <div class="ocid-access__title">{invite().label}</div>
                <div class="ocid-access__hint">
                  Not accepted yet · expires {formatDay(invite().expiresAt, props.locale)}
                </div>
              </div>
              <span class="chip">{invite().role}</span>
            </li>
          )}
        </For>
        <For each={props.members} keyed={(member) => member.accountId}>
          {(member, index) => (
            <>
              <Show when={props.notice && props.notice.index === index()}>
                <li class="ocid-access__notice" role="status">
                  {props.notice?.message}
                </li>
              </Show>
              <MemberRow
                motion={props.motion}
                member={member()}
                error={props.error}
                readOnly={props.readOnly}
                disabled={props.disabled}
                nowMs={props.nowMs}
                sessionTitle={props.sessionTitle}
                onRemove={props.onRemove}
              />
            </>
          )}
        </For>
        <Show when={props.notice && props.notice.index >= props.members.length}>
          <li class="ocid-access__notice" role="status">
            {props.notice?.message}
          </li>
        </Show>
      </ul>
    </section>
  );
}
