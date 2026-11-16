/** @jsxImportSource @solidjs/web */
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { For, Show } from "solid-js";
import { personInitials } from "./people-format.js";
import type { Member, MemberRecoveryUse } from "./types.js";

/** Gateway-owned history remains visible even when its member or browser no longer exists. */
export function RecoveryUses(props: {
  uses: MemberRecoveryUse[];
  members: Member[];
  navigation: ControlUiHost["navigation"];
  locale: string;
}) {
  return (
    <Show when={props.uses.length > 0}>
      <section class="ocid-access__section" aria-labelledby="ocid-access-recovery-uses">
        <h3 id="ocid-access-recovery-uses">Recovery kit history</h3>
        <p class="ocid-access__hint">
          Browsers added with a member's recovery kit. These records stay after a kit is replaced or
          a member or browser is removed. Dismissing an Inbox notice does not remove its record.
        </p>
        <ul class="ocid-access__list">
          <For each={props.uses.toSorted((a, b) => b.seq - a.seq)} keyed={(use) => use.seq}>
            {(use) => (
              <li class="ocid-access__row">
                <span class="ocid-access__avatar" aria-hidden="true">
                  {personInitials(use().memberName)}
                </span>
                <div class="ocid-access__person" style={{ flex: "1" }}>
                  <div class="ocid-access__title">
                    {use().memberName}
                    {props.members.some((member) => member.accountId === use().accountId)
                      ? ""
                      : " (removed)"}{" "}
                    used a recovery kit
                  </div>
                  <p class="ocid-access__hint">Browser added: {use().deviceLabel}</p>
                  <time
                    class="ocid-access__hint"
                    datetime={new Date(use().usedAt * 1000).toISOString()}
                  >
                    {new Date(use().usedAt * 1000).toLocaleString(props.locale, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                      second: "2-digit",
                      timeZoneName: "short",
                    })}
                  </time>
                  <Show
                    when={props.members.some(
                      (member) =>
                        member.accountId === use().accountId &&
                        member.peerKeys.includes(use().peerKey),
                    )}
                  >
                    <a
                      href={props.navigation.pageHref({
                        id: "access",
                        params: { member: use().accountId, device: use().peerKey },
                      })}
                    >
                      Review browser
                    </a>
                  </Show>
                </div>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}
