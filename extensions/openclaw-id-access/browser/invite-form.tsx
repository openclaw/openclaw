/** @jsxImportSource @solidjs/web */
import type { MemberRole } from "@openclaw/openclaw-id-protocol";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createSignal, For, latest, onSettled, Show } from "solid-js";
import { roleText } from "./i18n.js";
import { RoleClassificationChangedError, type CreatedInvite } from "./invites.js";
import { Avatar } from "./people-avatar.js";
import type { PeopleError } from "./people-error.js";
import { formatDay, roleName } from "./people-format.js";
import type { PeopleMotion } from "./people-motion.js";
import { OperationError } from "./people-operation-error.js";
import { administratorWarning, definedRoles, grantableRoles } from "./people-roles.js";
import { RolePicker } from "./role-picker.js";
import { SandboxRoleNotice, type SandboxSetup } from "./sandbox-role-notice.js";
import type { ExistingProfile, Role } from "./types.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Invite one person with an exact role; shows the link once. */
export function InviteForm(props: {
  sandboxSetup?: SandboxSetup;
  motion: PeopleMotion;
  components: ControlUiHost["components"];
  disabled: boolean;
  busy?: boolean;
  roles: Role[];
  locale: string;
  error?: PeopleError | null;
  existingProfiles?: ExistingProfile[];
  onCreate: (
    email: string,
    role: MemberRole,
    confirmedAdmin: boolean,
    existingProfileId?: string,
  ) => Promise<CreatedInvite | undefined>;
}) {
  const [email, setEmail] = createSignal("");
  const [existingProfileId, setExistingProfileId] = createSignal("");
  const [selected, setRole] = createSignal<MemberRole>();
  const roles = () => definedRoles(props.roles);
  const grantable = () => grantableRoles(props.roles);
  // An explicit choice stays selected if it becomes ungrantable, so it is never swapped silently.
  const selectedRole = () => roles().find((role) => role.name === selected()) ?? grantable()[0];
  const canInvite = () => selectedRole()?.sandbox?.ready !== false;
  const [confirmAdmin, setConfirmAdmin] = createSignal(false);
  const [created, setCreated] = createSignal<(CreatedInvite & { role: MemberRole }) | null>(null);
  const [copied, setCopied] = createSignal(false);
  let emailInput!: HTMLInputElement;
  let inviteAgain!: HTMLButtonElement;
  const submit = async (confirmedAdmin = false) => {
    const invitedRole = selectedRole()?.name;
    if (!invitedRole || !canInvite() || props.disabled || !EMAIL.test(email().trim())) {
      return;
    }
    let made: CreatedInvite | undefined;
    try {
      made = await props.onCreate(
        email().trim().toLowerCase(),
        invitedRole,
        confirmedAdmin,
        existingProfileId() || undefined,
      );
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
        setExistingProfileId("");
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
                if (
                  !props.disabled &&
                  canInvite() &&
                  selectedRole() &&
                  EMAIL.test(email().trim())
                ) {
                  if (selectedRole()?.admin) {
                    setConfirmAdmin(true);
                  } else {
                    void submit();
                  }
                }
              }}
            >
              <label class="ocid-access__profile-select">
                <span>
                  Existing person on this claw <span class="ocid-access__hint">(optional)</span>
                </span>
                <select
                  class="settings-input"
                  aria-label="Existing person on this claw"
                  value={existingProfileId()}
                  disabled={props.disabled}
                  onChange={(event) => setExistingProfileId(event.currentTarget.value)}
                >
                  <option value="">Create a new person</option>
                  <For each={props.existingProfiles ?? []} keyed={(profile) => profile.id}>
                    {(profile) => (
                      <option value={profile().id}>{profile().displayName || profile().id}</option>
                    )}
                  </For>
                </select>
                <span class="ocid-access__hint">
                  They join as this person after you approve. Their existing conversations stay with
                  them.
                </span>
              </label>
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
                disabled={props.disabled || grantable().length === 0}
                onSelect={(role) => {
                  setRole(role);
                  setConfirmAdmin(false);
                }}
              />
              <button
                type="submit"
                class="btn primary"
                disabled={
                  props.disabled || !selectedRole() || !canInvite() || !EMAIL.test(email().trim())
                }
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
        <Show when={!created()}>
          <SandboxRoleNotice roles={props.roles} locale={props.locale} setup={props.sandboxSetup} />
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
