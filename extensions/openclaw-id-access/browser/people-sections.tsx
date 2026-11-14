/** @jsxImportSource @solidjs/web */
// The People sections of the Access page. Each takes plain data and callbacks, so the
// page owns all Gateway access and the sections can be restyled independently.
import type { MemberRole } from "@openclaw/openclaw-id-protocol";
import type { ControlUiComponentHandle, ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createEffect, createSignal, For, latest, onSettled, Show } from "solid-js";
import { roleText } from "./i18n.js";
import { InviteSandboxWarning } from "./invite-sandbox-warning.js";
import { RoleClassificationChangedError, type CreatedInvite } from "./invites.js";
import { MemberDevices } from "./member-devices.js";
import { Avatar } from "./people-avatar.js";
import type { PeopleError, PeopleOperationError } from "./people-error.js";
import {
  countDevices,
  formatDay,
  roleName,
  memberName,
  memberPresence,
  memberRunning,
} from "./people-format.js";
import type { PeopleMotion } from "./people-motion.js";
import { OperationError } from "./people-operation-error.js";
import { administratorWarning, definedRoles, roleOptions } from "./people-roles.js";
import type { Invite, Link, Member, MemberDevice, OwnerDevice, Role } from "./types.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type RemovedMemberNotice = { index: number; message: string };

