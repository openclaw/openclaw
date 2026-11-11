/** @jsxImportSource @solidjs/web */
// The People sections of the Access page. Each takes plain data and callbacks, so the
// page owns all Gateway access and the sections can be restyled independently.
import type { MemberRole } from "@openclaw/openclaw-id-protocol";
import { createSignal, For, latest, Show } from "solid-js";
import type { CreatedInvite } from "./invites.js";
import {
  countDevices,
  formatDay,
  inviteUsed,
  memberName,
  memberPresence,
  memberRunning,
} from "./people-format.js";
import type { Invite, Member } from "./types.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Invite one person with a role ceiling (operator at most); shows the link once. */
export function InviteForm(props: {
  disabled: boolean;
  locale: string;
  onCreate: (email: string, role: MemberRole) => Promise<CreatedInvite | undefined>;
}) {
  const [email, setEmail] = createSignal("");
  const [role, setRole] = createSignal<MemberRole>("operator");
  const [created, setCreated] = createSignal<CreatedInvite | null>(null);
  const [copied, setCopied] = createSignal(false);
  const submit = async () => {
    const made = await props.onCreate(email().trim().toLowerCase(), role());
    if (made) {
      setCreated(made);
      setCopied(false);
      setEmail("");
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
      <div class="ocid-access__form">
        <input
          class="settings-input"
          type="email"
          aria-label="Email address to invite"
          placeholder="name@example.com"
          autocomplete="off"
          spellcheck="false"
          value={email()}
          onInput={(event) => setEmail(event.currentTarget.value)}
        />
        <select
          class="settings-input"
          aria-label="Role"
          aria-describedby="ocid-access-role-hint"
          value={role()}
          onChange={(event) =>
            setRole(event.currentTarget.value === "viewer" ? "viewer" : "operator")
          }
        >
          <option value="operator">Operator · chat, run tools, and use connected services</option>
          <option value="viewer">Viewer · read conversations only</option>
        </select>
        <button
          type="button"
          class="btn primary btn--sm"
          disabled={props.disabled || !EMAIL.test(email().trim())}
          onClick={() => void submit()}
        >
          Create invite link
        </button>
      </div>
      <p class="ocid-access__hint" id="ocid-access-role-hint">
        Invites cannot grant owner access. Connected services keep their own permissions.
      </p>
      <Show when={latest(created)}>
        {(made) => (
          <div class="callout info stack ocid-access__link" role="status">
            <div>
              Invite link for {made().email} · expires {formatDay(made().expiresAt, props.locale)}
            </div>
            <code class="ocid-access__url">{made().url}</code>
            <button type="button" class="btn btn--sm" onClick={() => void copy(made().url)}>
              {latest(copied) ? "Copied" : "Copy link"}
            </button>
            <p class="ocid-access__hint">
              Send this link privately. Anyone with it can request access, but only you can approve
              them.
            </p>
          </div>
        )}
      </Show>
    </section>
  );
}

/** Pending requests: who is asking, from which device, with which invite. */
export function PendingRequests(props: {
  invites: Invite[];
  /** Display fingerprint by device key, for the device each request comes from. */
  fingerprints: ReadonlyMap<string, string>;
  disabled: boolean;
  locale: string;
  onDecide: (invite: Invite, approve: boolean) => void;
}) {
  return (
    <section class="ocid-access__section" aria-labelledby="ocid-access-pending">
      <h3 id="ocid-access-pending">Waiting for you</h3>
      <Show
        when={props.invites.length > 0}
        fallback={<p class="ocid-access__empty">No one is waiting for approval.</p>}
      >
        <ul class="ocid-access__list">
          <For each={props.invites} keyed={(invite) => invite.inviteId}>
            {(invite) => {
              const pending = () => invite().pending!;
              const who = () => pending().reported.email || "OpenClaw ID account";
              return (
                <li class="ocid-access__row ocid-access__row--request">
                  <div>
                    <div class="ocid-access__title">
                      {who()} · Device details unavailable ·{" "}
                      {pending().reported.locationHint ?? "location unknown"}
                    </div>
                    <div class="ocid-access__hint">
                      {inviteUsed(invite(), props.locale)} · decide by{" "}
                      {formatDay(pending().decideBy, props.locale)}
                    </div>
                    <details class="ocid-access__details">
                      <summary>Request details</summary>
                      <p class="ocid-access__hint">
                        Device ID:{" "}
                        <code>{props.fingerprints.get(pending().devicePub) ?? "unavailable"}</code>
                      </p>
                      <p class="ocid-access__hint">
                        OpenClaw ID provided this email and approximate location. Device details are
                        unavailable.
                      </p>
                    </details>
                  </div>
                  <div class="ocid-access__actions">
                    <button
                      type="button"
                      class="btn btn--sm danger"
                      disabled={props.disabled}
                      onClick={() => props.onDecide(invite(), false)}
                    >
                      Deny
                    </button>
                    <button
                      type="button"
                      class="btn primary btn--sm"
                      disabled={props.disabled}
                      onClick={() => props.onDecide(invite(), true)}
                    >
                      Approve
                    </button>
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
  member: Member;
  disabled: boolean;
  nowMs: number;
  sessionTitle: (sessionKey: string) => string | undefined;
  onRemove: (member: Member) => void;
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
    <li class="ocid-access__row ocid-access__row--member">
      <div>
        <div class="ocid-access__title">{memberName(props.member)}</div>
        <div class="ocid-access__hint">{details()}</div>
        <Show when={latest(confirming)}>
          <p class="ocid-access__hint" role="note">
            Their devices disconnect now, and their running tasks stop. Completed work and
            conversations stay here. They need a new invite to return.
          </p>
        </Show>
      </div>
      <div class="ocid-access__actions">
        <span class="chip">{props.member.role}</span>
        <Show
          when={latest(confirming)}
          fallback={
            <button
              type="button"
              class="btn btn--sm"
              disabled={props.disabled}
              onClick={() => setConfirming(true)}
            >
              Remove
            </button>
          }
        >
          <button type="button" class="btn btn--sm" onClick={() => setConfirming(false)}>
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
        </Show>
      </div>
    </li>
  );
}

/** Members: the owner, each member with devices and activity, and open invites. */
export function Members(props: {
  members: Member[];
  invites: Invite[];
  ownerDevices: number;
  disabled: boolean;
  locale: string;
  nowMs: number;
  sessionTitle: (sessionKey: string) => string | undefined;
  onRemove: (member: Member) => void;
}) {
  const open = () => props.invites.filter((invite) => invite.status === "open");
  return (
    <section class="ocid-access__section" aria-labelledby="ocid-access-members">
      <h3 id="ocid-access-members">Members</h3>
      <p class="ocid-access__hint">
        Who can open this claw. Only you can change this, from one of your own devices.
      </p>
      <ul class="ocid-access__list">
        <li class="ocid-access__row ocid-access__row--owner">
          <div>
            <div class="ocid-access__title">You</div>
            <div class="ocid-access__hint">{countDevices(props.ownerDevices)}</div>
          </div>
          <span class="chip">owner</span>
        </li>
        <For each={props.members} keyed={(member) => member.accountId}>
          {(member) => (
            <MemberRow
              member={member()}
              disabled={props.disabled}
              nowMs={props.nowMs}
              sessionTitle={props.sessionTitle}
              onRemove={props.onRemove}
            />
          )}
        </For>
        <For each={open()} keyed={(invite) => invite.inviteId}>
          {(invite) => (
            <li class="ocid-access__row ocid-access__row--invited">
              <div>
                <div class="ocid-access__title">{invite().label}</div>
                <div class="ocid-access__hint">
                  Invite link created {formatDay(invite().createdAt, props.locale)} · expires{" "}
                  {formatDay(invite().expiresAt, props.locale)} · not accepted yet
                </div>
              </div>
              <div class="ocid-access__actions">
                <span class="chip">{invite().role}</span>
                <span class="chip">Invited</span>
              </div>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
