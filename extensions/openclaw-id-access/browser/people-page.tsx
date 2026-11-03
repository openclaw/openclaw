/** @jsxImportSource @solidjs/web */
// The People page: invite someone, approve or deny their request, see who is
// active and what they are running, and remove members. Every change is a
// statement this browser's owner device signs and sends straight to the
// Gateway (openclawId.authority); everything shown is read from the Gateway
// (openclawId.people, which answers only an owner).
// Owner devices and the recovery kit live in the account menu, not here.
import { fingerprint, type MemberRole, type PublicKeyText } from "@openclaw/openclaw-id-protocol";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createSignal, latest, onSettled, Show, untrack } from "solid-js";
import { createInvite, decideInvite, removeMember } from "./invites.js";
import { thisOwnerDevice } from "./owner-signing.js";
import { peopleError, type PeopleError, type PeopleErrorAction } from "./people-error.js";
import { memberName, removalNote } from "./people-format.js";
import { observePeople } from "./people-refresh.js";
import { InviteForm, Members, PendingRequests } from "./people-sections.js";
import type { Invite, Link, Member, StatusResult } from "./types.js";

// Canonical device fingerprints stay available in the request's details disclosure.
async function pendingFingerprints(invites: Invite[]): Promise<ReadonlyMap<string, string>> {
  const keys = invites.flatMap((invite) => (invite.pending ? [invite.pending.devicePub] : []));
  const entries = await Promise.all(
    keys.map(async (key) => {
      try {
        // SAFETY: fingerprint rejects a malformed key, which the catch below drops.
        return [key, await fingerprint(key as PublicKeyText)] as const;
      } catch {
        return undefined;
      }
    }),
  );
  return new Map(entries.filter((entry) => entry !== undefined));
}

// The title the host shows for a session, if the session is in its roster.
function sessionTitleFrom(host: ControlUiHost) {
  return (sessionKey: string): string | undefined => {
    const key = host.sessions.normalizeKey(sessionKey);
    const row = host.sessions.rows.find((candidate) => candidate.key === key);
    return row?.derivedTitle || row?.displayName || row?.label || undefined;
  };
}