type RolePickerProps = Parameters<ControlUiHost["components"]["mountSelectPicker"]>[1];
// The host picker owns listbox navigation, dismissal, and focus restoration.
function RolePicker(props: {
  components: ControlUiHost["components"];
  role: MemberRole;
  roles: Role[];
  locale: string;
  disabled: boolean;
  onSelect: (role: MemberRole) => void;
}) {
  let container!: HTMLDivElement;
  let handle: ControlUiComponentHandle<RolePickerProps> | undefined;
  createEffect(
    () => ({
      options: roleOptions(props.roles, props.locale),
      value: props.role,
      accessibleLabel: roleText(props.locale, "role"),
      searchable: false,
      disabled: props.disabled,
      onSelect: (value: string) => {
        if (definedRoles(props.roles).some((role) => role.name === value)) {
          props.onSelect(value);
        }
      },
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

/** Invite one person with an exact role; shows the link once. */
export function InviteForm(props: {
  link?: Link;
  motion: PeopleMotion;
  components: ControlUiHost["components"];
  disabled: boolean;
  busy?: boolean;
  roles: Role[];
  locale: string;
  error?: PeopleError | null;
  onCreate: (
    email: string,
    role: MemberRole,
    confirmedAdmin: boolean,
  ) => Promise<CreatedInvite | undefined>;
}) {
  const [email, setEmail] = createSignal("");
  const [selected, setRole] = createSignal<MemberRole>();
  const roles = () => definedRoles(props.roles);
  const selectedRole = () => roles().find((role) => role.name === selected()) ?? roles()[0];
  const [confirmAdmin, setConfirmAdmin] = createSignal(false);
  const [created, setCreated] = createSignal<(CreatedInvite & { role: MemberRole }) | null>(null);
  const [copied, setCopied] = createSignal(false);
  let emailInput!: HTMLInputElement;
  let inviteAgain!: HTMLButtonElement;
  const submit = async (confirmedAdmin = false) => {
    const invitedRole = selectedRole()?.name;
    if (!invitedRole || props.disabled || !EMAIL.test(email().trim())) {
      return;
    }
    let made: CreatedInvite | undefined;
    try {
      made = await props.onCreate(email().trim().toLowerCase(), invitedRole, confirmedAdmin);
    } catch (error) {
      if (!(error instanceof RoleClassificationChangedError)) {
        throw error;
      }
      setConfirmAdmin(true);
      return;
    }
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
                if (!props.disabled && selectedRole() && EMAIL.test(email().trim())) {
                  if (selectedRole()?.admin) {
                    setConfirmAdmin(true);
                  } else {
                    void submit();
                  }
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
                onInput={(event) => {
                  setEmail(event.currentTarget.value);
                  setConfirmAdmin(false);
                }}
              />
              <RolePicker
                components={props.components}
                role={selectedRole()?.name ?? ""}
                roles={props.roles}
                locale={props.locale}
                disabled={props.disabled || roles().length === 0}
                onSelect={(role) => {
                  setRole(role);
                  setConfirmAdmin(false);
                }}
              />
              <button
                type="submit"
                class="btn primary"
                disabled={props.disabled || !selectedRole() || !EMAIL.test(email().trim())}
                aria-busy={props.busy ? "true" : undefined}
              >
                <span class="btn__label">Create invite link</span>
                <Show when={props.busy}>
                  <span class="btn__spinner" aria-hidden="true" />
                </Show>
              </button>
              <Show when={roles().length === 0}>
                <p class="ocid-access__role-notice" role="status">
                  {roleText(
                    props.locale,
                    props.roles.some((role) => role.defined) ? "noUsableRoles" : "noRoles",
                  )}
                </p>
              </Show>
              <Show when={confirmAdmin() && selectedRole()?.admin}>
                <div class="ocid-access__confirmation ocid-access__role-notice">
                  <p role="note">{administratorWarning(selectedRole()?.name, props.locale)}</p>
                  <div class="ocid-access__actions">
                    <button
                      type="button"
                      class="btn btn--sm"
                      disabled={props.disabled}
                      onClick={() => setConfirmAdmin(false)}
                    >
                      {roleText(props.locale, "cancel")}
                    </button>
                    <button
                      type="button"
                      class="btn primary btn--sm"
                      disabled={props.disabled}
                      onClick={() => void submit(true)}
                    >
                      {roleText(props.locale, "adminInvite")}
                    </button>
                  </div>
                </div>
              </Show>
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
                    setRole(undefined);
                    setConfirmAdmin(false);
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
        <InviteSandboxWarning
          role={created() ? undefined : selectedRole()?.name}
          link={props.link}
        />
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
  ownerDevices: OwnerDevice[];
  onRemoveDevice: (member: Member, device: MemberDevice) => void;
  components: ControlUiHost["components"];
  roles: Role[];
  locale: string;
  onChangeRole: (member: Member, role: MemberRole, confirmedAdmin: boolean) => Promise<boolean>;
  disabled: boolean;
  nowMs: number;
  sessionTitle: (sessionKey: string) => string | undefined;
  onRemove: (member: Member) => void;
  error?: PeopleOperationError | null;
  readOnly?: boolean;
}) {
  const [confirming, setConfirming] = createSignal(false);
  const [editing, setEditing] = createSignal(false);
  const [selected, setSelected] = createSignal<MemberRole>();
  const [saved, setSaved] = createSignal(false);
  const roles = () => definedRoles(props.roles);
  const selectedRole = () =>
    roles().find((role) => role.name === selected()) ??
    roles().find((role) => role.name === props.member.role) ??
    roles()[0];
  const save = async () => {
    const role = selectedRole();
    if (!role || role.name === props.member.role || props.disabled) {
      return;
    }
    try {
      if (await props.onChangeRole(props.member, role.name, role.admin)) {
        setEditing(false);
        setSaved(true);
      }
    } catch (error) {
      if (!(error instanceof RoleClassificationChangedError)) {
        throw error;
      }
    }
  };
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
        <Show when={!props.readOnly && !latest(confirming) && !editing()}>
          <button
            type="button"
            class="btn btn--sm"
            disabled={props.disabled || roles().length === 0}
            onClick={() => {
              setSelected(undefined);
              setEditing(true);
              setSaved(false);
            }}
          >
            {roleText(props.locale, "changeRole")}
          </button>
          <button
            type="button"
            class="btn btn--sm ocid-access__remove"
            disabled={props.disabled}
            onClick={() => props.motion.update(() => setConfirming(true))}
          >
            Remove
          </button>
        </Show>
        <span class="chip">{roleName(props.member.role)}</span>
      </div>
      <Show when={props.member.roleDefined === false}>
        <p class="ocid-access__role-notice" role="status">
          <strong>{roleText(props.locale, "blocked")}: </strong>
          {roleText(props.locale, "undefinedRole", { role: props.member.role })}
        </p>
      </Show>
      <Show when={editing() && !props.readOnly}>
        <div class="ocid-access__confirmation">
          <RolePicker
            components={props.components}
            roles={props.roles}
            locale={props.locale}
            role={selectedRole()?.name ?? ""}
            disabled={props.disabled || roles().length === 0}
            onSelect={setSelected}
          />
          <Show when={selectedRole()?.admin}>
            <p role="note">{administratorWarning(selectedRole()?.name, props.locale)}</p>
          </Show>
          <div class="ocid-access__actions">
            <button
              type="button"
              class="btn btn--sm"
              disabled={props.disabled}
              onClick={() => setEditing(false)}
            >
              {roleText(props.locale, "cancel")}
            </button>
            <button
              type="button"
              class="btn primary btn--sm"
              disabled={
                props.disabled || !selectedRole() || selectedRole()?.name === props.member.role
              }
              aria-busy={props.disabled ? "true" : undefined}
              onClick={() => void save()}
            >
              {roleText(props.locale, selectedRole()?.admin ? "saveAdminRole" : "saveRole")}
            </button>
          </div>
        </div>
      </Show>
      <Show when={saved()}>
        <p class="ocid-access__role-notice" role="status">
          {roleText(props.locale, "roleChanged")}
        </p>
      </Show>
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
      <MemberDevices
        member={props.member}
        ownerDevices={props.ownerDevices}
        motion={props.motion}
        disabled={props.disabled}
        readOnly={props.readOnly}
        nowMs={props.nowMs}
        onRemove={props.onRemoveDevice}
      />
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
  components: ControlUiHost["components"];
  roles: Role[];
  onChangeRole: (member: Member, role: MemberRole, confirmedAdmin: boolean) => Promise<boolean>;
  invites: Invite[];
  ownerDevices: OwnerDevice[];
  onRemoveDevice: (member: Member, device: MemberDevice) => void;
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
        Who can open this claw. Members can approve their own additional devices. Only you can
        invite or remove people.
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
            <div class="ocid-access__hint">{countDevices(props.ownerDevices.length)}</div>
          </div>
          <span class="chip">Owner</span>
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
              <span class="chip">{roleName(invite().role)}</span>
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
                ownerDevices={props.ownerDevices}
                onRemoveDevice={props.onRemoveDevice}
                components={props.components}
                roles={props.roles}
                locale={props.locale}
                onChangeRole={props.onChangeRole}
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
