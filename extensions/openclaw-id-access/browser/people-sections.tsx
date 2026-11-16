/** @jsxImportSource @solidjs/web */
// The People sections of the Access page. Each takes plain data and callbacks, so the
// page owns all Gateway access and the sections can be restyled independently.
import type { MemberRole } from "@openclaw/openclaw-id-protocol";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createSignal, For, latest, Show } from "solid-js";
import { roleText } from "./i18n.js";
import { RoleClassificationChangedError } from "./invites.js";
import { MemberDevices } from "./member-devices.js";
import { Avatar } from "./people-avatar.js";
import type { PeopleOperationError } from "./people-error.js";
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
import { administratorWarning, definedRoles } from "./people-roles.js";
import { RolePicker } from "./role-picker.js";
import type { Invite, Member, MemberDevice, OwnerDevice, Role } from "./types.js";

export type RemovedMemberNotice = { index: number; message: string };

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
                    <Show when={invite().existingProfile}>
                      {(profile) => (
                        <p class="ocid-access__hint">
                          Will join as {profile().displayName || profile().id}
                        </p>
                      )}
                    </Show>
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
  selectedDevice?: string;
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
        <Show when={props.member.recoveryKit}>
          <span class="chip ocid-access__kit-badge">Recovery kit saved</span>
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
        selectedDevice={props.selectedDevice}
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
  selectedMember?: string;
  selectedDevice?: string;
  navigation: ControlUiHost["navigation"];
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
  const open = () =>
    props.selectedMember ? [] : props.invites.filter((invite) => invite.status === "open");
  const members = () =>
    props.members.filter(
      (member) => !props.selectedMember || member.accountId === props.selectedMember,
    );
  return (
    <section class="ocid-access__section" aria-labelledby="ocid-access-members">
      <h3 id="ocid-access-members">Members</h3>
      <Show when={props.selectedMember}>
        <a href={props.navigation.pageHref({ id: "access" })}>All members</a>
        <Show when={members().length === 0}>
          <p class="ocid-access__empty" role="status">
            This member has been removed. Their devices no longer have access.
          </p>
        </Show>
      </Show>
      <Show when={!props.selectedMember}>
        <p class="ocid-access__hint">
          Who can open this claw. Members can approve their own additional devices. Only you can
          invite or remove people.
        </p>
      </Show>
      <OperationError
        error={
          props.error?.target.startsWith("member:") &&
          !props.members.some((member) => props.error?.target === `member:${member.accountId}`)
            ? props.error
            : null
        }
      />
      <For
        each={
          props.selectedMember
            ? []
            : props.invites.filter(
                (invite) => invite.status === "approved" && invite.existingProfile?.fallbackReason,
              )
        }
        keyed={(invite) => invite.inviteId}
      >
        {(invite) => (
          <p class="ocid-access__notice" role="status">
            {invite().label}: {invite().existingProfile?.fallbackReason}
          </p>
        )}
      </For>
      <Show when={!props.selectedMember || members().length || props.notice}>
        <ul class="ocid-access__list" ref={props.motion.group()}>
          <Show when={!props.selectedMember}>
            <li class="ocid-access__row ocid-access__row--owner">
              <Avatar name="You" />
              <div class="ocid-access__person">
                <div class="ocid-access__title">You</div>
                <div class="ocid-access__hint">{countDevices(props.ownerDevices.length)}</div>
              </div>
              <span class="chip">Owner</span>
            </li>
          </Show>
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
          <For each={members()} keyed={(member) => member.accountId}>
            {(member) => (
              <>
                <Show
                  when={
                    props.notice &&
                    props.notice.index ===
                      props.members.findIndex((row) => row.accountId === member().accountId)
                  }
                >
                  <li class="ocid-access__notice" role="status">
                    {props.notice?.message}
                  </li>
                </Show>
                <MemberRow
                  motion={props.motion}
                  member={member()}
                  selectedDevice={props.selectedMember ? props.selectedDevice : undefined}
                  ownerDevices={props.ownerDevices}
                  onRemoveDevice={props.onRemoveDevice}
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
      </Show>
    </section>
  );
}