/** The People page for one Control UI host. */
export function PeoplePage(props: { host: ControlUiHost }) {
  // The host is fixed for the page's lifetime.
  const host = untrack(() => props.host);
  const [state, setState] = createSignal<StatusResult | null>(null);
  const [ownDevicePub, setOwnDevicePub] = createSignal<string | null>(null);
  const [fingerprints, setFingerprints] = createSignal<ReadonlyMap<string, string>>(new Map());
  const [nowMs, setNowMs] = createSignal(Date.now());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<PeopleError | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [readError, setReadError] = createSignal<PeopleError | null>(null);
  let observer: ReturnType<typeof observePeople> | undefined;
  let disposed = false;
  let actionInFlight = false;

  // Reads link state (the owner view when this client is an owner) and which
  // listed owner device, if any, is this browser.
  const read = async (isCurrent: () => boolean) => {
    try {
      const summary = await host.request<StatusResult>("openclawId.status", {});
      if (!isCurrent()) {
        return;
      }
      const next =
        summary.owner && summary.link.linked
          ? {
              ...summary,
              link: (await host.request<{ link: Link }>("openclawId.people", {})).link,
            }
          : summary;
      const [own, nextFingerprints] = await Promise.all([
        thisOwnerDevice(next.link).catch(() => undefined),
        pendingFingerprints(next.link.invites ?? []),
      ]);
      if (!isCurrent()) {
        return;
      }
      setOwnDevicePub(own?.devicePub ?? null);
      setFingerprints(nextFingerprints);
      setNowMs(Date.now());
      setState(next);
      setReadError(null);
    } catch (failure) {
      if (isCurrent()) {
        setReadError(peopleError(failure, "load", host.redact));
      }
    }
  };

  onSettled(() => {
    observer = observePeople(host, read);
    return () => {
      disposed = true;
      observer?.dispose();
    };
  });

  // Runs one owner action, then refreshes; failures show above the sections. The
  // action signs against the owner state read now, not the page's last read: the
  // claw's seq moves on its own (a member's device joining, another owner device),
  // and a change signed at an old seq is refused.
  const run = async <T,>(
    action: (link: Link) => Promise<T>,
    kind: PeopleErrorAction = "update",
  ): Promise<T | undefined> => {
    if (disposed || !state()?.link || actionInFlight || !host.connection.connected) {
      return undefined;
    }
    actionInFlight = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { link } = await host.request<{ link: Link }>("openclawId.people", {});
      if (disposed || !host.connection.connected || !host.connection.canAdmin) {
        return undefined;
      }
      return await action(link);
    } catch (failure) {
      if (!disposed) {
        setError(peopleError(failure, kind, host.redact));
      }
      return undefined;
    } finally {
      actionInFlight = false;
      if (!disposed) {
        setBusy(false);
        await observer?.refresh();
      }
    }
  };

  const remove = (member: Member) =>
    void run(async (link) => {
      const removal = await removeMember(host.request, link, member.accountId);
      if (!disposed) {
        setNotice(removalNote(memberName(member), removal));
      }
    });

  const canManage = () =>
    Boolean(latest(ownDevicePub)) && host.connection.canAdmin && !latest(busy);

  return (
    <section class="ocid-access">
      <header class="ocid-access__header">
        <h1>People</h1>
      </header>
      <Show when={latest(error) ?? latest(readError)} keyed>
        {(failure) => (
          <div class="callout danger ocid-access__error" role="alert">
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
      <Show when={latest(notice)}>
        {(message) => (
          <div class="callout success ocid-access__notice" role="status">
            {message()}
          </div>
        )}
      </Show>
      <Show when={latest(state)}>
        {(current) => (
          <Show
            when={current().status.state !== "off"}
            fallback={
              <p class="ocid-access__empty">
                OpenClaw ID is off. Turn it on in Settings → Labs, then sign in from the account
                menu.
              </p>
            }
          >
            <Show
              when={current().link.linked}
              fallback={
                <p class="ocid-access__empty">
                  Turn on remote access before inviting people. On the computer that runs this claw,
                  open the account menu and choose Turn on remote access.
                </p>
              }
            >
              <Show
                when={current().owner}
                fallback={
                  <p class="ocid-access__empty">
                    Only the owner can see who has access. Open this page from an approved owner
                    browser.
                  </p>
                }
              >
                <Show when={!latest(ownDevicePub)}>
                  <div class="callout info" role="note">
                    This browser can view people but cannot change access. Use an approved owner
                    browser to invite, approve, or remove people.
                  </div>
                </Show>
                <PendingRequests
                  invites={(current().link.invites ?? []).filter((i) => i.status === "pending")}
                  fingerprints={latest(fingerprints)}
                  disabled={!canManage()}
                  locale={host.locale}
                  onDecide={(invite, approve) =>
                    void run(
                      (link) => decideInvite(host.request, link, invite, approve),
                      approve ? "approve" : "update",
                    )
                  }
                />
                <Members
                  members={current().link.members ?? []}
                  invites={current().link.invites ?? []}
                  ownerDevices={current().link.ownerDevices?.length ?? 0}
                  disabled={!canManage()}
                  locale={host.locale}
                  nowMs={latest(nowMs)}
                  sessionTitle={sessionTitleFrom(host)}
                  onRemove={remove}
                />
                <InviteForm
                  disabled={!canManage()}
                  locale={host.locale}
                  onCreate={(email, role: MemberRole) =>
                    run((link) => createInvite(host.request, link, email, role))
                  }
                />
              </Show>
            </Show>
          </Show>
        )}
      </Show>
    </section>
  );
}
